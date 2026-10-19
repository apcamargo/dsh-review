/**
 * Deep-review fleet test: the pure pipeline (roster, blind projection,
 * moderator, citations, steering ledger, accounting, worker guard) and the
 * runtime (agents, tools, gate, lifecycle) over a real Cordis context with a
 * fake subagent provider scripted per label, a fake tool registry, a real
 * event bus, and a real temp git repository.
 *
 * @module @apcamargo/dsh-review/fleet
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, chmod, open, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { realSubprocess } from "./fixtures/real-subprocess.js";
import { runCommand as runProcess } from "../lib/git.js";
import { apply, inject, name } from "../lib/index.js";
import { REVIEW_RUBRIC, RUBRIC_GUIDELINES, REVIEW_SUMMARY_PROMPT, buildDeepSummaryPrompt, buildDeepReviewPrompt } from "../lib/prompts.js";
import { resolveDeepConfig, DEFAULTS, MAX_TIMER_MS, LENS_IDS } from "../lib/config.js";
import { planRoster, balancedShards, rosterScope, LOCAL_LENSES, CROSS_LENSES } from "../lib/fleet/roster.js";
import { buildReviewerPrompt, buildVerifierPrompt, REVIEWER_PERSONA } from "../lib/fleet/prompts.js";
import { planLaneRuns, projectForLane } from "../lib/fleet/blind.js";
import { validateVerificationInput, overlapHints, buildAssessment, groupsForLane } from "../lib/fleet/consolidate.js";
import { moderate, moderateGroup, classify, renderFindings } from "../lib/fleet/aggregate.js";
import { gateStance, checkEvidence, CITATION_SIZE_CAP } from "../lib/fleet/citations.js";
import { missingReportedFindings } from "../lib/fleet/gate.js";
import { createLedger } from "../lib/fleet/steering.js";
import { applicableLanes } from "../lib/fleet/lanes.js";
import { workerGuard, runAgent, mapPoolTotal, installWorkerContainment } from "../lib/fleet/agents.js";
import { listChangedFiles, parseNumstat, treeDiff, walkFiles, snapshotTree } from "../lib/fleet/changes.js";
import { simplificationAuditState } from "../lib/fleet/tools.js";
import { verifierSchema, REVIEWER_SCHEMA, LANE_OUTCOMES } from "../lib/fleet/schemas.js";

/** Real collect-mode subprocess seam over child_process, for the real git runs. */
const subprocess = realSubprocess;

/** In-memory KV table with durable-boundary validation. */
function makeTable() {
	const records = new Map();
	return {
		get: (key) => records.get(key),
		put: async (key, value) => records.set(key, structuredClone(value)),
		delete: async (key) => records.delete(key),
		update: async (key, fn) => {
			const next = fn(records.get(key) ?? { active: false });
			records.set(key, structuredClone(next));
			return structuredClone(next);
		},
	};
}

/** The fake read tools the workers are allowed; the deep tools register beside them. */
function makeToolRegistry() {
	const registry = { registered: [], registerCalls: 0, failRegisterAt: null };
	return {
		registry,
		schemas: { bash: {}, read: {}, grep: {}, glob: {} },
		get(name_) {
			return this.schemas[name_] ?? [...registry.registered].reverse().find((entry) => entry.name === name_);
		},
		register(definition) {
			registry.registerCalls = (registry.registerCalls ?? 0) + 1;
			// Test hook for a mid-begin failure: the register call whose ordinal
			// matches throws the duplicate diagnostic the real dsh-tools per-scope
			// layer names, after earlier registrations succeeded.
			if (registry.failRegisterAt === registry.registerCalls) {
				throw new Error(`tool "${definition.name}" is already registered in this scope (test hook)`);
			}
			registry.registered.push(definition);
			return () => {
				const index = registry.registered.indexOf(definition);
				if (index >= 0) registry.registered.splice(index, 1);
			};
		},
	};
}

/**
 * A fake subagent provider scripted per label, over the host's 0.2.1 seam:
 * `startActivation({ provider, label, request, signal, delivery })` returning
 * `{ childId, result, dispose }`. Reviewer labels answer with the findings the
 * test sets; verifier labels echo every `<report ref>` in their prompt with
 * the test's per-lane verdict. The provider advertises the real spawn
 * capability set (no persona, no toolFilter — the fleet applies both itself),
 * and each started child is registered in `children` so a fake `agents`
 * service can resolve it the way the fleet's containment install does.
 */
function makeProvider(options = {}) {
	const started = [];
	const children = new Map();
	const provider = {
		name: "spawn",
		capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
		inheritsParentContext: false,
		guards: [],
		restrictions: [],
		startActivation(spec) {
			const request = spec.request;
			const id = `child-${started.length + 1}`;
			const record = {
				id,
				label: spec.label,
				prompt: request.prompt[0]?.text ?? "",
				outputSchema: request.outputSchema,
				agentOptions: request.agentOptions,
				parent: request.parent,
				disposed: false,
			};
			started.push(record);
			// The in-process child the fleet resolves through the agents registry
			// to install the tool restriction and the command guard. With
			// `childTools: false` the child exposes no tools service, so every
			// worker degrades — the containment-warning surface's live shape.
			children.set(id, {
				id,
				...(options.childTools === false ? {} : {
					ctx: {
						tools: {
							restrict(filter) { provider.restrictions.push({ id, filter }); },
							guard(fn) { provider.guards.push({ id, fn }); },
						},
					},
				}),
			});
			let outcome;
			try {
				outcome = options.scripts(spec.label, request, started.length) ?? { stopReason: "completed", structured: { findings: [], sideEffects: [] } };
			} catch (error) {
				outcome = { stopReason: "error", diagnostic: error.message };
			}
			return Promise.resolve({
				childId: id,
				result: new Promise((resolve) => {
					const delay = options.delay?.(spec.label) ?? 0;
					if (delay) setTimeout(() => resolve(outcome), delay);
					else resolve(outcome);
				}),
				async dispose() {
					record.disposed = true;
				},
			});
		},
	};
	return { provider, started, children };
}

/** The quoted line the temp repository's changed file contains. */
const BUG_QUOTE = "return null; // silent recovery";

/** Default per-lane verifier verdicts, overridable per test. */
function defaultVerdicts() {
	return {
		reproducer: "reproduced",
		skeptic: "reachable",
		consistency: "inconsistent",
		provenance: "introduced",
		impact: "material",
		"fix-auditor": "sound",
	};
}

/** Reviewer findings: the correctness lens reports the bug, failure-paths a second one. */
function reviewerScript(lens) {
	if (lens === "correctness") {
		return {
			stopReason: "completed",
			structured: {
				findings: [{
					priority: "P0",
					confidence: "high",
					title: "Silent null return",
					file: "src/auth.js",
					line: 3,
					claim: "The new auth path returns null instead of failing fast.",
					scenario: "A bad token silently yields null and the caller renders an empty session.",
					evidence: [{ file: "src/auth.js", line: 3, quote: BUG_QUOTE }],
					suggestedFix: "CANARY-FIX throw an AuthError instead of returning null.",
				}],
				sideEffects: ["**This change modifies auth/permission behavior:** src/auth.js"],
			},
		};
	}
	if (lens === "failure-paths") {
		return {
			stopReason: "completed",
			structured: {
				findings: [{
					priority: "P2",
					confidence: "medium",
					title: "Swallowed parse error",
					file: "src/auth.js",
					line: 5,
					claim: "The parse fallback swallows the error.",
					scenario: "Malformed input is parsed as an empty object.",
					evidence: [{ file: "src/auth.js", line: 5, quote: "catch {}" }],
				}],
				sideEffects: [],
			},
		};
	}
	return { stopReason: "completed", structured: { findings: [], sideEffects: [] } };
}

/** The default scripts: reviewers answer per lens, verifiers echo the refs. */
function defaultScripts(options = {}) {
	const verdicts = options.verdicts ?? defaultVerdicts();
	const reviewFindings = options.reviewFindings ?? reviewerScript;
	const verifyResults = options.verifyResults ?? ((lane, refs) => refs.map((ref) => ({
		ref,
		outcome: verdicts[lane],
		notes: `${lane} notes`,
		method: lane === "reproducer" ? "executed" : undefined,
		exercisedScenario: lane === "reproducer" ? "ran the scenario" : undefined,
		reproduction: lane === "reproducer" ? "ran auth.test.js" : undefined,
		evidence: lane === "skeptic" || lane === "consistency" || lane === "provenance" ? [{ file: "src/auth.js", line: 3, quote: BUG_QUOTE }] : [],
		priority: lane === "impact" ? "P1" : undefined,
		blastRadius: lane === "impact" ? "module" : undefined,
		fixVerdict: lane === "fix-auditor" ? "sound" : undefined,
	})));
	return (label, request, started) => {
		const verifyMatch = /deep verify \[(.+?)\]/.exec(label);
		if (verifyMatch) {
			const lane = verifyMatch[1];
			const refs = [...request.prompt[0].text.matchAll(/<report ref="C(\d+)">/g)].map((match) => `C${match[1]}`);
			return { stopReason: "completed", structured: { results: verifyResults(lane, refs) } };
		}
		const reviewMatch = /^deep review: (.+?)( \[shard \d+\/\d+\])?$/.exec(label);
		if (reviewMatch) return reviewFindings(reviewMatch[1], started);
		return { stopReason: "completed", structured: { findings: [], sideEffects: [] } };
	};
}

/** One session harness: real Cordis context, fake services, one agent. */
async function makeHarness(options = {}) {
	const deep = resolveDeepConfig({
		...DEFAULTS,
		...options.deep,
		reviewerTimeoutMs: options.deep?.reviewerTimeoutMs ?? 5000,
		verifierTimeoutMs: options.deep?.verifierTimeoutMs ?? 5000,
	});
	const { provider, started, children } = makeProvider({ scripts: options.scripts ?? defaultScripts(options), childTools: options.childTools });
	const toolRegistry = makeToolRegistry();
	const commands = { registered: [], register(definition) { commands.registered.push(definition); return () => {}; } };
	const table = options.table ?? makeTable();
	const ctx = new Context();
	ctx.provide("subprocess", subprocess);
	ctx.provide("storageDomain", { async open() { return { name: "review", close: async () => {}, table: () => table }; } });
	ctx.provide("commands", commands);
	if (options.withFleet !== false) {
		ctx.provide("tools", toolRegistry);
		// The agents registry the fleet resolves workers through for its
		// containment install; the provider registers each child on start.
		ctx.provide("agents", { get: (id) => children.get(id) });
		ctx.provide("subagents", {
			getProvider: (name_) => (name_ === "spawn" ? provider : undefined),
			startActivation: (spec) => provider.startActivation(spec),
			// The live activation-capacity reference the fleet's begin reads to
			// cap the pool size (on the real service a volatile schemastery ref
			// under the TS-private `config`). Supplied only when the test sets
			// `capacity`; its absence is the unreadable-shape case (no capping).
			...(options.capacity !== undefined ? { config: { maxActiveSubagents: { get: () => options.capacity } } } : {}),
		});
	}
	const steers = [];
	const agent = {
		id: options.id ?? "session-fleet-0001",
		session: {
			header: { cwd: options.cwd },
			deriveMessages: () => options.deriveMessages?.() ?? [],
		},
		followups: [],
		followup(message) { this.followups.push(message); },
		steer(message) { steers.push(message); },
	};
	await apply(ctx, { deep });
	// Let the fleet child fiber mount (its services are present, so it settles at once).
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { ctx, agent, started, toolRegistry, steers, commands, deep, provider, table };
}

/** Invoke one registered command as the dispatching adapter would. */
async function runCommandFn(commands, agent, commandName, rawInput, signal = new AbortController().signal) {
	const definition = commands.registered.find((entry) => entry.name === commandName);
	assert.ok(definition, `command ${commandName} registered`);
	return definition.handler({ commandId: "fleet", agent, rawInput, attachments: [], signal });
}

/** Invoke one registered tool as the agent loop would. */
async function runToolFn(toolRegistry, agent, toolName, args, signal = new AbortController().signal) {
	const definition = toolRegistry.registry.registered.find((entry) => entry.name === toolName);
	assert.ok(definition, `tool ${toolName} registered`);
	return definition.execute(args, { agent, arguments: args, signal });
}

// ---------------------------------------------------------------------------
// Pure pipeline
// ---------------------------------------------------------------------------

/** The rubric split cannot drift: the guidelines part is the rubric's head. */
{
	assert.ok(REVIEW_RUBRIC.startsWith(RUBRIC_GUIDELINES));
	assert.ok(RUBRIC_GUIDELINES.length < REVIEW_RUBRIC.length);
	assert.ok(RUBRIC_GUIDELINES.includes("## Determining what to flag"));
	assert.ok(!RUBRIC_GUIDELINES.includes("## Required side-effects section"));
	console.log("rubric split: ok");
}

/** The non-deep prompt is unchanged: every target and option combination matches the snapshot. */
{
	const snapshot = (await import("./fixtures/prompt-snapshots.json", { with: { type: "json" } })).default;
	const { TARGETS, OPTIONS } = await import("./fixtures/prompt-cases.js");
	const { buildReviewPrompt } = await import("../lib/prompts.js");
	const prompts = [];
	for (const target of TARGETS) for (const options of OPTIONS) prompts.push(buildReviewPrompt(target, options));
	assert.deepEqual(prompts, snapshot.prompts);
	console.log("prompt snapshot: ok");
}

/** Roster planning: whole-change for small diffs, balanced shards for large ones. */
{
	const settings = resolveDeepConfig({});
	const small = planRoster({ files: [{ path: "a.js", lines: 100 }], available: true, lenses: [...DEFAULTS.lenses], settings });
	assert.equal(small.length, 7);
	// The simplification lens is a fourth file-local lens: it slots after
	// security and before the cross-cutting lenses.
	assert.deepEqual(small.map((entry) => entry.lens), ["correctness", "failure-paths", "security", "simplification", "contracts", "consistency", "propagation"]);
	assert.ok(small.every((entry) => entry.shard === null));

	const files = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.js`, lines: 400 }));
	const large = planRoster({ files, available: true, lenses: [...DEFAULTS.lenses], settings });
	const shards = large.find((entry) => entry.shard).shard.count;
	// maxReviewers 15 keeps three shards per local lens with the fourth lens
	// present: bySlots = floor((15 - 3) / 4) = 3, roster = 4 * 3 + 3.
	assert.equal(shards, 3);
	assert.equal(large.length, 4 * shards + 3);
	const balanced = balancedShards(files, shards);
	const weights = balanced.map((shard) => shard.reduce((sum, file) => sum + file.lines, 0));
	assert.ok(Math.max(...weights) - Math.min(...weights) <= 400, `shards balanced: ${weights.join(", ")}`);
	assert.deepEqual(
		balanced.flat().map((f) => f.path).sort(),
		[...files].map((f) => f.path).sort(),
	);

	// No listing: one shard for the whole change.
	const custom = planRoster({ files: [], available: false, lenses: [...DEFAULTS.lenses], settings });
	assert.equal(custom.length, 7);
	assert.match(rosterScope(custom[0]), /whole change/);

	// A large diff with a tight reviewer cap shrinks the shard count.
	const capped = planRoster({ files, available: true, lenses: [...DEFAULTS.lenses], settings: resolveDeepConfig({ maxReviewers: 7 }) });
	assert.ok(capped.length <= 7);
	console.log("roster: ok");
}

/** Reviewer prompt file-list truncation: a large entry lists heaviest-first
 * with a count line, a small entry keeps its order and gains no count line,
 * the empty branch is byte-identical, and the shared entry.files reference is
 * never mutated (planRoster pushes the same array into every cross entry and
 * run.roster persists across re-calls). rosterScope still names the full
 * count from the full list. */
{
	const bigFiles = Array.from({ length: 500 }, (_, i) => ({ path: `src/f${String(i).padStart(3, "0")}.js`, lines: i === 499 ? 900 : 10 }));
	const before = structuredClone(bigFiles);
	const prompt = buildReviewerPrompt({ entry: { id: "R1", lens: "correctness", shard: null, files: bigFiles }, modePrompt: "focus", targetLabel: "label", promptOptions: {}, steering: null, aggressive: false });
	assert.ok(prompt.indexOf("src/f499.js") < prompt.indexOf("src/f000.js"), "the heaviest file is listed first");
	assert.match(prompt, /\.\.\. and 350 more files/, "the count line names the rest");
	const shownCount = (prompt.match(/\(~\d+ lines\)/g) ?? []).length;
	assert.ok(shownCount <= 150, `the shown block is capped: ${shownCount}`);
	assert.deepEqual(bigFiles, before, "entry.files is never mutated");
	const small = buildReviewerPrompt({ entry: { id: "R1", lens: "correctness", shard: null, files: [{ path: "a.js", lines: 10 }, { path: "b.js", lines: 20 }] }, modePrompt: "focus", targetLabel: "label", promptOptions: {}, steering: null, aggressive: false });
	assert.ok(small.indexOf("a.js") < small.indexOf("b.js") && small.includes("a.js (~10 lines)") && small.includes("b.js (~20 lines)"), "a small entry keeps its order");
	assert.ok(!small.includes("more files"), "no count line when uncut");
	const empty = buildReviewerPrompt({ entry: { id: "R1", lens: "correctness", shard: null, files: [] }, modePrompt: "focus", targetLabel: "label", promptOptions: {}, steering: null, aggressive: false });
	assert.ok(empty.includes("(no file listing; follow the focus text)"), "the empty branch is unchanged");
	assert.equal(rosterScope({ shard: null, files: bigFiles }), "whole change (500 files)", "rosterScope still names the full count");
	console.log("file list cap: ok");
}

/** The worker output contract names the structured_output tool call — the
 * seam's capture mechanism — and never asks for a text reply: a worker that
 * "replies" with JSON in text ends its turn unstructured and its whole review
 * is re-run (observed live: an 11-minute shard review discarded). */
{
	const prompt = buildReviewerPrompt({ entry: { id: "R1", lens: "correctness", shard: null, files: [] }, modePrompt: "focus", targetLabel: "label", promptOptions: {}, steering: null, aggressive: false });
	assert.match(prompt, /`structured_output` tool exactly once/);
	assert.doesNotMatch(prompt, /Reply with one JSON object/);
	const lane = applicableLanes(resolveDeepConfig({ ...DEFAULTS }), true)[0];
	const verifierPrompt = buildVerifierPrompt({ lane, reports: '<report ref="C1">claim</report>', targetDescription: "target", modeFocus: "focus", promptOptions: {}, steering: null, chunkIndex: 1, chunkCount: 1 });
	assert.match(verifierPrompt, /`structured_output` tool exactly once/);
	assert.doesNotMatch(verifierPrompt, /Reply with one JSON object/);
	console.log("worker output contract: ok");
}

/** Overlap hints: same file, lines within 3 cluster; different files do not. */
{
	const hints = overlapHints(new Map([
		["R1.1", { file: "a.js", line: 10 }],
		["R2.3", { file: "a.js", line: 12 }],
		["R3.1", { file: "b.js", line: 10 }],
		["R4.2", { file: "a.js", line: 40 }],
	]));
	assert.deepEqual(hints, [["R1.1", "R2.3"]]);
	console.log("overlap hints: ok");
}

/** Accounting: every raw finding id must be grouped or dropped, with a reason. */
{
	const raw = new Map([
		["R1.1", { file: "a.js", line: 1, claim: "x", scenario: "s", suggestedFix: undefined, priority: "P1" }],
		["R1.2", { file: "a.js", line: 5, claim: "y", scenario: "t", suggestedFix: "f", priority: "P2" }],
	]);
	const settings = resolveDeepConfig({});
	const lanes = applicableLanes(settings, true);

	const ok = validateVerificationInput({ groups: [{ primary: "R1.1" }], dropped: [{ id: "R1.2", reason: "style-only" }] }, raw, settings, lanes, true);
	assert.equal(ok.ok, true);
	assert.equal(ok.assessments.length, 1);
	assert.equal(ok.assessments[0].groupId, "V1");
	// Planning matches tools.js: the fix-auditor runs only over groups that
	// propose a fix (the assessment has none), so one run per remaining lane.
	assert.equal(ok.plannedRuns, 5);

	// The fix-auditor's hasFixes filter closes the spurious cap rejection: 30
	// fixless groups + chunkSize 1 run 22 units (30 fix-auditor units planned
	// under the old margin would have rejected a valid consolidation).
	const fixless = new Map(Array.from({ length: 30 }, (_, i) => [`R${i}.1`, { file: "a.js", line: i, claim: "x", scenario: "s", suggestedFix: undefined, priority: "P1" }]));
	const fixlessSettings = resolveDeepConfig({ lanes: { "fix-auditor": { chunkSize: 1 } } });
	const accepted = validateVerificationInput({ groups: [...fixless.keys()].map((id) => ({ primary: id })), dropped: [] }, fixless, fixlessSettings, applicableLanes(fixlessSettings, true), true);
	assert.equal(accepted.ok, true);
	assert.equal(accepted.plannedRuns, 22);

	for (const [input, many, why] of [
		[{ groups: [{ primary: "R9.9" }], dropped: [] }, raw, /unknown finding id/],
		[{ groups: [{ primary: "R1.1" }], dropped: [] }, raw, /not accounted for/],
		[{ groups: [{ primary: "R1.1" }, { primary: "R1.1" }], dropped: [] }, raw, /more than one group/],
		[{ groups: [{ primary: "R1.1" }], dropped: [{ id: "R1.2" }] }, raw, /non-empty/],
		[{ groups: [{ primary: "R1.1" }], dropped: [{ id: "R1.2", reason: "x" }] }, new Map([...raw, ["R9.9", { file: "a.js", line: 9, claim: "z", scenario: "u", suggestedFix: undefined, priority: "P1" }]]), /not accounted for/],
	]) {
		const result = validateVerificationInput(input, many, settings, lanes, true);
		assert.match(result.error ?? "", why);
	}

	// Over the verification cap.
	const many = new Map(Array.from({ length: 31 }, (_, i) => [`R${i}.9`, { file: "a.js", line: i, claim: "x", scenario: "s", suggestedFix: undefined, priority: "P1" }]));
	const over = validateVerificationInput({ groups: [...many.keys()].map((id) => ({ primary: id })), dropped: [] }, many, settings, lanes, true);
	assert.match(over.error, /exceed the maximum/);

	// Provenance is diff-only: fewer verifier runs planned for folder targets.
	const withDiff = validateVerificationInput({ groups: [{ primary: "R1.1" }], dropped: [{ id: "R1.2", reason: "x" }] }, raw, settings, lanes, true);
	const withoutDiff = validateVerificationInput({ groups: [{ primary: "R1.1" }], dropped: [{ id: "R1.2", reason: "x" }] }, raw, settings, lanes, false);
	assert.ok(withoutDiff.plannedRuns < withDiff.plannedRuns);
	console.log("accounting: ok");
}

/** The moderator table: outcomes, corroboration, priority and fix merges. */
{
	const assessment = () => buildAssessment("V1", ["R1.1"], new Map([["R1.1", { file: "a.js", line: 3, claim: "bug", scenario: "s", suggestedFix: "do this", priority: "P0" }]]));
	const cited = { evidence: [{ file: "a.js", line: 3, quote: "return null;" }] };
	const reproducer = { outcome: "reproduced", method: "executed", exercisedScenario: "ran", notes: "ran", evidence: [] };
	const skepticPos = { outcome: "reachable", notes: "traced", citationNote: "1/1 citations verified", evidence: cited.evidence };
	const skepticNeg = { outcome: "unreachable", notes: "guarded", citationNote: "1/1 citations verified", evidence: cited.evidence };
	const reproNeg = { outcome: "not-reproduced", method: "executed", exercisedScenario: "ran", notes: "ran it", evidence: [] };

	const mod = (rows) => moderate({ assessments: [assessment()], hasDiff: true, laneResults: new Map([["V1", rows]]) })[0];

	assert.equal(mod({ reproducer: reproNeg, skeptic: skepticNeg }).outcome, "refuted");
	// One negative alone never refutes: with a positive it is contested.
	assert.equal(mod({ reproducer: reproNeg, skeptic: skepticPos }).outcome, "contested");
	// One negative plus the consistency lane proving the change follows the pattern refutes.
	assert.equal(mod({ reproducer: reproNeg, skeptic: skepticNeg, consistency: { outcome: "consistent", notes: "matches", citationNote: "1/1 citations verified", evidence: [{ file: "p/b.js", line: 12, quote: "return null;" }] } }).outcome, "refuted");
	// Both positives confirm; strength labels both lanes.
	const confirmed = mod({ reproducer, skeptic: skepticPos });
	assert.equal(confirmed.outcome, "confirmed");
	assert.match(confirmed.strength, /reproduced and traced/);
	// A failed gating lane leaves the finding unverified, never confirmed.
	assert.equal(mod({ reproducer: "failed", skeptic: skepticPos }).outcome, "unverified");
	assert.equal(mod({ reproducer, skeptic: "unassessed" }).outcome, "unverified");
	// Provenance dismisses pre-existing findings on diff targets.
	const preExisting = mod({ reproducer, skeptic: skepticPos, provenance: { outcome: "pre-existing", notes: "same defect before", citationNote: "1/1 citations verified", evidence: cited.evidence } });
	assert.equal(preExisting.outcome, "refuted");
	assert.match(preExisting.reasons[0], /pre-existing/);
	// No positives and no negatives: inconclusive.
	assert.equal(mod({ reproducer: { outcome: "untestable", method: "none", notes: "", evidence: [] }, skeptic: { outcome: "unclear", notes: "", evidence: [] } }).outcome, "inconclusive");

	// The impact lane's own priority wins and is shown; negligible caps at P3.
	const priority = mod({ reproducer, skeptic: skepticPos, impact: { outcome: "material", priority: "P2", blastRadius: "module", notes: "", evidence: [] } });
	assert.equal(priority.priority, "P2");
	assert.equal(priority.priorityWas, "P0");
	const negligible = mod({ reproducer, skeptic: skepticPos, impact: { outcome: "negligible", priority: "P1", blastRadius: "local", notes: "", evidence: [] } });
	assert.equal(negligible.priority, "P3");
	// A failed impact lane falls back to the reviewers' highest priority.
	const fallback = mod({ reproducer, skeptic: skepticPos, impact: "failed" });
	assert.equal(fallback.priority, "P0");

	// The fix-auditor decides what the report shows.
	const flawedRevised = moderateGroup(assessment(), { reproducer, skeptic: skepticPos, "fix-auditor": { outcome: "flawed", fixVerdict: "flawed", problems: ["masks the error"], revisedSuggestion: "throw with context", evidence: [] } }, true);
	assert.equal(flawedRevised.fix, "throw with context");
	assert.match(flawedRevised.fixNote, /masks the error/);
	const flawedNoRevision = moderateGroup(assessment(), { reproducer, skeptic: skepticPos, "fix-auditor": { outcome: "flawed", fixVerdict: "flawed", problems: ["masks the error"], evidence: [] } }, true);
	assert.equal(flawedNoRevision.fix, undefined);
	assert.match(flawedNoRevision.fixNote, /fix needs design/);
	assert.match(moderateGroup(assessment(), { reproducer, skeptic: skepticPos, "fix-auditor": "failed" }, true).fixNote, /unaudited/);

	// The consistency lane's cited verdict is a note, never a decision; the
	// cited precedents render with it — one for a stated-convention citation,
	// the recurrence list (capped) for an inferred one.
	const consistencyNote = moderateGroup(assessment(), { reproducer, skeptic: skepticPos, consistency: { outcome: "inconsistent", notes: "", citationNote: "1/1 citations verified", evidence: [{ file: "p/b.js", line: 12, quote: "x" }] } }, true);
	assert.match(consistencyNote.consistencyNote, /departs from a codebase convention \(precedent: `p\/b\.js:12`\)/);
	const recurrenceNote = moderateGroup(assessment(), { reproducer, skeptic: skepticPos, consistency: { outcome: "consistent", notes: "", citationNote: "2/2 citations verified", evidence: [{ file: "p/b.js", line: 12, quote: "x" }, { file: "p/c.js", line: 3, quote: "y" }, { file: "p/d.js", line: 4, quote: "z" }, { file: "p/e.js", line: 5, quote: "w" }] } }, true);
	assert.match(recurrenceNote.consistencyNote, /matches a codebase convention \(precedents: `p\/b\.js:12`, `p\/c\.js:3`, `p\/d\.js:4` \+1 more\)/);

	// The final filter: default reports confirmed only; aggressive adds the unproven.
	const contested = mod({ reproducer: reproNeg, skeptic: skepticPos });
	const refuted = mod({ reproducer: reproNeg, skeptic: skepticNeg });
	assert.deepEqual(classify([confirmed, contested, refuted], false), { reportable: [confirmed], withheld: [contested], dismissed: [refuted], simplifications: [] });
	const aggressive = classify([confirmed, contested, refuted], true);
	assert.deepEqual(aggressive.reportable, [confirmed, contested]);
	assert.deepEqual(aggressive.dismissed, [refuted]);

	// Rendering: the report carries everything the orchestrator must copy.
	const full = mod({ reproducer, skeptic: skepticPos, impact: { outcome: "material", priority: "P2", blastRadius: "module", notes: "", evidence: [] }, "fix-auditor": { outcome: "sound", fixVerdict: "sound", evidence: [] } });
	const markdown = renderFindings({ ...classify([full], false), tree: { checked: true, changed: ["x.js"] }, coverage: "6/6 reviewers, 1 changed files", steering: "Steering received: #1" });
	assert.match(markdown, /## Findings \(verified by independent adversarial lanes\)/);
	assert.match(markdown, /\[P2\].*reproduced and traced/);
	assert.match(markdown, /Priority assessed by the impact lane; the reviewers said P0\./);
	assert.match(markdown, /Suggested fix: do this/);
	assert.match(markdown, /Fix audit: audited sound\./);
	assert.match(markdown, /⚠️ The working tree changed during review/);
	assert.match(markdown, /Steering received: #1/);
	assert.match(markdown, /Lane verdicts: reproducer: reproduced · skeptic: reachable \(1\/1 citations verified\)/);
	// Every outcome renders its own section: withheld, dismissed, dropped.
	const markdownAll = renderFindings({ ...classify([priority, contested, refuted], false), tree: { checked: false, changed: [] }, coverage: "6/6 reviewers", steering: null, dropped: [{ id: "R2.1", reason: "style-only" }] });
	assert.match(markdownAll, /## Withheld \(raised but unverified\)/);
	assert.match(markdownAll, /## Dismissed by the lanes/);
	assert.match(markdownAll, /## Dropped during consolidation/);

	// A never-ran gating lane (a failed verifier unit leaves the row undefined)
	// renders with the lane named, not an empty list.
	const neverRan = mod({ reproducer: { outcome: "reproduced", method: "executed", exercisedScenario: "ran", notes: "ran", evidence: [] } });
	assert.equal(neverRan.outcome, "unverified");
	assert.equal(neverRan.reasons[0], "skeptic lane failed or did not assess this finding");
	const bothNeverRan = mod({});
	assert.equal(bothNeverRan.reasons[0], "reproducer and skeptic lanes failed or did not assess this finding");
	// The provenance filter outranks gateFailed: a citation-verified
	// pre-existing/intentional stance dismisses the finding even when a gating
	// lane failed or never assessed it. A future reorder cannot pass silently.
	const filterDismisses = mod({ reproducer: "failed", skeptic: "failed", provenance: { outcome: "pre-existing", notes: "same defect before", citationNote: "1/1 citations verified", evidence: cited.evidence } });
	assert.equal(filterDismisses.outcome, "refuted");
	assert.match(filterDismisses.reasons[0], /pre-existing/);
	assert.equal(mod({ provenance: { outcome: "intentional", notes: "explicit decision", citationNote: "1/1 citations verified", evidence: cited.evidence } }).outcome, "refuted");
	// Empty normalized notes reach the fallback text (`||`, not `??`).
	const emptyNotes = mod({
		reproducer: { outcome: "not-reproduced", method: "executed", exercisedScenario: "ran", notes: "", evidence: [] },
		skeptic: { outcome: "unreachable", notes: "", citationNote: "1/1 citations verified", evidence: cited.evidence },
	});
	assert.deepEqual(emptyNotes.reasons, ["reproducer: not reproduced", "skeptic: unreachable"]);
	console.log("moderator: ok");
}

/** The simplification pipeline: moderation table, kind routing, caps,
 * rendering, and normalization guards. */
{
	const settings = resolveDeepConfig({});
	const lanes = applicableLanes(settings, true);
	// A simplification group's raw findings carry kind "simplification"; the
	// suggestedFix IS the proposal (hasFixes true), the scenario is the
	// behavior-preservation argument.
	const simplRaw = new Map([["R4.1", {
		id: "R4.1", kind: "simplification", lens: "simplification", file: "src/x.js", line: 7,
		claim: "Collapse the two nested conditionals into a guard clause.",
		scenario: "Both branches return early on the same condition; callers are traced and the else path is unreachable.",
		suggestedFix: "Replace the nested if/else with a single early return.", priority: "P3",
	}]]);
	const simplAssessment = buildAssessment("V1", ["R4.1"], simplRaw);
	assert.equal(simplAssessment.kind, "simplification");
	assert.equal(simplAssessment.hasFixes, true);
	const defectAssessment = buildAssessment("V2", ["R1.1"], new Map([["R1.1", { file: "a.js", line: 3, claim: "bug", scenario: "s", suggestedFix: "do this", priority: "P0" }]]));
	assert.equal(defectAssessment.kind, "defect");

	// groupsForLane: defect lanes never see simplification groups; the
	// simplifier never sees defect groups; provenance filters by hasDiff only.
	for (const laneId of ["reproducer", "skeptic", "consistency", "impact", "fix-auditor"]) {
		const lane = lanes.find((entry) => entry.id === laneId);
		assert.deepEqual(groupsForLane(lane, [simplAssessment, defectAssessment], true).map((group) => group.groupId), ["V2"], `${laneId} routes to defect groups only`);
	}
	const simplifier = lanes.find((entry) => entry.id === "simplifier");
	assert.deepEqual(groupsForLane(simplifier, [simplAssessment, defectAssessment], true).map((group) => group.groupId), ["V1"]);
	assert.deepEqual(groupsForLane(simplifier, [defectAssessment], true), [], "no simplification groups -> no simplifier runs");
	const provenance = lanes.find((entry) => entry.id === "provenance");
	assert.deepEqual(groupsForLane(provenance, [simplAssessment, defectAssessment], true).length, 2, "provenance filters both kinds");
	assert.deepEqual(groupsForLane(provenance, [simplAssessment, defectAssessment], false), [], "provenance is diff-only");
	assert.throws(() => groupsForLane({ id: "nonsense" }, [simplAssessment], true), /unknown verifier lane/);

	// plannedRuns mirror === actual unit planning on a mixed consolidation.
	const mixed = [defectAssessment, simplAssessment];
	let mirror = 0;
	for (const lane of lanes) {
		const size = settings.lanes[lane.id]?.chunkSize ?? lane.chunkSize;
		const count = groupsForLane(lane, mixed, true).length;
		if (count > 0) mirror += Math.ceil(count / size);
	}
	assert.equal(mirror, 7, "1 defect group with a fix (6 lanes) + 1 simplification group (simplifier only)");

	// The moderation table for simplification groups.
	const simplModeration = (rows) => moderate({ assessments: [simplAssessment], hasDiff: true, laneResults: new Map([["V1", rows]]) })[0];
	const citedSimplifier = { outcome: "simpler", notes: "traced both callers", citationNote: "1/1 citations verified", evidence: [{ file: "src/x.js", line: 7, quote: "if (a) { if (b) return 1; }" }] };
	const confirmedSimpl = simplModeration({ simplifier: citedSimplifier });
	assert.equal(confirmedSimpl.outcome, "confirmed");
	assert.equal(confirmedSimpl.kind, "simplification");
	assert.match(confirmedSimpl.strength, /single-lane audit: no behavior change found/);
	assert.equal(confirmedSimpl.fix, "Replace the nested if/else with a single early return.");
	assert.match(confirmedSimpl.fixNote, /audited by the simplifier lane/);
	assert.doesNotMatch(confirmedSimpl.fixNote, /not audited/);
	assert.deepEqual(confirmedSimpl.laneRows, ["simplifier: simpler (1/1 citations verified)", "provenance: not run"], "only the routed lanes render");
	assert.equal(simplModeration({ simplifier: { ...citedSimplifier, outcome: "behavior-change" } }).outcome, "refuted");
	assert.match(simplModeration({ simplifier: { ...citedSimplifier, outcome: "behavior-change" } }).reasons[0], /simplifier:/);
	assert.equal(simplModeration({ simplifier: { ...citedSimplifier, outcome: "not-simpler" } }).outcome, "refuted");
	assert.equal(simplModeration({ simplifier: { ...citedSimplifier, outcome: "unclear" } }).outcome, "inconclusive");
	assert.equal(simplModeration({}).outcome, "unverified");
	assert.equal(simplModeration({ simplifier: "failed" }).outcome, "unverified");
	const dismissedSimpl = simplModeration({ simplifier: citedSimplifier, provenance: { outcome: "pre-existing", notes: "the nesting predates the change", citationNote: "1/1 citations verified", evidence: [{ file: "src/x.js", line: 7, quote: "if (a) { if (b) return 1; }" }] } });
	assert.equal(dismissedSimpl.outcome, "refuted");
	assert.match(dismissedSimpl.reasons[0], /pre-existing/);
	const noDiffSimpl = moderate({ assessments: [simplAssessment], hasDiff: false, laneResults: new Map([["V1", { simplifier: citedSimplifier }]]) })[0];
	assert.deepEqual(noDiffSimpl.laneRows, ["simplifier: simpler (1/1 citations verified)"], "no provenance row without a diff");
	assert.equal(noDiffSimpl.outcome, "confirmed", "provenance dismissal cannot fire without the lane");

	// The defect moderation path is unchanged: the simplifier row never leaks in.
	const defectRows = { reproducer: { outcome: "reproduced", method: "executed", exercisedScenario: "ran", notes: "ran", evidence: [] }, skeptic: { outcome: "reachable", notes: "traced", citationNote: "1/1 citations verified", evidence: [] } };
	const defectModerated = moderate({ assessments: [defectAssessment], hasDiff: true, laneResults: new Map([["V2", defectRows]]) })[0];
	assert.ok(defectModerated.laneRows.every((row) => !row.startsWith("simplifier")), "defect findings carry no simplifier row");
	assert.equal(defectModerated.laneRows.length, 6);

	// classify routes kind-first: a confirmed simplification never lands in the
	// defect findings, and an unverified one never lands in the defect
	// suspicions (default or aggressive).
	const confirmedFinding = { kind: "simplification", outcome: "confirmed", fix: "Replace the nested if/else with a single early return.", fixNote: "audited by the simplifier lane (1/1 citations verified)", claims: [{ file: "src/x.js", line: 7, claim: "collapse the conditionals" }], reviewerClaims: ["collapse the conditionals"], reasons: [], laneRows: [] };
	const unverifiedFinding = { kind: "simplification", outcome: "unverified", claims: [{ file: "src/x.js", line: 9, claim: "inline the helper" }], reviewerClaims: ["inline the helper"], reasons: ["simplifier lane failed or did not assess this finding"], laneRows: [] };
	const defectConfirmed = { kind: "defect", outcome: "confirmed", claims: [{ file: "a.js", line: 3, claim: "bug" }], reviewerClaims: ["bug"], reasons: [], laneRows: [] };
	const defectContested = { ...defectConfirmed, outcome: "contested" };
	const defaultSplit = classify([confirmedFinding, unverifiedFinding, defectConfirmed, defectContested], false);
	assert.deepEqual(defaultSplit.reportable, [defectConfirmed]);
	assert.deepEqual(defaultSplit.withheld, [defectContested], "unverified simplifications never enter the defect Withheld list");
	assert.deepEqual(defaultSplit.simplifications, [confirmedFinding, unverifiedFinding]);
	const aggressiveSplit = classify([confirmedFinding, unverifiedFinding, defectConfirmed, defectContested], true);
	assert.deepEqual(aggressiveSplit.reportable, [defectConfirmed, defectContested], "unverified simplifications stay out of the defect reportable list even under --aggressive");
	assert.deepEqual(aggressiveSplit.simplifications, [confirmedFinding, unverifiedFinding]);

	// Rendering: the section always renders; items carry the title (fidelity
	// probes it); the unaudited render as a count line by default and as
	// labeled items under --aggressive; dismissed one-liners name the kind.
	const findingTitle = confirmedFinding.claims[0].claim;
	const renderedDefault = renderFindings({ ...defaultSplit, tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.ok(renderedDefault.includes("## Simplification Opportunities (Non-Blocking)"));
	assert.ok(renderedDefault.includes(findingTitle), "the confirmed item renders titleOf(finding)");
	assert.ok(renderedDefault.includes(`${findingTitle}. Proposed:`), "a title without terminal punctuation keeps the sentence period");
	// A title that already ends with terminal punctuation gains no second one
	// (claims are reviewer text and commonly end with a period).
	const periodClaim = "The helper wraps a single call site and adds indirection only.";
	const renderedPeriod = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [{ ...confirmedFinding, claims: [{ file: "src/x.js", line: 7, claim: periodClaim }] }], tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.ok(renderedPeriod.includes(`${periodClaim} Proposed:`), "a title's own period is not doubled");
	assert.doesNotMatch(renderedPeriod, /\.\./);
	assert.match(renderedDefault, /Proposed: Replace the nested/);
	assert.match(renderedDefault, /1 raised simplification was not audited/);
	assert.doesNotMatch(renderedDefault, /unaudited — do not apply/);
	const renderedAggressive = renderFindings({ ...aggressiveSplit, aggressive: true, tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.match(renderedAggressive, /unaudited — do not apply without verifying behavior with tests/);
	const renderedNone = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.match(renderedNone, /## Simplification Opportunities \(Non-Blocking\)\n[^\n]+\n- \(none\)/);
	// A lens pinned out of deep.lenses must disclose that the audit did not
	// happen, not print "- (none)" over a description that asserts it ran.
	const renderedPinned = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "not-configured" }, tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.match(renderedPinned, /## Simplification Opportunities \(Non-Blocking\)/);
	assert.doesNotMatch(renderedPinned, /- \(none\)/);
	assert.match(renderedPinned, /- \(not evaluated — the simplification lens is not in deep\.lenses; add it to enable this audit\)/);
	// An omitted simplifications bucket (no caller does this today) must still
	// honor the always-rendered contract: it renders "- (none)", and the audit
	// state alone decides the "(not evaluated …)" line.
	const renderedOmitted = renderFindings({ reportable: [], withheld: [], dismissed: [], tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.match(renderedOmitted, /## Simplification Opportunities \(Non-Blocking\)\n[^\n]+\n- \(none\)/);
	const renderedOmittedPinned = renderFindings({ reportable: [], withheld: [], dismissed: [], simplificationAudit: { state: "not-configured" }, tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.match(renderedOmittedPinned, /- \(not evaluated — the simplification lens is not in deep\.lenses; add it to enable this audit\)/);
	const renderedDismissed = renderFindings({ reportable: [], withheld: [], dismissed: [{ kind: "simplification", outcome: "refuted", claims: [{ file: "src/x.js", line: 7, claim: "collapse the conditionals" }], reviewerClaims: [], reasons: ["pre-existing (1/1 citations verified)"], laneRows: [] }], simplifications: [], tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.match(renderedDismissed, /collapse the conditionals \(simplification\) at `src\/x\.js:7`/);
	// No render cap: every confirmed item renders, because the fidelity gate
	// requires the orchestrator's verbatim copy to contain every confirmed
	// title — a truncated section would manufacture a steer no copy can
	// satisfy. (The flood bound is the consolidation kind cap.)
	const twelve = Array.from({ length: 12 }, (_, i) => ({ kind: "simplification", outcome: "confirmed", claims: [{ file: `f${i}.js`, line: 1, claim: `simplify ${i}` }], reviewerClaims: [`simplify ${i}`], reasons: [], laneRows: [], fix: "do less" }));
	const renderedCapped = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: twelve, tree: { checked: false, changed: [] }, coverage: "7/7 reviewers", steering: null, dropped: [] });
	assert.equal((renderedCapped.match(/simplify \d+/g) ?? []).length, 12, "every confirmed item renders");
	assert.doesNotMatch(renderedCapped, /simplifications omitted/);
	const fidelityOverTwelve = missingReportedFindings({ verify: { state: "complete", classified: { reportable: [], withheld: [], dismissed: [], simplifications: twelve } }, agent: { session: { deriveMessages: () => [{ role: "assistant", content: [{ type: "text", text: renderedCapped }] }] } } });
	assert.deepEqual(fidelityOverTwelve, [], "a faithful verbatim copy of a 12-item section passes the fidelity gate");

	// The runtime audit state (tools.js derives it from the scan roster) drives
	// the section: "- (none)" only when the audit ran; every degraded state
	// discloses itself, with items present or not; and the asserting intro
	// renders only when it is provably true (audit ran, every item confirmed).
	const assertIntro = (rendered, asserted) => assert.equal(rendered.includes("Behavior-preserving cleanups the simplifier lane audited."), asserted, `intro asserts the audit: ${asserted}`);
	const auditedItem = { kind: "simplification", outcome: "confirmed", claims: [{ file: "src/x.js", line: 7, claim: "collapse the conditionals" }], reviewerClaims: ["collapse the conditionals"], reasons: [], laneRows: [], fix: "guard clause", strength: "single-lane audit: no behavior change found", fixNote: "audited by the simplifier lane" };
	const renderedRanEmpty = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "ran" }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assertIntro(renderedRanEmpty, false);
	assert.match(renderedRanEmpty, /\n- \(none\)\n/);
	const renderedRanItems = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [auditedItem], simplificationAudit: { state: "ran" }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assertIntro(renderedRanItems, true);
	assert.doesNotMatch(renderedRanItems, /\(not evaluated/);
	const renderedCutEmpty = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "cut-by-cap" }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedCutEmpty, /- \(not evaluated — the simplification lens was cut by the reviewer cap \(deep\.maxReviewers\); raise the cap to enable this audit\)/);
	assertIntro(renderedCutEmpty, false);
	const renderedFailedEmpty = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "failed", ids: ["R4"] }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedFailedEmpty, /- \(not evaluated — the simplification reviewer failed \(R4\); the audit did not run\. Re-run the review to retry it\)/);
	assert.doesNotMatch(renderedFailedEmpty, /- \(none\)/);
	const renderedFailedMulti = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "failed", ids: ["R4", "R8"] }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedFailedMulti, /the simplification reviewers failed \(R4, R8\)/);
	// The mixed zero-succeeded roster: the pending reviewer is named by its
	// real state, never blamed for a failure it did not have.
	const renderedFailedMixed = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "failed", ids: ["R4", "R8"], pendingIds: ["R8"] }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedFailedMixed, /- \(not evaluated — the simplification reviewer failed \(R4\) and R8 was still pending when verification ran; the audit did not run\. Re-run the review to retry it\)/);
	const renderedFailedMixedMulti = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "failed", ids: ["R4", "R5", "R8", "R9"], pendingIds: ["R8", "R9"] }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedFailedMixedMulti, /the simplification reviewers failed \(R4, R5\) and R8, R9 were still pending when verification ran/);
	assert.doesNotMatch(renderedFailedMixedMulti, /failed \(R4, R5, R8/);
	const renderedPendingMulti = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [], simplificationAudit: { state: "pending", ids: ["R4", "R8"] }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedPendingMulti, /simplification reviewers R4, R8 were still pending/);
	const renderedPartialWithItems = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [auditedItem, unverifiedFinding], simplificationAudit: { state: "partial", succeeded: 2, total: 3, ids: ["R8"] }, tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedPartialWithItems, /- \(partially evaluated — 1 of 3 simplification reviewers did not succeed \(R8\); their scopes were not audited\. Re-run the review to retry it\)/);
	assertIntro(renderedPartialWithItems, false);
	// The count line pluralizes the pronoun with the item count.
	const renderedTwoUnaudited = renderFindings({ reportable: [], withheld: [], dismissed: [], simplifications: [unverifiedFinding, { ...unverifiedFinding, claims: [{ file: "src/y.js", line: 2, claim: "inline the other helper" }], reviewerClaims: ["inline the other helper"] }], tree: { checked: false, changed: [] }, coverage: "c", steering: null, dropped: [] });
	assert.match(renderedTwoUnaudited, /2 raised simplifications were not audited \(the simplifier lane failed, did not assess them, or was unclear\) and are omitted/);

	// The audit-state derivation: runtime truth from the roster; the
	// pinned-set config short-circuits before the roster is consulted.
	assert.deepEqual(simplificationAuditState([{ id: "R1", lens: "correctness", state: "succeeded" }], { lenses: ["correctness"] }), { state: "not-configured" });
	assert.deepEqual(simplificationAuditState([{ id: "R1", lens: "correctness", state: "succeeded" }, { id: "R2", lens: "failure-paths", state: "failed" }], settings), { state: "cut-by-cap" });
	// planRoster really does slice the lens off at a tight cap, so the
	// cut-by-cap state is reachable, not just constructible.
	const tightRoster = planRoster({ files: [{ path: "a.js", lines: 100 }], available: true, lenses: [...DEFAULTS.lenses], settings: resolveDeepConfig({ maxReviewers: 3 }) });
	assert.ok(!tightRoster.some((entry) => entry.lens === "simplification"), "maxReviewers 3 cuts the simplification lens");
	assert.equal(simplificationAuditState(tightRoster, resolveDeepConfig({ maxReviewers: 3 })).state, "cut-by-cap");
	assert.deepEqual(simplificationAuditState([{ id: "R4", lens: "simplification", state: "succeeded" }], settings), { state: "ran" });
	assert.deepEqual(simplificationAuditState([{ id: "R4", lens: "simplification", state: "succeeded" }, { id: "R5", lens: "simplification", state: "pending" }], settings), { state: "partial", succeeded: 1, total: 2, ids: ["R5"] });
	assert.deepEqual(simplificationAuditState([{ id: "R4", lens: "simplification", state: "failed" }], settings), { state: "failed", ids: ["R4"] });
	assert.deepEqual(simplificationAuditState([{ id: "R4", lens: "simplification", state: "pending" }], settings), { state: "pending", ids: ["R4"] });
	// The mixed zero-succeeded roster: the pending ids ride along separately so
	// the disclosure can name each reviewer by its real state.
	assert.deepEqual(
		simplificationAuditState([{ id: "R4", lens: "simplification", state: "failed" }, { id: "R8", lens: "simplification", state: "pending" }], settings),
		{ state: "failed", ids: ["R4", "R8"], pendingIds: ["R8"] },
	);
	// A pure-failed multi roster carries no pendingIds: every missed id failed.
	assert.deepEqual(
		simplificationAuditState([{ id: "R4", lens: "simplification", state: "failed" }, { id: "R8", lens: "simplification", state: "failed" }], settings),
		{ state: "failed", ids: ["R4", "R8"] },
	);
	// A succeeded sibling keeps the partial state and the union ids semantics.
	assert.deepEqual(
		simplificationAuditState([{ id: "R4", lens: "simplification", state: "failed" }, { id: "R8", lens: "simplification", state: "pending" }, { id: "R9", lens: "simplification", state: "succeeded" }], settings),
		{ state: "partial", succeeded: 1, total: 3, ids: ["R4", "R8"] },
	);

	// The mixed-kind rejection and the kind cap in validateVerificationInput.
	const mixedRaw = new Map([
		["R1.1", { id: "R1.1", kind: "defect", file: "a.js", line: 3, claim: "bug", scenario: "s", suggestedFix: "f", priority: "P0" }],
		["R4.1", { id: "R4.1", kind: "simplification", file: "src/x.js", line: 7, claim: "collapse", scenario: "both branches return early", suggestedFix: "guard clause", priority: "P3" }],
	]);
	const mixedRejection = validateVerificationInput({ groups: [{ primary: "R1.1", mergedFrom: ["R4.1"] }], dropped: [] }, mixedRaw, settings, lanes, true);
	assert.equal(mixedRejection.ok, false);
	assert.match(mixedRejection.error, /never merge kinds.*R4\.1/);
	const kindCapRaw = new Map(Array.from({ length: 11 }, (_, i) => [`R4.${i + 1}`, { id: `R4.${i + 1}`, kind: "simplification", file: `f${i}.js`, line: 1, claim: "s", scenario: "preserves behavior", priority: "P3" }]));
	const kindCap = validateVerificationInput({ groups: [...kindCapRaw.keys()].map((id) => ({ primary: id })), dropped: [] }, kindCapRaw, settings, lanes, true);
	assert.equal(kindCap.ok, false, "11 simplification groups exceed ceil(30/3)");
	assert.match(kindCap.error, /simplification groups exceed the maximum/);
	const withinCap = validateVerificationInput({ groups: [...kindCapRaw.keys()].slice(0, 10).map((id) => ({ primary: id })), dropped: [{ id: "R4.11", reason: "duplicate of R4.10" }] }, kindCapRaw, settings, lanes, true);
	assert.equal(withinCap.ok, true, "10 simplification groups fit the kind cap");
	// The kind cap rounds UP: at maxVerifications 31, ceil(31/3) = 11, so 11
	// groups pass (a floor cap of 10 would reject them) and 12 fail — the
	// rounding mode is part of the documented contract.
	const cap31 = resolveDeepConfig({ maxVerifications: 31 });
	const cap31Raw = new Map(Array.from({ length: 12 }, (_, i) => [`R4.${i + 1}`, { id: `R4.${i + 1}`, kind: "simplification", file: `f${i}.js`, line: 1, claim: "s", scenario: "preserves behavior", priority: "P3" }]));
	const cap31Within = validateVerificationInput({ groups: [...cap31Raw.keys()].slice(0, 11).map((id) => ({ primary: id })), dropped: [{ id: "R4.12", reason: "duplicate of R4.11" }] }, cap31Raw, cap31, lanes, true);
	assert.equal(cap31Within.ok, true, "11 simplification groups fit ceil(31/3) = 11");
	const cap31Over = validateVerificationInput({ groups: [...cap31Raw.keys()].map((id) => ({ primary: id })), dropped: [] }, cap31Raw, cap31, lanes, true);
	assert.equal(cap31Over.ok, false, "12 simplification groups exceed ceil(31/3) = 11");
	assert.match(cap31Over.error, /a third of maxVerifications, rounded up/);

	// Overlap hints cluster within kind only.
	const hintFindings = new Map([
		["R1.1", { kind: "defect", file: "a.js", line: 10 }],
		["R4.1", { kind: "simplification", file: "a.js", line: 12 }],
		["R1.2", { kind: "defect", file: "a.js", line: 11 }],
	]);
	assert.deepEqual(overlapHints(hintFindings), [["R1.1", "R1.2"]], "a simplification at a neighboring line never clusters with a defect");

	// The simplifier's structured-output vocabulary is exactly the planned one.
	assert.deepEqual([...LANE_OUTCOMES.simplifier], ["simpler", "not-simpler", "behavior-change", "unclear"]);
	console.log("simplification pipeline: ok");
}

/** The citation gate: line-specific evidence resolves against the quote's
 * actual line span (±10), so a right-quote-wrong-place citation never verifies. */
{
	const root = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-"));
	try {
		const file = path.join(root, "src", "auth.js");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "line one\nline two\nreturn null; // the bug\nline four\n");
		const relative = "src/auth.js";
		assert.equal(await checkEvidence(root, { file: relative, line: 3, quote: "return null;" }), true);
		// A drifted line verifies within ±10 of the quote's actual span.
		assert.equal(await checkEvidence(root, { file: relative, line: 12, quote: "return null;" }), true);
		// Beyond the window: the quote exists in the file, but the cited line is
		// off by 27 — the old unconditional whole-file fallback verified it.
		assert.equal(await checkEvidence(root, { file: relative, line: 30, quote: "return null;" }), false);
		assert.equal(await checkEvidence(root, { file: relative, line: 3, quote: "line that does not exist" }), false);
		assert.equal(await checkEvidence(root, { file: "src/missing.js", line: 1, quote: "x" }), false);
		assert.equal(await checkEvidence(root, { file: relative, line: 3 }), false);
		// Non-line-specific evidence resolves anywhere in the file.
		assert.equal(await checkEvidence(root, { file: relative, quote: "return null;" }), true);

		// A cited path above the citation size cap (or not a regular file) is
		// refused without reading. Sparse file, so the test costs nothing.
		const huge = path.join(root, "src", "huge.js");
		const fh = await open(huge, "w");
		await fh.truncate(CITATION_SIZE_CAP + 1);
		await fh.close();
		assert.equal(await checkEvidence(root, { file: "src/huge.js", line: 1, quote: "return null;" }), false);
		// A directory citation is refused (isFile), not read.
		assert.equal(await checkEvidence(root, { file: "src", line: 1, quote: "return null;" }), false);

		// Containment: evidence paths are LLM-authored and reach node:fs, so a
		// path that escapes the reviewed worktree — lexically or by realpath —
		// is refused without reading. An absolute path that resolves inside the
		// worktree is allowed: the contract is containment, not spelling.
		const outsideFile = path.join(tmpdir(), "dsh-review-fleet-escape-outside.txt");
		await writeFile(outsideFile, "return null; // outside the worktree\n");
		assert.equal(await checkEvidence(root, { file: outsideFile, line: 1, quote: "return null;" }), false);
		assert.equal(await checkEvidence(root, { file: `../${path.basename(outsideFile)}`, quote: "return null;" }), false);
		// Symlink hardening: a worktree-internal symlink whose realpath escapes
		// is refused by the same containment.
		const escaped = path.join(root, "src", "escaped.js");
		await symlink(outsideFile, escaped);
		assert.equal(await checkEvidence(root, { file: "src/escaped.js", quote: "return null;" }), false);
		// A dangling symlink fails realpath and is answered like a missing file.
		const dangling = path.join(root, "src", "dangling.js");
		await symlink(path.join(root, "src", "gone.js"), dangling);
		assert.equal(await checkEvidence(root, { file: "src/dangling.js", quote: "return null;" }), false);
		// A valid relative citation still verifies.
		assert.equal(await checkEvidence(root, { file: relative, line: 3, quote: "return null;" }), true);
		await rm(outsideFile, { force: true });

		// A legitimate citation after a run of consecutive blank lines: the
		// whole-run search + per-line mapping drifted beyond ±10; locating the
		// quote in the same join the mapping walks is exact.
		const blankFile = path.join(root, "src", "blank.js");
		const blanks = Array.from({ length: 65 }, () => "").join("\n");
		await writeFile(blankFile, `line one\nline two\n${blanks}\nreturn null; // the bug\nline four\n`);
		// "return null;" sits on line 3 + 65 = 68.
		assert.equal(await checkEvidence(root, { file: "src/blank.js", line: 68, quote: "return null;" }), true);
		assert.equal(await checkEvidence(root, { file: "src/blank.js", line: 30, quote: "return null;" }), false);

		// A quote repeated through the file: the span check resolves against the
		// occurrence the verifier cites, not just the first. The quote appears
		// on lines 1 and 300; a correct citation at line 300 verifies against
		// the second occurrence's span, and a wrong-place citation at line 150
		// still fails (no occurrence's ±10 window contains it).
		const repeated = path.join(root, "src", "repeated.js");
		const repeatedLines = Array.from({ length: 300 }, (_, i) => (i === 0 || i === 299 ? "return null; // the bug" : `filler line ${i + 1}`));
		await writeFile(repeated, repeatedLines.join("\n") + "\n");
		assert.equal(await checkEvidence(root, { file: "src/repeated.js", line: 300, quote: "return null;" }), true);
		assert.equal(await checkEvidence(root, { file: "src/repeated.js", line: 1, quote: "return null;" }), true);
		assert.equal(await checkEvidence(root, { file: "src/repeated.js", line: 150, quote: "return null;" }), false);
		const keptRepeat = await gateStance(root, { outcome: "reachable", notes: "", evidence: [{ file: "src/repeated.js", line: 300, quote: "return null;" }] }, true);
		assert.match(keptRepeat.note, /1\/1 citations verified/);

		// A stance whose citations all fail demotes to unclear.
		const demoted = await gateStance(root, { outcome: "reachable", notes: "", evidence: [{ file: "src/missing.js", line: 1, quote: "x" }] }, true);
		assert.deepEqual(demoted, { outcome: "unclear", note: "citation not found (1 cited)" });
		const kept = await gateStance(root, { outcome: "reachable", notes: "", evidence: [{ file: relative, line: 3, quote: "return null;" }] }, true);
		assert.match(kept.note, /1\/1 citations verified/);
		// An executed reproduction is taken at face value.
		assert.equal(await gateStance(root, { outcome: "reproduced", method: "executed", notes: "", evidence: [] }, false), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	console.log("citation gate: ok");
}

/** The steering ledger: capture, dedup, caps with a pinned first entry, and notices. */
{
	const ledger = createLedger(resolveDeepConfig({ maxSteeringEntries: 3, maxSteeringChars: 40 }));
	assert.equal(ledger.block(), null);
	const message = (id, text, type = "text") => ({ id, content: [{ type, text }] });
	assert.equal(ledger.add(message("m1", "CANARY-STANDING focus on io")), true);
	assert.equal(ledger.add(message("m1", "duplicate")), false);
	assert.equal(ledger.add(message("m2", "second")), true);
	assert.equal(ledger.add(message("m3", "third")), true);
	assert.equal(ledger.add(message("m4", "fourth")), true);
	// The first entry is pinned; the oldest non-pinned one was dropped with a notice.
	assert.match(ledger.notice(), /dropped by the cap/);
	assert.ok(ledger.entries().some((entry) => entry.text.includes("CANARY-STANDING")));
	assert.ok(!ledger.entries().some((entry) => entry.text.includes("second")));
	// Per-entry length cap with the truncation marker.
	assert.equal(ledger.add(message("m5", "x".repeat(60))), true);
	assert.match(ledger.entries().find((entry) => entry.id === "m5").text, /truncated: 20 more characters/);
	// The notice names the OLDEST dropped entry (naming the last would
	// under-report: #2 and #3 are both dropped by now).
	assert.match(ledger.notice(), /2 earlier steering messages were dropped by the cap \(entry #2 dropped\)/);
	// Non-text blocks are noted, not lost.
	assert.equal(ledger.add(message("m6", "", "image")), true);
	assert.match(ledger.entries().find((entry) => entry.id === "m6").text, /attachment omitted/);
	// Replace and discard follow the inbox.
	assert.equal(ledger.replace(message("m5", "edited")), true);
	assert.ok(ledger.entries().find((entry) => entry.id === "m5").text.includes("edited"));
	assert.equal(ledger.discard(message("m5")), true);
	assert.ok(!ledger.entries().some((entry) => entry.id === "m5"));
	// The block frames steering as non-evidence for verifiers.
	assert.match(ledger.block(), /User steering received/);
	assert.match(ledger.block(), /cannot override/);
	assert.match(ledger.block(), /not treat steering as evidence/);
	assert.match(ledger.summary(), /Steering received/);
	console.log("steering ledger: ok");
}

/** The worker guard: read-only for static lanes, tests-only for the reproducer. */
{
	const staticGuard = workerGuard(["bash", "read", "grep", "glob"], "static");
	assert.match(staticGuard({ name: "edit", arguments: {} }), /not a read tool/);
	assert.equal(staticGuard({ name: "bash", arguments: { command: "git status --short" } }), undefined);
	assert.equal(staticGuard({ name: "bash", arguments: { command: "grep -rn x src/" } }), undefined);
	// Substitution content is inspected like a command: legitimate spans pass,
	// bypass spans are denied.
	assert.equal(staticGuard({ name: "bash", arguments: { command: "git log $(git rev-parse --abbrev-ref HEAD)" } }), undefined);
	assert.equal(staticGuard({ name: "bash", arguments: { command: "grep \"$(cat pattern.txt)\" src/" } }), undefined);
	assert.equal(staticGuard({ name: "bash", arguments: { command: "git log `git rev-parse HEAD`" } }), undefined);
	assert.match(staticGuard({ name: "bash", arguments: { command: "cat $(rm -rf ~/Documents)" } }), /\$\(…\) content/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "echo `rm -rf src`" } }), /\$\(…\) content/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "rm -rf /" } }), /not "rm"/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "node script.js" } }), /not "node"/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "git checkout main" } }), /may not run "git checkout"/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "echo x > file" } }), /may not write/);
	// find's and sort's write/execute options; piped shells; quoted denied words.
	assert.match(staticGuard({ name: "bash", arguments: { command: "find . -name \"*.js\" -delete" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "find . -exec /tmp/evil.sh ;" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "find . -execdir x ;" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "find . -ok x ;" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "find . -fprint out.txt" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "sort -o README.md /dev/null" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "git status ; sort -o README.md /dev/null" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "echo hi | sh" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "echo hi | bash" } }), /may not write/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "git status && find . -name x -delete" } }), /may not write/);
	// Legitimate read-only cases the deny classes must not catch.
	assert.equal(staticGuard({ name: "bash", arguments: { command: "find . -name x -print" } }), undefined);
	assert.equal(staticGuard({ name: "bash", arguments: { command: "sort -u f" } }), undefined);
	// git ref/file write options: branch delete/move/copy/force/tracking and the
	// diff-family --output=<file> are denied (real-git verified writes).
	for (const deny of [
		"git branch -D feature-x",
		"git branch -d feature-x",
		"git branch --force main HEAD~1",
		"git branch -f main abc1234",
		"git branch -m old new",
		"git branch -M old new",
		"git branch --move old new",
		"git branch -c a b",
		"git branch -C a b",
		"git branch --copy a b",
		"git branch -t origin/main",
		"git branch --track origin/main",
		"git branch -u origin/main",
		"git branch --set-upstream-to=origin/main",
		"git branch --unset-upstream",
		"git branch --edit-description",
		"git branch -ad x",
		"git status ; git branch -D x",
		"git show HEAD --output=stolen.txt",
		"git log --output=stolen.txt",
		"git diff main --output=.git/config",
		"git blame --output=stolen.txt src/a.js",
	]) {
		assert.match(staticGuard({ name: "bash", arguments: { command: deny } }), /guard/, deny);
	}
	// The listing forms and text-only diff indicators pass.
	for (const legit of [
		"git branch -v",
		"git branch -vv",
		"git branch -a",
		"git branch -r",
		"git branch -l",
		"git branch --list",
		"git branch --show-current",
		"git branch --format=%(refname:short)",
		"git branch --sort=refname",
		"git log --follow",
		"git log -g",
		"git log --oneline",
		"git log --format=%d",
		"git diff --full-index",
		"git diff --output-indicator-new=> HEAD~1",
		"git show -m",
		"git show --stat",
		"git show --no-patch",
		"git blame -f",
		"git blame -w",
		"git blame -L 1,10 src/a.js",
	]) {
		assert.equal(staticGuard({ name: "bash", arguments: { command: legit } }), undefined, legit);
	}
	// The no-space redirect to an absolute path writes the working tree; the
	// space form and >/dev/null were already denied via backtracking.
	assert.match(staticGuard({ name: "bash", arguments: { command: "git show HEAD >/Users/apcamargo/Downloads/pwn.txt" } }), /guard/);
	assert.match(staticGuard({ name: "bash", arguments: { command: "echo pwn >/Users/apcamargo/Downloads/src/f.txt" } }), /guard/);
	const executing = workerGuard(["bash"], "executing");
	assert.match(executing({ name: "bash", arguments: { command: "npm install foo" } }), /install dependencies/);
	assert.match(executing({ name: "bash", arguments: { command: "npm ci" } }), /install dependencies/);
	assert.match(executing({ name: "bash", arguments: { command: "pnpm add x" } }), /install dependencies/);
	assert.match(executing({ name: "bash", arguments: { command: "yarn add x" } }), /install dependencies/);
	// The bare test runners the reproducer lane documents are allowed.
	assert.equal(executing({ name: "bash", arguments: { command: "npm test" } }), undefined);
	assert.equal(executing({ name: "bash", arguments: { command: "npm run test" } }), undefined);
	assert.equal(executing({ name: "bash", arguments: { command: "pnpm test" } }), undefined);
	assert.equal(executing({ name: "bash", arguments: { command: "yarn test" } }), undefined);
	assert.equal(executing({ name: "bash", arguments: { command: "mktemp -d && npm test" } }), undefined);
	assert.match(executing({ name: "bash", arguments: { command: "rm -rf /" } }), /obviously mutate/);
	assert.match(executing({ name: "bash", arguments: { command: "find . -delete" } }), /obviously mutate/);
	assert.match(executing({ name: "bash", arguments: { command: "sort -o README.md /dev/null" } }), /obviously mutate/);
	assert.match(executing({ name: "bash", arguments: { command: "find . -exec /tmp/evil.sh ;" } }), /obviously mutate/);
	assert.match(executing({ name: "bash", arguments: { command: "git commit -m x" } }), /obviously mutate/);
	assert.match(executing({ name: "bash", arguments: { command: "echo hi | sh" } }), /obviously mutate/);
	assert.equal(executing({ name: "bash", arguments: { command: "mktemp -d && node /tmp/x.js" } }), undefined);
	assert.equal(executing({ name: "bash", arguments: { command: "git status --short" } }), undefined);
	// The git ref/file write options are denied in the executing profile too.
	assert.match(executing({ name: "bash", arguments: { command: "git branch -D main" } }), /guard/);
	assert.match(executing({ name: "bash", arguments: { command: "git branch -m main hijacked" } }), /guard/);
	assert.match(executing({ name: "bash", arguments: { command: "git show --output=/tmp/x HEAD" } }), /guard/);
	assert.equal(executing({ name: "bash", arguments: { command: "git branch -v" } }), undefined);
	// A cap-dropped substitution span was never inspected: 8 clean spans + a
	// malicious 9th denies the command outright instead of passing because its
	// first spans were clean. The command leads with a whitelisted binary so
	// the profile check passes and the denial comes from the truncation.
	const eightClean = `git log ${Array.from({ length: 8 }, (_, i) => `$(echo ${i})`).join(" ")}`;
	assert.equal(staticGuard({ name: "bash", arguments: { command: eightClean } }), undefined);
	assert.match(staticGuard({ name: "bash", arguments: { command: `${eightClean} $(rm -rf /tmp/x)` } }), /guard inspects/);
	// Backtick spans are capped too.
	const eightBackticks = `git log ${Array.from({ length: 8 }, () => "`echo x`").join(" ")}`;
	assert.equal(staticGuard({ name: "bash", arguments: { command: eightBackticks } }), undefined);
	assert.match(staticGuard({ name: "bash", arguments: { command: `${eightBackticks} \`rm -rf /tmp/x\`` } }), /guard inspects/);
	console.log("worker guard: ok");
}

/** numstat parsing, tree diffs, and folder walks. */
{
	assert.deepEqual(parseNumstat("12\t3\tsrc/a.js\u0000-\t-\timg.png\u00001\t0\t\u0000src/old.js\u0000src/new.js\u0000"), [{ path: "src/a.js", lines: 15 }, { path: "src/new.js", lines: 1 }]);
	assert.deepEqual(treeDiff(null, null), { checked: false, changed: [] });
	const root = await mkdtemp(path.join(tmpdir(), "dsh-review-walk-"));
	try {
		await writeFile(path.join(root, "a.js"), "x");
		await mkdir(path.join(root, "node_modules"));
		await writeFile(path.join(root, "node_modules", "dep.js"), "y");
		assert.deepEqual((await walkFiles(root, undefined)).map((entry) => entry.path), ["a.js"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}

	// Directories that cannot be read are skipped and collected for the coverage note.
	const lockedRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-walk-note-"));
	try {
		await writeFile(path.join(lockedRoot, "a.js"), "x");
		await mkdir(path.join(lockedRoot, "secret"), { recursive: true });
		if (process.getuid?.() !== 0) {
			await chmod(path.join(lockedRoot, "secret"), 0o000);
			const skipped = [];
			assert.deepEqual((await walkFiles(lockedRoot, undefined, skipped)).map((entry) => entry.path), ["a.js"]);
			assert.equal(skipped.length, 1);
		}
	} finally {
		await chmod(path.join(lockedRoot, "secret"), 0o755).catch(() => {});
		await rm(lockedRoot, { recursive: true, force: true });
	}

	// A dangling symlink (stat fails) is named in the coverage, not silently
	// absent from the walk; a symlink to a real file is followed. A symlinked
	// directory inside the walk is neither listed nor recursed (recursing a
	// symlink would walk outside the reviewed root and risk a cycle) — it is
	// named in the coverage too.
	const symlinkRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-walk-symlink-"));
	try {
		await writeFile(path.join(symlinkRoot, "a.js"), "x");
		await symlink(path.join(symlinkRoot, "missing.js"), path.join(symlinkRoot, "broken.js"));
		await symlink(path.join(symlinkRoot, "a.js"), path.join(symlinkRoot, "linked.js"));
		await mkdir(path.join(symlinkRoot, "real-dir"), { recursive: true });
		await writeFile(path.join(symlinkRoot, "real-dir", "b.js"), "x");
		await symlink(path.join(symlinkRoot, "real-dir"), path.join(symlinkRoot, "dir-symlink"));
		const skipped = [];
		assert.deepEqual((await walkFiles(symlinkRoot, undefined, skipped)).map((entry) => entry.path).sort(), ["a.js", "linked.js", "real-dir/b.js"]);
		assert.deepEqual(skipped.map((item) => [path.basename(item.path), item.reason]).sort(), [["broken.js", "unreadable"], ["dir-symlink", "symlinked directory"]]);
	} finally {
		await rm(symlinkRoot, { recursive: true, force: true });
	}
	console.log("changes: ok");
}

/** The working-tree snapshot over the real subprocess: a mid-review staged
 * change is caught (invisible to `git ls-files -m -d -o`), a staged rename is
 * not hashed as a phantom "deleted", and a repository with no commits answers
 * a snapshot instead of throwing. */
{
	/** One temp git repository bound to the real subprocess fixture. */
	const makeRepo = async (root) => {
		const git = async (...args) => {
			const result = await runProcess({ subprocess }, ["git", ...args], root, undefined);
			assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
		};
		await mkdir(root, { recursive: true });
		await git("init", "-b", "main");
		await git("config", "user.email", "test@example.com");
		await git("config", "user.name", "Test");
		return git;
	};

	// A repository with no commits answers a snapshot, never a GitError:
	// `git diff HEAD` would fail here; `git status --porcelain -z` answers 0.
	const noCommitRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-nocommit-"));
	try {
		const git = await makeRepo(noCommitRoot);
		await writeFile(path.join(noCommitRoot, "a.js"), "untracked\n");
		const noCommit = await snapshotTree({ subprocess }, noCommitRoot, undefined);
		assert.ok(noCommit instanceof Map, "a repository with no commits answers a Map, never a GitError");
		assert.ok(noCommit.has("a.js"), "an untracked file is hashed");
	} finally {
		await rm(noCommitRoot, { recursive: true, force: true });
	}

	// A mid-review staged change is caught: `git ls-files -m -d -o` lists the
	// worktree against the index only, so `git add` is invisible to it.
	const stagedRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-staged-"));
	try {
		const git = await makeRepo(stagedRoot);
		await writeFile(path.join(stagedRoot, "a.js"), "original\n");
		await git("add", ".");
		await git("commit", "-m", "initial");
		const before = await snapshotTree({ subprocess }, stagedRoot, undefined);
		await writeFile(path.join(stagedRoot, "a.js"), "changed mid-review\n");
		await git("add", "a.js");
		const after = await snapshotTree({ subprocess }, stagedRoot, undefined);
		assert.deepEqual(treeDiff(before, after).changed, ["a.js"], "a mid-review staged change is caught");
		// A staged change then `git mv` breaks the rename pair into a staged
		// delete + add (`D  a.js`, `A  b.js`): the staged deletion is a real
		// index state, hashed as "deleted" like any staged removal.
		await git("mv", "a.js", "b.js");
		const afterMv = await snapshotTree({ subprocess }, stagedRoot, undefined);
		assert.equal(afterMv.get("a.js"), "deleted");
		assert.ok(afterMv.has("b.js"), "the staged add is hashed from the worktree");
		assert.deepEqual(treeDiff(after, afterMv).changed, ["a.js", "b.js"], "the delete+add pair reaches the diff");

		// A mid-review `git rm` (worktree + index, invisible to `ls-files -m -d -o`) is caught.
		const rmRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-rm-"));
		try {
			const rmGit = await makeRepo(rmRoot);
			await writeFile(path.join(rmRoot, "a.js"), "original\n");
			await rmGit("add", ".");
			await rmGit("commit", "-m", "initial");
			const beforeRm = await snapshotTree({ subprocess }, rmRoot, undefined);
			await rmGit("rm", "a.js");
			const afterRm = await snapshotTree({ subprocess }, rmRoot, undefined);
			assert.equal(afterRm.get("a.js"), "deleted");
			assert.deepEqual(treeDiff(beforeRm, afterRm).changed, ["a.js"], "a mid-review git rm is caught");
		} finally {
			await rm(rmRoot, { recursive: true, force: true });
		}
	} finally {
		await rm(stagedRoot, { recursive: true, force: true });
	}

	// A filename with trailing whitespace is legal and tracked verbatim: the
	// -z paths are not trimmed, so the snapshot hashes the exact path and a
	// mid-review content change is caught — both snapshots recording "deleted"
	// under the trimmed key would silently disable the integrity guard.
	const trimmedRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-trim-"));
	try {
		const git = await makeRepo(trimmedRoot);
		await writeFile(path.join(trimmedRoot, "a.js "), "committed\n");
		await git("add", ".");
		await git("commit", "-m", "initial");
		// The review target: uncommitted changes BEFORE the first snapshot.
		await writeFile(path.join(trimmedRoot, "a.js "), "dirty v1\n");
		const beforeTrim = await snapshotTree({ subprocess }, trimmedRoot, undefined);
		assert.deepEqual([...beforeTrim.keys()], ["a.js "], "the verbatim path is the snapshot key");
		await writeFile(path.join(trimmedRoot, "a.js "), "dirty v2\n");
		const afterTrim = await snapshotTree({ subprocess }, trimmedRoot, undefined);
		assert.deepEqual(treeDiff(beforeTrim, afterTrim).changed, ["a.js "], "a mid-review change to a whitespace-suffixed file is caught");
		// The untracked listing is verbatim too: the roster entry (and its
		// citation/prompt path) resolves the exact filename.
		await writeFile(path.join(trimmedRoot, "b.js  "), "untracked\n");
		const listing = await listChangedFiles({ subprocess }, trimmedRoot, { type: "uncommitted" }, undefined);
		assert.ok(listing.files.some((file) => file.path === "b.js  "), "the untracked whitespace-suffixed filename is verbatim in the roster");
		assert.ok(listing.files.some((file) => file.path === "a.js "), "the tracked whitespace-suffixed filename is verbatim in the roster");
	} finally {
		await rm(trimmedRoot, { recursive: true, force: true });
	}

	// A staged rename on a CLEAN file emits `R  b.js\0a.js\0`: the second NUL
	// record is the rename source, gone from the worktree, and the parse skips
	// it so it is not hashed as a phantom "deleted".
	const renameRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-rename-"));
	try {
		const git = await makeRepo(renameRoot);
		await writeFile(path.join(renameRoot, "a.js"), "original\n");
		await git("add", ".");
		await git("commit", "-m", "initial");
		const before = await snapshotTree({ subprocess }, renameRoot, undefined);
		await git("mv", "a.js", "b.js");
		const renamed = await snapshotTree({ subprocess }, renameRoot, undefined);
		assert.ok(!renamed.has("a.js"), "the staged rename source is not hashed as a phantom deleted");
		assert.ok(renamed.has("b.js"), "the staged rename destination is hashed from the worktree");
		// The before snapshot names no clean file (a.js was clean), so the diff
		// names the worktree change the rename applied: b.js.
		assert.deepEqual(treeDiff(before, renamed).changed, ["b.js"], "the rename reaches the diff");
	} finally {
		await rm(renameRoot, { recursive: true, force: true });
	}
	console.log("snapshot: ok");
}

/** Generated or vendored paths: excluded entirely from the uncommitted and
 * diff listings (a lock-only branch change spends no sharding weight or
 * reviewer runs), the committed form of the same content agreeing with the
 * uncommitted form, and kept as 0-weight folder entries. */
{
	const root = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-generated-"));
	try {
		const git = async (...args) => {
			const result = await runProcess({ subprocess }, ["git", ...args], root, undefined);
			assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
		};
		await mkdir(path.join(root, "src"), { recursive: true });
		await mkdir(path.join(root, "dist"), { recursive: true });
		await writeFile(path.join(root, "package-lock.json"), "{}\n");
		await writeFile(path.join(root, "src", "a.js"), "export {}\n");
		await writeFile(path.join(root, "dist", "x.min.js"), "export {}\n");
		await git("init", "-b", "main");
		await git("config", "user.email", "test@example.com");
		await git("config", "user.name", "Test");
		await git("add", ".");
		await git("commit", "-m", "initial");
		await git("checkout", "-b", "feature");
		// A lock-only branch change: both diff listings exclude it entirely.
		await writeFile(path.join(root, "package-lock.json"), "{}\n{}\n");
		await git("add", ".");
		await git("commit", "-m", "lock only");
		const mergeBase = (await runProcess({ subprocess }, ["git", "merge-base", "main", "feature"], root, undefined)).stdout.trim();
		const baseListing = await listChangedFiles({ subprocess }, root, { type: "baseBranch", branch: "main", mergeBase }, undefined);
		assert.deepEqual(baseListing.files, [], "a lock-only branch diff excludes generated paths entirely");
		const lockOnlySha = (await runProcess({ subprocess }, ["git", "rev-parse", "HEAD"], root, undefined)).stdout.trim();
		const lockOnlyListing = await listChangedFiles({ subprocess }, root, { type: "commit", sha: lockOnlySha }, undefined);
		assert.deepEqual(lockOnlyListing.files, [], "a lock-only commit listing excludes generated paths entirely");
		// The mixed dirty tree: the lock is dropped, the real file stays — and
		// the committed form of the same content agrees.
		await writeFile(path.join(root, "src", "a.js"), "export { changed }\n");
		await writeFile(path.join(root, "package-lock.json"), "{}\n{}\n{}\n");
		const dirtyListing = await listChangedFiles({ subprocess }, root, { type: "uncommitted" }, undefined);
		assert.deepEqual(dirtyListing.files.map((file) => file.path), ["src/a.js"], "the dirty mixed tree keeps the real file and drops the lock");
		await git("add", ".");
		await git("commit", "-m", "src + lock");
		const mixedSha = (await runProcess({ subprocess }, ["git", "rev-parse", "HEAD"], root, undefined)).stdout.trim();
		const baseAfter = await listChangedFiles({ subprocess }, root, { type: "baseBranch", branch: "main", mergeBase }, undefined);
		const mixedListing = await listChangedFiles({ subprocess }, root, { type: "commit", sha: mixedSha }, undefined);
		assert.deepEqual(baseAfter.files.map((file) => file.path), ["src/a.js"], "the committed form agrees with the uncommitted form");
		assert.deepEqual(mixedListing.files.map((file) => file.path), ["src/a.js"], "a mixed commit keeps the real file and drops the lock");
		// A generated-only weighty diff never trips the shard valve: whole-change roster.
		const roster = planRoster({ files: baseListing.files, available: true, lenses: [...DEFAULTS.lenses], settings: resolveDeepConfig({}) });
		assert.equal(roster.length, 7);
		assert.ok(roster.every((entry) => entry.shard === null), "a generated-only diff reviews as whole change");
		// Folder targets keep generated paths as 0-weight entries.
		const folderListing = await listChangedFiles({ subprocess }, root, { type: "folder", paths: ["."] }, undefined);
		const byPath = new Map(folderListing.files.map((file) => [file.path, file.lines]));
		assert.equal(byPath.get("package-lock.json"), 0, "the lock is a 0-weight folder entry");
		assert.equal(byPath.get("dist/x.min.js"), 0, "dist is a 0-weight folder entry");
		assert.ok((byPath.get("src/a.js") ?? 0) > 0, "the real file keeps its weight");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	console.log("generated paths: ok");
}

/** Lane applicability, config validation, and schemas. */
{
	const settings = resolveDeepConfig({});
	// The simplifier is appended LAST in the lane catalog, so every existing
	// lane's order is preserved for both hasDiff values.
	assert.deepEqual(applicableLanes(settings, false).map((lane) => lane.id), ["reproducer", "skeptic", "consistency", "impact", "fix-auditor", "simplifier"]);
	assert.deepEqual(applicableLanes(settings, true).map((lane) => lane.id), ["reproducer", "skeptic", "consistency", "provenance", "impact", "fix-auditor", "simplifier"]);
	assert.deepEqual(
		applicableLanes(resolveDeepConfig({ lanes: { impact: { enabled: false }, "fix-auditor": { enabled: false }, consistency: { enabled: false } } }), true).map((lane) => lane.id),
		["reproducer", "skeptic", "provenance", "simplifier"],
	);
	assert.throws(() => resolveDeepConfig({ lanes: { reproducer: { enabled: false } } }), /cannot be disabled/);
	assert.throws(() => resolveDeepConfig({ lanes: { simplifier: { enabled: false } } }), /cannot be disabled/);
	assert.throws(() => resolveDeepConfig({ lenses: ["nope"] }), /unknown lens/);
	// planRoster silently drops a lens with no roster class; resolveDeepConfig
	// refuses one — and this drift detector keeps the declared lens catalog
	// classed, so the guard can never go stale against a new lens.
	for (const lens of LENS_IDS) {
		assert.ok(LOCAL_LENSES.includes(lens) || CROSS_LENSES.includes(lens), `lens "${lens}" has a roster class`);
	}
	assert.throws(() => resolveDeepConfig({ lanes: { nope: {} } }), /unknown lane/);
	assert.throws(() => resolveDeepConfig({ lenses: [] }), /at least one lens/);
	// A duplicated lens would run the lens's reviewers twice: rejected, not
	// silently deduped.
	assert.throws(() => resolveDeepConfig({ lenses: ["correctness", "correctness"] }), /duplicate lens/);
	// The returned settings are deep-frozen over a CLONE: the raw config's own
	// interiors stay unfrozen (freezing must never side-effect the caller's
	// config object).
	const cloneRaw = { lanes: { skeptic: { chunkSize: 2 } } };
	const frozen = resolveDeepConfig(cloneRaw);
	assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.lanes) && Object.isFrozen(frozen.lanes.skeptic));
	assert.ok(!Object.isFrozen(cloneRaw.lanes.skeptic));
	// The cost-cap floors close the verified silent-degradation paths: a
	// maxReviewers 0 yielded a silent empty scan, maxSteeringEntries 0 popped
	// the pinned first steering entry, and non-numeric/non-array values reached
	// the runtime as TypeErrors or cryptic failures.
	for (const [bad, why] of [
		[{ maxReviewers: 0 }, /deep.maxReviewers/],
		[{ maxFindingsPerReviewer: 0 }, /deep.maxFindingsPerReviewer/],
		[{ maxSteeringEntries: 0 }, /deep.maxSteeringEntries/],
		[{ maxSteeringChars: 0 }, /deep.maxSteeringChars/],
		[{ minReviewerSuccess: -1 }, /deep.minReviewerSuccess/],
		[{ minReviewerSuccess: 1.5 }, /deep.minReviewerSuccess/],
		[{ concurrency: "abc" }, /deep.concurrency/],
		[{ reviewerTools: 42 }, /deep.reviewerTools must be an array/],
		[{ reviewerTools: ["bash", 42] }, /must be an array of strings/],
		[{ lenses: "correctness" }, /deep.lenses must be an array/],
		[{ verifierRetries: -1 }, /deep.verifierRetries/],
		[{ reviewerRetries: -1 }, /deep.reviewerRetries/],
		// The three timer fields: negative/zero/fractional values would throw
		// RangeError from AbortSignal.timeout at every deep tool call, or abort
		// within ~1 ms — an abort the scan can never recover from.
		[{ callBudgetMs: 0 }, /deep.callBudgetMs/],
		[{ callBudgetMs: -1 }, /deep.callBudgetMs/],
		[{ callBudgetMs: 0.5 }, /deep.callBudgetMs/],
		[{ callBudgetMs: 999 }, /deep.callBudgetMs/],
		[{ reviewerTimeoutMs: 0 }, /deep.reviewerTimeoutMs/],
		[{ verifierTimeoutMs: 0 }, /deep.verifierTimeoutMs/],
		// A non-object lane value and a non-boolean enabled would pass validation
		// and be silently ENABLED at runtime (applicableLanes reads enabled !==
		// false): a user disabling the mandatory lane got it run. Null is a
		// malformed value in the same dangerous direction.
		[{ lanes: { reproducer: "off" } }, /deep.lanes.reproducer must be an object/],
		[{ lanes: { reproducer: { enabled: "no" } } }, /deep.lanes.reproducer.enabled must be a boolean/],
		[{ lanes: { impact: ["off"] } }, /deep.lanes.impact must be an object/],
		[{ lanes: { impact: { enabled: null } } }, /deep.lanes.impact.enabled must be a boolean/],
		// A null lanes container throws a raw TypeError from the entries loop, and
		// a number or empty array makes the loop no-op so every lane
		// configuration is silently ignored; a non-string or empty provider name
		// would surface as a misleading scan quorum error instead of a config
		// error (the wired schema cannot catch an empty string).
		[{ lanes: null }, /deep.lanes must be an object/],
		[{ lanes: 123 }, /deep.lanes must be an object/],
		[{ lanes: [] }, /deep.lanes must be an object/],
		[{ reviewerProvider: 123 }, /deep.reviewerProvider must be a non-empty string/],
		[{ reviewerProvider: "" }, /deep.reviewerProvider must be a non-empty string/],
	]) {
		assert.throws(() => resolveDeepConfig(bad), why, JSON.stringify(bad));
	}
	// Lane sub-fields: a negative/zero/fractional/non-number chunkSize would hang
	// planLaneRuns's chunk loop forever (or silently collapse to one empty chunk
	// — the lane never assessing any group); undefined/null are unset, exactly as
	// the runtime's `?? lane.chunkSize` treats them. Lane and top-level
	// agentOptions shapes: a malformed shape would reach the subagent start as
	// silent garbage.
	for (const [bad, why] of [
		[{ lanes: { reproducer: { chunkSize: -1 } } }, /deep\.lanes\.reproducer\.chunkSize/],
		[{ lanes: { reproducer: { chunkSize: 0 } } }, /deep\.lanes\.reproducer\.chunkSize/],
		[{ lanes: { reproducer: { chunkSize: 0.5 } } }, /deep\.lanes\.reproducer\.chunkSize/],
		[{ lanes: { reproducer: { chunkSize: "x" } } }, /deep\.lanes\.reproducer\.chunkSize/],
		[{ lanes: { reproducer: { agentOptions: "x" } } }, /agentOptions must be an object/],
		[{ lanes: { reproducer: { agentOptions: { nope: 1 } } } }, /unknown key/],
		[{ lanes: { reproducer: { agentOptions: { maxTokens: 0 } } } }, /maxTokens/],
		[{ verifierAgentOptions: { maxTokens: -5 } }, /verifierAgentOptions\.maxTokens/],
		[{ reviewerAgentOptions: "x" }, /reviewerAgentOptions must be an object/],
	]) {
		assert.throws(() => resolveDeepConfig(bad), why, JSON.stringify(bad));
	}
	assert.doesNotThrow(() => resolveDeepConfig({ verifierAgentOptions: { model: "m", maxTokens: undefined } }));
	assert.equal(resolveDeepConfig({ lanes: { reproducer: {} } }).lanes.reproducer.chunkSize, undefined);
	// The derived budget floor: with the default timeout equal to the old
	// default budget, a full-timeout worker's in-call retry was dead by
	// construction (the retry starts after the timeout and is aborted at once
	// by the budget). When the budget is unset it scales to at least
	// (1 + retries) × each worker limit; an explicitly-configured budget stays
	// a cap — the four budget-pinning runtime tests below rely on it.
	assert.equal(resolveDeepConfig({}).reviewerTimeoutMs, 1_200_000);
	assert.equal(resolveDeepConfig({}).callBudgetMs, 2_400_000);
	assert.equal(resolveDeepConfig({ reviewerTimeoutMs: 1_800_000 }).callBudgetMs, 3_600_000);
	assert.equal(resolveDeepConfig({ callBudgetMs: 5_000_000, reviewerTimeoutMs: 1_800_000 }).callBudgetMs, 5_000_000);
	assert.equal(resolveDeepConfig({ reviewerTimeoutMs: 5000, verifierTimeoutMs: 5000, callBudgetMs: 6000 }).callBudgetMs, 6000);
	// The derived value clamps: a huge timeout and its floor cannot re-create
	// the MAX_TIMER_MS overflow the timer semantics guard against.
	const clampedTimers = resolveDeepConfig({ reviewerTimeoutMs: MAX_TIMER_MS, verifierTimeoutMs: MAX_TIMER_MS });
	assert.equal(clampedTimers.reviewerTimeoutMs, MAX_TIMER_MS);
	assert.equal(clampedTimers.callBudgetMs, MAX_TIMER_MS);
	for (const laneId of Object.keys(LANE_OUTCOMES)) {
		const required = verifierSchema(laneId).properties.results.items.required;
		assert.ok(required.includes("ref") && required.includes("outcome"));
	}
	assert.ok(verifierSchema("reproducer").properties.results.items.required.includes("method"));
	assert.ok(verifierSchema("impact").properties.results.items.required.includes("priority"));
	assert.ok(verifierSchema("fix-auditor").properties.results.items.required.includes("fixVerdict"));
	// The dead introducedByChange path was removed from the reviewer schema: the
	// citation-gated provenance lane is the sole provenance mechanism.
	assert.ok(!REVIEWER_SCHEMA.properties.findings.items.required.includes("introducedByChange"));
	console.log("lanes and schemas: ok");
}

/** Blind projection: each lane sees only its own fields, shuffled deterministically per lane. */
{
	const claims = [{ file: "a.js", line: 1, claim: "c", scenario: "s", fixes: ["CANARY-FIX"], reviewerPriority: "P0", evidence: [{ file: "e", quote: "CANARY-EVID" }] }];
	for (const [laneId, fields] of [
		["reproducer", ["file", "line", "claim", "scenario"]],
		["skeptic", ["file", "line", "claim", "scenario"]],
		["consistency", ["file", "line", "claim", "scenario"]],
		["provenance", ["file", "line", "claim", "scenario"]],
		["impact", ["file", "line", "claim", "scenario"]],
	]) {
		const projected = projectForLane(laneId, claims);
		assert.deepEqual(Object.keys(projected[0]), fields, `projection of ${laneId}`);
		assert.ok(!JSON.stringify(projected).includes("CANARY-FIX"), `${laneId} never sees the fix`);
		assert.ok(!JSON.stringify(projected).includes("P0"), `${laneId} never sees the reviewer priority`);
		assert.ok(!JSON.stringify(projected).includes("CANARY-EVID"), `${laneId} never sees the reviewer evidence`);
	}
	const fixAudit = projectForLane("fix-auditor", claims);
	assert.deepEqual(fixAudit[0].fixes, ["CANARY-FIX"]);
	// The simplifier audits the proposed simplification, which IS the fix: its
	// projection carries fixes (and the scenario argument) like the fix-auditor's.
	const simplifierProjection = projectForLane("simplifier", claims);
	assert.deepEqual(simplifierProjection[0].fixes, ["CANARY-FIX"]);
	assert.deepEqual(Object.keys(simplifierProjection[0]), ["file", "line", "claim", "scenario", "fixes"]);
	assert.ok(!JSON.stringify(simplifierProjection).includes("P0"), "the simplifier never sees the reviewer priority");
	// The seeded shuffle is deterministic per (seed, lane) and differs across
	// lanes. Distinct claims per group make each report's owner genuinely
	// identifiable from its text, so the refs must map back to the group the
	// report carries — a refs-mapped-by-order regression cannot pass.
	const groups = Array.from({ length: 6 }, (_, i) => ({ groupId: `g${i + 1}`, claims: [{ file: "a.js", line: 1, claim: `defect ${i + 1}`, scenario: "s" }] }));
	const skepticRuns = planLaneRuns("skeptic", groups, { chunkSize: 1, seed: "run" });
	const skepticRuns2 = planLaneRuns("skeptic", groups, { chunkSize: 1, seed: "run" });
	const consistencyRuns = planLaneRuns("consistency", groups, { chunkSize: 1, seed: "run" });
	assert.deepEqual(skepticRuns.map((run) => run.reports), skepticRuns2.map((run) => run.reports));
	for (const runs of [skepticRuns, consistencyRuns]) {
		for (const run of runs) {
			assert.deepEqual(
				[...run.refMap.entries()],
				run.reports.map((report, i) => [`C${i + 1}`, groups.find((group) => report.includes(group.claims[0].claim)).groupId]),
				`${run.laneId} chunk ${run.chunkIndex}: each ref maps to the report's owner`,
			);
		}
	}
	// Six groups with chunkSize 1 shuffle differently per (seed, lane): the lanes
	// see different neighbors and positions, as the seed contract documents.
	assert.notDeepEqual(skepticRuns.map((run) => run.reports), consistencyRuns.map((run) => run.reports));
	console.log("blind projection: ok");
}

/** runAgent answers not-ok when a worker resolves completed across the composed
 * signal — the outer cancel or the per-run timeout — so the configured limit
 * stays hard and the caller re-runs the worker; the disposal-on-abort wiring
 * cancels the worker either way. */
{
	const lateRun = (resolveIn, disposed) => ({
		childId: "child-late",
		result: new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [] }, output: "" }), resolveIn)),
		dispose: async () => {
			disposed.count += 1;
		},
	});
	const lateCtx = (resolveIn, disposed) => ({
		subagents: {
			getProvider: () => ({
				capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
				inheritsParentContext: false,
			}),
			startActivation: async () => lateRun(resolveIn, disposed),
		},
		get: () => undefined,
		tools: { get: () => ({}) },
	});
	const settings = { reviewerProvider: "spawn", reviewerTools: ["bash"], reviewerTimeoutMs: 600_000 };

	// An already-cancelled caller signal: not-ok ("was cancelled"), re-run by
	// the caller's retry. (An already-aborted signal fires no new listeners, so
	// the disposal here comes from the finally.)
	{
		const disposed = { count: 0 };
		const controller = new AbortController();
		controller.abort();
		const cancelled = await runAgent({
			ctx: lateCtx(0, disposed),
			settings, kind: "reviewer", label: "l", prompt: "p", persona: "x", outputSchema: {}, signal: controller.signal,
		});
		assert.equal(cancelled.ok, false);
		assert.match(cancelled.reason, /was cancelled/);
		assert.ok(disposed.count >= 1, "a cancelled worker is disposed");
	}

	// A cancel that lands mid-run: the abort listener disposes the worker (the
	// manager does not watch the published signal itself), and the completed
	// result that races the abort still answers not-ok.
	{
		const disposed = { count: 0 };
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		const cancelled = await runAgent({
			ctx: lateCtx(60, disposed),
			settings, kind: "reviewer", label: "l", prompt: "p", persona: "x", outputSchema: {}, signal: controller.signal,
		});
		assert.equal(cancelled.ok, false);
		assert.match(cancelled.reason, /was cancelled/);
		assert.ok(disposed.count >= 1, "a mid-run cancelled worker is disposed");
	}

	// The worker resolves completed across the per-run timeout: not-ok with the
	// timeout diagnostic — the configured limit stays hard, and the deadline
	// disposal landed (the abort listener fired before the result resolved).
	{
		const disposed = { count: 0 };
		const timedOut = await runAgent({
			ctx: lateCtx(60, disposed),
			settings: { ...settings, reviewerTimeoutMs: 20 }, kind: "reviewer", label: "l", prompt: "p", persona: "x", outputSchema: {}, signal: new AbortController().signal,
		});
		assert.equal(timedOut.ok, false);
		assert.match(timedOut.reason, /timed out/);
		assert.ok(disposed.count >= 1, "a timed-out worker is disposed");
	}

	// Control: no abort, worker resolving completed → ok. (runAgent's callers
	// always pass a composed signal, so the control carries a fresh one.)
	{
		const disposed = { count: 0 };
		const ok = await runAgent({
			ctx: lateCtx(0, disposed),
			settings, kind: "reviewer", label: "l", prompt: "p", persona: "x", outputSchema: {}, signal: new AbortController().signal,
		});
		assert.equal(ok.ok, true);
		assert.equal(disposed.count, 1, "a settled worker is disposed exactly once");
	}

	// The stop-reason ladder: the runtime's settlement reasons in a reader's
	// words. A bare "error" with no diagnostic and no capture is the runtime's
	// conversion of a worker whose turn completed without the structured_output
	// call (captureLocalResult); max-tokens and refusal name themselves; a
	// provider error WITH a diagnostic keeps the old wording plus the
	// diagnostic. Every result also carries the containment notes (this ctx
	// resolves no agents registry, so the note is the unresolved-child one).
	{
		const ladderCtx = (outcome) => ({
			subagents: {
				getProvider: () => ({ capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true }, inheritsParentContext: false }),
				startActivation: async () => ({ childId: "child-ladder", result: Promise.resolve(outcome), dispose: async () => {} }),
			},
			get: () => undefined,
			tools: { get: () => ({}) },
		});
		const run = (outcome) => runAgent({
			ctx: ladderCtx(outcome),
			settings, kind: "reviewer", label: "l", prompt: "p", persona: "x", outputSchema: {}, signal: new AbortController().signal,
		});
		const noStructured = await run({ stopReason: "error", output: "a prose summary" });
		assert.equal(noStructured.ok, false);
		assert.match(noStructured.reason, /finished without reporting its structured result/);
		assert.doesNotMatch(noStructured.reason, /stopped with/);
		const maxTokens = await run({ stopReason: "max-tokens" });
		assert.match(maxTokens.reason, /ran out of output tokens \(max-tokens\)/);
		const refusal = await run({ stopReason: "refusal" });
		assert.match(refusal.reason, /was blocked \(refusal\)/);
		const diagnosed = await run({ stopReason: "error", diagnostic: "connection reset" });
		assert.match(diagnosed.reason, /stopped with "error": connection reset/);
		const uncontained = await run({ stopReason: "max-tokens" });
		assert.match(uncontained.containment, /the agents registry publishes no in-process child to contain/);
	}
	console.log("runAgent abort: ok");
}

/** The containment install against the REAL tools service: the allow-list
 * restricts on the child's own scope (a Service shadow keyed by the child's
 * scope context), the guard enforces per command through the real guard
 * waterfall, the two install independently, and every degradation returns a
 * note instead of dying in a stdout-only warn. The live phyle run showed a
 * deployment where neither install engaged — 18 workers, zero denials, scratch
 * files written into the reviewed tree. */
{
	const { ToolRuntime } = await import("@deepseek-ai/dsh-tools");
	const { createScope } = await import("@deepseek-ai/dsh-scope");
	const stubDefinition = (name) => ({
		name,
		description: `stub ${name}`,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		output: {
			schema: { type: "object", properties: { ok: { type: "boolean" } }, required: [], additionalProperties: false },
			render: () => [{ type: "text", text: "ok" }],
		},
	});
	const loggerWarnings = [];
	const logger = { warn: (error) => loggerWarnings.push(error) };

	// The happy path on the real service: the restriction lands on the child's
	// scope (a non-allow tool becomes invisible), and the guard denies through
	// the real guardReason waterfall while read-only commands pass.
	{
		const ctx = new Context();
		ctx.provide("systemPrompt", { tools() {}, section() {}, getSectionOrder: () => 0 });
		// The ToolRuntime fiber is the ancestor the child's scope resolves the
		// service through; the stubs register in its unscoped (global) layer, so
		// the child's view inherits them as restrictable names — the harness's
		// own composition shape.
		const toolsFiber = ctx.plugin(ToolRuntime);
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const name of ["bash", "read", "grep", "glob", "edit"]) toolsFiber.ctx.tools.register(stubDefinition(name));
		const childAgent = { id: "child-real" };
		const scope = createScope(toolsFiber.ctx, childAgent);
		childAgent.ctx = scope.ctx;
		await new Promise((resolve) => setTimeout(resolve, 0));
		const deps = {
			ctx: { get: (name) => (name === "agents" ? { get: (id) => (id === childAgent.id ? childAgent : undefined) } : undefined) },
			childId: childAgent.id,
			allow: ["bash", "read", "grep", "glob"],
			guardProfile: "static",
			logger,
		};
		assert.deepEqual(installWorkerContainment(deps), [], "a resolvable child with a real tool view fully contains");
		const childTools = childAgent.ctx.tools;
		assert.equal(childTools.view(childAgent).visible.has("edit"), false, "the allow-list restricted the non-allow tool away");
		assert.match(childTools.guardReason({ name: "bash", arguments: { command: "cat > /Users/apcamargo/Downloads/pwn.txt" }, agent: childAgent }), /deep-review worker guard/, "the installed guard denies a tree write");
		assert.equal(childTools.guardReason({ name: "bash", arguments: { command: "git log --oneline" }, agent: childAgent }), undefined, "read-only commands pass the installed guard");
		assert.deepEqual(loggerWarnings, [], "the happy path warns nothing");
	}

	// A restrict throw must not skip the guard: the independent installs keep
	// the per-command enforcement and name the degradation.
	{
		const guards = [];
		const child = {
			id: "child-throws",
			ctx: { tools: {
				restrict() { throw new Error('tools.restrict() names unknown global tool "glob"'); },
				guard(fn) { guards.push(fn); },
			} },
		};
		const notes = installWorkerContainment({
			ctx: { get: (name) => (name === "agents" ? { get: (id) => (id === child.id ? child : undefined) } : undefined) },
			childId: child.id,
			allow: ["bash", "read", "grep", "glob"],
			guardProfile: "static",
			logger: { warn() {} },
		});
		assert.match(notes[0], /the tool restriction failed: .*unknown global tool/);
		assert.equal(guards.length, 1, "the guard still installs when restrict throws");
		assert.match(guards[0]({ name: "bash", arguments: { command: "python3 x.py" } }), /guard/, "the installed guard still denies");
	}

	// A child whose view restricts nothing: the restriction is skipped with a
	// note and restrict is never called, while the guard still installs.
	{
		let restrictCalled = false;
		const guards = [];
		const child = {
			id: "child-opaque",
			ctx: { tools: {
				view: () => ({ restrictableNames: new Set() }),
				restrict() { restrictCalled = true; },
				guard(fn) { guards.push(fn); },
			} },
		};
		const notes = installWorkerContainment({
			ctx: { get: (name) => (name === "agents" ? { get: (id) => (id === child.id ? child : undefined) } : undefined) },
			childId: child.id,
			allow: ["bash"],
			guardProfile: "static",
			logger: { warn() {} },
		});
		assert.deepEqual(notes, ["none of the reviewer tools are restrictable on the child's tool view"]);
		assert.equal(restrictCalled, false, "restrict is not called with an empty allow-list");
		assert.equal(guards.length, 1, "the guard still installs when nothing is restrictable");
	}

	// An unresolvable child (a remote-provider run): one note, no throw.
	{
		const notes = installWorkerContainment({
			ctx: { get: () => undefined },
			childId: "child-remote",
			allow: ["bash"],
			guardProfile: "static",
			logger: { warn() {} },
		});
		assert.deepEqual(notes, ["the agents registry publishes no in-process child to contain (remote providers keep none)"]);
	}
	console.log("worker containment: ok");
}

// The shared verify pool: one in-flight budget across both lane kinds (so the
// verify phase holds the same number of simultaneous agents as the scan), with
// the executing lanes' working-tree sub-cap enforced inside it.
{
	const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

	// The total bound: 5 items over a pool of 2 never exceed 2 in flight, and
	// the results land in input order.
	{
		let inFlight = 0;
		let peak = 0;
		const settled = await mapPoolTotal([1, 2, 3, 4, 5], (n) => `g${n}`, { total: 2 }, async (n) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await tick();
			inFlight--;
			return { ok: true, n };
		});
		assert.equal(peak, 2, `pool of 2 peaked at ${peak}`);
		assert.deepEqual(settled.map((value) => value.n), [1, 2, 3, 4, 5]);
	}

	// The sub-cap: with `executing` capped at 1 inside a pool of 4, at most one
	// executing item runs at once, AND the forward scan lets the static items
	// behind a capped-out executing item start anyway (a throttled group cannot
	// block an eligible later item) — the whole set still completes.
	{
		let executingInFlight = 0;
		let executingPeak = 0;
		let staticPeak = 0;
		let staticInFlight = 0;
		const items = [
			{ kind: "executing", id: 1 }, { kind: "executing", id: 2 },
			{ kind: "static", id: 3 }, { kind: "static", id: 4 },
			{ kind: "executing", id: 5 }, { kind: "static", id: 6 },
		];
		const settled = await mapPoolTotal(items, (item) => item.kind, { total: 4, perGroup: { executing: 1 } }, async (item) => {
			if (item.kind === "executing") {
				executingInFlight++;
				executingPeak = Math.max(executingPeak, executingInFlight);
			} else {
				staticInFlight++;
				staticPeak = Math.max(staticPeak, staticInFlight);
			}
			await tick();
			if (item.kind === "executing") executingInFlight--;
			else staticInFlight--;
			return { ok: true, id: item.id };
		});
		assert.equal(executingPeak, 1, `executing sub-cap held (peaked at ${executingPeak})`);
		assert.ok(staticPeak > 1, `static items ran past the throttled executing group (peak ${staticPeak})`);
		assert.deepEqual(settled.map((value) => value.id), [1, 2, 3, 4, 5, 6]);
	}

	// No starvation: every remaining item belongs to a sub-capped group — with
	// nothing else in flight the group always has room, so the queue drains.
	{
		const settled = await mapPoolTotal([1, 2, 3], () => "executing", { total: 3, perGroup: { executing: 2 } }, async (n) => {
			await tick();
			return { ok: true, n };
		});
		assert.deepEqual(settled.map((value) => value.n), [1, 2, 3]);
	}

	// A throwing callback lands as a dropped {ok:false} value in its slot; the
	// pool still settles every other item.
	{
		const settled = await mapPoolTotal([1, 2, 3], () => "", { total: 2 }, async (n) => {
			if (n === 2) throw new Error("pool callback boom");
			await tick();
			return { ok: true, n };
		});
		assert.equal(settled[0].ok, true);
		assert.equal(settled[1].ok, false);
		assert.match(settled[1].reason, /pool callback boom/);
		assert.equal(settled[2].ok, true);
	}
	console.log("shared pool: ok");
}

/** runAgent resolves the configured reviewer tools against the CALLING agent's
 * tool view (get(name, parent)) — never the host composition's global layer,
 * and applies the resolved allow-list to the child's own scope (the 0.2.1
 * replacement for the removed start-time toolFilter). A web deployment
 * registers every model-facing tool behind per-session presets on the agent
 * plane, so a no-scope lookup reads "bash" as absent and every worker of a
 * passing session fails the check below. */
{
	const callingAgent = { id: "orchestrator" };
	const allowLists = [];
	const guardFns = [];
	const childTools = {
		restrict(filter) { allowLists.push(filter?.allow); },
		guard(fn) { guardFns.push(fn); },
	};
	let resolvedScope;
	const presetScopedToolsCtx = {
		subagents: {
			getProvider: () => ({
				capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
				inheritsParentContext: false,
			}),
			startActivation: async () => ({
				childId: "child-1",
				result: Promise.resolve({ stopReason: "completed", structured: { findings: [] }, output: "" }),
				dispose: async () => {},
			}),
		},
		// The agents registry: the fleet resolves the child here to install its
		// containment (the activation receipt publishes no localAgent).
		get(name) {
			return name === "agents" ? { get: () => ({ ctx: { tools: childTools } }) } : undefined;
		},
		// The web-profile shape: the global layer is empty; the preset scope
		// (an ancestor of the calling agent's scope) carries the tools.
		tools: {
			get(name, scope) {
				resolvedScope = scope;
				return scope === callingAgent && ["bash", "read", "grep", "glob"].includes(name) ? { name } : undefined;
			},
		},
	};
	const settings = { reviewerProvider: "spawn", reviewerTools: ["bash", "read", "grep", "glob"], reviewerTimeoutMs: 600_000 };

	// The check resolves against the calling agent: the same object the callers
	// pass as `parent`, so the preset-scope tools are visible and the worker's
	// scope is restricted to the configured allow list.
	const ok = await runAgent({ ctx: presetScopedToolsCtx, settings, kind: "reviewer", label: "l", prompt: "p", persona: "x", outputSchema: {}, parent: callingAgent, signal: new AbortController().signal });
	assert.equal(ok.ok, true);
	assert.deepEqual(resolvedScope, callingAgent);
	assert.deepEqual(allowLists.at(-1), ["bash", "read", "grep", "glob"]);
	assert.equal(guardFns.length, 1);

	// A tool absent from the calling agent's view fails loud — a genuinely
	// missing tool (not the global-layer shape) still errors with its name.
	const missing = await runAgent({ ctx: presetScopedToolsCtx, settings: { ...settings, reviewerTools: ["bash", "unavailable-tool"] }, kind: "reviewer", label: "l", prompt: "p", persona: "x", outputSchema: {}, parent: callingAgent, signal: new AbortController().signal });
	assert.equal(missing.ok, false);
	assert.match(missing.reason, /"unavailable-tool" is not visible to this session/);
	console.log("runAgent tool view: ok");
}

// ---------------------------------------------------------------------------
// Runtime over a real Cordis context
// ---------------------------------------------------------------------------

/** One temp git repository with the changed file the reviewers cite. */
const repoRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-fleet-repo-"));
try {
	const git = async (...args) => {
		const result = await runProcess({ subprocess }, ["git", ...args], repoRoot, undefined);
		assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	};
	await mkdir(path.join(repoRoot, "src"), { recursive: true });
	await writeFile(path.join(repoRoot, "src", "auth.js"), "function auth(token) {\n  try {\n" + BUG_QUOTE + "\n  } catch {}\n}\n");
	await git("init", "-b", "main");
	await git("config", "user.email", "test@example.com");
	await git("config", "user.name", "Test");
	await git("add", ".");
	await git("commit", "-m", "initial");
	// The change under review: modify auth.js so the working tree is dirty.
	await writeFile(
		path.join(repoRoot, "src", "auth.js"),
		"function auth(token) {\n  try {\n" + BUG_QUOTE + "\n  } catch {}\n}\nfunction auth2(token) {\n  try {\n" + BUG_QUOTE + "\n  } catch {}\n}\n",
	);

	/** The deep review flow end to end, with canaries. */
	{
		const harness = await makeHarness({ cwd: repoRoot });
		const { ctx, agent, started, toolRegistry, steers, commands } = harness;

		// /review --deep: the orchestrator prompt carries the fleet protocol.
		const start = await runCommandFn(commands, agent, "review", "uncommitted --deep --aggressive");
		assert.equal(start.kind, "success");
		assert.match(start.text, /Deep review started.*\(deep\).*fleet of up to 15 reviewers/);
		assert.equal(agent.followups.length, 1);
		const orchestratorPrompt = agent.followups[0].content[0].text;
		assert.match(orchestratorPrompt, /deep_review_scan/);
		assert.match(orchestratorPrompt, /# Deep review orchestration/);
		assert.match(orchestratorPrompt, /Aggressive mode/);

		// Only this session sees the deep tools.
		assert.deepEqual(toolRegistry.registry.registered.map((entry) => entry.name).sort(), ["deep_review_scan", "deep_review_verify"]);

		// Scan: the fleet answers; raw findings, hints and coverage come back.
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.ok(scan.reviewersTotal >= 6, `roster: ${scan.reviewersTotal}`);
		assert.equal(scan.reviewersSucceeded, scan.reviewersTotal);
		assert.deepEqual(scan.findings.map((finding) => finding.id).sort(), ["R1.1", "R2.1"]);
		assert.deepEqual(scan.overlapHints, [["R1.1", "R2.1"]]);
		assert.ok(scan.sideEffects.length >= 1);
		assert.match(scan.roster.find((entry) => entry.lens === "correctness").state, /succeeded/);

		// Reviewer prompts carried the persona head, the rubric, the lens, and the
		// aggressive appendix — the persona is the fleet's own prompt prefix now
		// (the 0.2.1 start request has no persona field).
		const reviewerPrompt = started.find((record) => record.label.startsWith("deep review: correctness")).prompt;
		assert.ok(reviewerPrompt.startsWith(REVIEWER_PERSONA), "the reviewer persona prefixes the prompt");
		assert.match(reviewerPrompt, /Review Guidelines/);
		assert.match(reviewerPrompt, /Lens: correctness/);
		assert.match(reviewerPrompt, /Aggressive mode/);
		assert.match(reviewerPrompt, /whole change/);
		// Workers are fresh children of the orchestrator with restricted tools and a schema.
		assert.equal(started[0].parent, agent);
		// The allow-list is enforced on the child's own scope (tools.restrict),
		// one per started worker.
		assert.equal(harness.provider.restrictions.length, started.length);
		assert.ok(harness.provider.restrictions[0].filter.allow.includes("bash"));
		assert.ok(!harness.provider.restrictions[0].filter.allow.includes("edit"));
		assert.ok(started[0].outputSchema);
		// Workers were disposed and guarded.
		assert.ok(started.every((record) => record.disposed));
		assert.equal(harness.provider.guards.length, started.length);
		const guard = harness.provider.guards[0].fn;
		assert.match(guard({ name: "bash", arguments: { command: "rm -rf /" } }), /guard/);

		// Idempotent scan: a complete scan spawns nothing.
		const startedBefore = started.length;
		const again = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(started.length, startedBefore);
		assert.equal(again.reviewersTotal, scan.reviewersTotal);

		// Consolidation errors name the unaccounted ids before anything spawns.
		await assert.rejects(runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }] }), /not accounted for/);
		await assert.rejects(runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R9.9" }] }), /unknown finding id/);
		await assert.rejects(runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [] }), /at least one finding/);

		// The valid consolidation: group the bug, drop the parse finding with a canary reason.
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", {
			groups: [{ primary: "R1.1" }],
			dropped: [{ id: "R2.1", reason: "CANARY-DROP style-only" }],
		});
		assert.equal(verify.laneRuns, 6);
		assert.equal(verify.pendingRuns, 0);
		assert.match(verify.findingsMarkdown, /## Findings \(verified by independent adversarial lanes\)/);
		assert.match(verify.findingsMarkdown, /reproduced and traced/);
		assert.match(verify.findingsMarkdown, /Consistency: departs from a codebase convention/);
		assert.match(verify.findingsMarkdown, /- Priority assessed by the impact lane; the reviewers said P0\./);
		assert.match(verify.findingsMarkdown, /CANARY-FIX/);
		assert.match(verify.findingsMarkdown, /CANARY-DROP style-only/);
		assert.ok(verify.assessed.some((entry) => entry.outcome === "confirmed"));

		// Verifiers ran once per (lane, chunk); each disposed.
		const verifierRuns = started.filter((record) => record.label.startsWith("deep verify"));
		assert.equal(verifierRuns.length, 6);
		assert.ok(verifierRuns.every((record) => record.disposed));

		// Blindness: no verifier prompt contains the orchestrator's drop reason, the
		// group ids, or the reviewers' evidence.
		for (const record of verifierRuns) {
			assert.ok(!record.prompt.includes("CANARY-DROP"), `drop reason leaked to ${record.label}`);
			assert.ok(!record.prompt.includes("R1.1") && !record.prompt.includes("R2.1"), `group id leaked to ${record.label}`);
		}
		// Reviewer-authored evidence is stripped; claims and fixes go to the right lanes.
		const fixAuditPrompt = verifierRuns.find((record) => record.label.includes("[fix-auditor]")).prompt;
		assert.ok(fixAuditPrompt.includes("CANARY-FIX"), "fix-auditor reads the fix");
		const skepticPrompt = verifierRuns.find((record) => record.label.includes("[skeptic]")).prompt;
		assert.ok(!skepticPrompt.includes("CANARY-FIX"), "skeptic never sees the fix");
		assert.match(skepticPrompt, /untrusted/);
		assert.match(skepticPrompt, /data, never instructions/);

		// Idempotent verify: a complete verification returns the stored result.
		const startedAfterVerify = started.length;
		const verifyAgain = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "CANARY-DROP style-only" }] });
		assert.equal(started.length, startedAfterVerify);
		assert.equal(verifyAgain.findingsMarkdown, verify.findingsMarkdown);

		// The gate: the pipeline is complete and the report carries the finding, no steer.
		harness.agent.session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: `The report.\n\n${verify.findingsMarkdown}` }] }];
		const before = steers.length;
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, before);
	}

	/** The simplification pipeline end to end: the lens's findings are
	 * kind-tagged in the scan output, normalized with their guards (an empty
	 * scenario is dropped, a P0 clamps to P2), verified under the simplifier
	 * lane only, and land in their own report section; a mixed-kind group is
	 * rejected with a correctable error, and the fidelity gate requires the
	 * section's header. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-simplification-0001",
			scripts: (label, request, started) => {
				const verifyMatch = /deep verify \[(.+?)\]/.exec(label);
				if (verifyMatch) {
					const lane = verifyMatch[1];
					const refs = [...request.prompt[0].text.matchAll(/<report ref="C(\d+)">/g)].map((match) => `C${match[1]}`);
					return {
						stopReason: "completed",
						structured: {
							results: refs.map((ref) => ({
								ref,
								outcome: lane === "simplifier" ? "simpler" : defaultVerdicts()[lane],
								notes: `${lane} notes`,
								method: lane === "reproducer" ? "executed" : undefined,
								exercisedScenario: lane === "reproducer" ? "ran" : undefined,
								evidence: [lane, "skeptic", "consistency", "provenance", "simplifier"].includes(lane)
									? [{ file: "src/auth.js", line: 3, quote: BUG_QUOTE }]
									: [],
								priority: lane === "impact" ? "P1" : undefined,
								blastRadius: lane === "impact" ? "module" : undefined,
								fixVerdict: lane === "fix-auditor" ? "sound" : undefined,
							})),
						},
					};
				}
				const reviewMatch = /^deep review: (.+?)( \[shard \d+\/\d+\])?$/.exec(label);
				if (reviewMatch?.[1] === "simplification") {
					return {
						stopReason: "completed",
						structured: {
							findings: [
								// No behavior-preservation argument: dropped at normalization.
								{ priority: "P3", confidence: "high", title: "Collapse the guard chain", file: "src/auth.js", line: 5, claim: "The two nested ifs collapse into one guard.", scenario: "", evidence: [] },
								// The audited proposal.
								{ priority: "P3", confidence: "medium", title: "Inline the one-off helper", file: "src/auth.js", line: 5, claim: "The helper wraps a single call site and adds indirection only.", scenario: "Both callers pass the same constant; the wrapper returns its argument unchanged, so inlining preserves behavior.", evidence: [{ file: "src/auth.js", line: 3, quote: BUG_QUOTE }], suggestedFix: "Inline the helper's body at its single call site and delete the wrapper." },
							],
							sideEffects: [],
						},
					};
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { ctx, agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan.reviewersSucceeded, scan.reviewersTotal);
		// The simplification lens ran and its surviving finding is kind-tagged;
		// the empty-scenario finding never made it out of normalization.
		const simplFinding = scan.findings.find((finding) => finding.kind === "simplification");
		assert.ok(simplFinding, "the simplification finding carries the kind tag in the scan output");
		assert.match(simplFinding.claim, /helper wraps a single call site/);
		assert.ok(!scan.findings.some((finding) => finding.claim.includes("guard chain")), "the empty-scenario proposal was dropped");
		// The simplification reviewer's prompt carries the lens block with the shared principles.
		const simplPrompt = started.find((record) => record.label.startsWith("deep review: simplification")).prompt;
		assert.match(simplPrompt, /Lens: simplification/);
		assert.match(simplPrompt, /Maintain balance/);

		// A mixed-kind consolidation is rejected with a correctable error before
		// any verifier runs.
		const simplId = simplFinding.id;
		const defectId = scan.findings.find((finding) => !finding.kind)?.id;
		await assert.rejects(
			runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: defectId, mergedFrom: [simplId] }], dropped: [] }),
			/never merge kinds/,
			"the tool surfaces the correctable mixed-kind error",
		);
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", {
			groups: [{ primary: defectId }, { primary: simplId }],
			dropped: [{ id: "R2.1", reason: "style-only" }],
		});
		assert.equal(verify.pendingRuns, 0);
		// The defect finding verified under the defect lanes; the simplification
		// verified under the simplifier lane; each landed in its own section.
		assert.match(verify.findingsMarkdown, /## Findings \(verified by independent adversarial lanes\)/);
		assert.match(verify.findingsMarkdown, /reproduced and traced/);
		assert.match(verify.findingsMarkdown, /## Simplification Opportunities \(Non-Blocking\)/);
		assert.match(verify.findingsMarkdown, /single-lane audit: no behavior change found/);
		assert.match(verify.findingsMarkdown, /audited by the simplifier lane/);
		assert.ok(verify.findingsMarkdown.includes(simplFinding.claim), "the confirmed simplification renders titleOf(finding)");
		// The defect gating/corroboration/advisory lanes never ran over the
		// simplification group, and the simplifier never ran over the defect
		// group. (Provenance legitimately filters BOTH kinds.)
		const verifyRuns = started.filter((record) => record.label.startsWith("deep verify"));
		assert.ok(verifyRuns.some((record) => record.label.includes("[simplifier]")), "the simplifier lane ran");
		for (const record of verifyRuns.filter((entry) => !entry.label.includes("[simplifier]") && !entry.label.includes("[provenance]"))) {
			assert.ok(!record.prompt.includes("helper wraps a single call site"), `the simplification claim never reached ${record.label}`);
		}
		const simplifierRun = verifyRuns.find((record) => record.label.includes("[simplifier]"));
		assert.ok(!simplifierRun.prompt.includes("returns null instead of failing fast"), "the defect claim never reached the simplifier");
		assert.ok(simplifierRun.prompt.includes("Proposed fix:"), "the simplifier reads the proposed simplification");

		// The gate: the fidelity check runs ONCE, at the first stop after the
		// verification completed — a faithful report (both sections copied)
		// releases without steering.
		harness.agent.session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: `The report.\n\n${verify.findingsMarkdown}` }] }];
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(harness.steers.length, 0, "a faithful report (both sections copied) releases without steering");
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** A report that omits the simplification section costs exactly one
	 * fidelity steer naming it — the section always renders in the verified
	 * markdown, so its absence is detectable even when it reads "- (none)". */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-simplification-fidelity-0001",
			scripts: (label, request, started) => {
				const verifyMatch = /deep verify \[(.+?)\]/.exec(label);
				if (verifyMatch) {
					const lane = verifyMatch[1];
					const refs = [...request.prompt[0].text.matchAll(/<report ref="C(\d+)">/g)].map((match) => `C${match[1]}`);
					return {
						stopReason: "completed",
						structured: {
							results: refs.map((ref) => ({
								ref,
								outcome: lane === "simplifier" ? "not-simpler" : defaultVerdicts()[lane],
								notes: `${lane} notes`,
								method: lane === "reproducer" ? "executed" : undefined,
								exercisedScenario: lane === "reproducer" ? "ran" : undefined,
								evidence: [lane, "skeptic", "consistency", "provenance", "simplifier"].includes(lane)
									? [{ file: "src/auth.js", line: 3, quote: BUG_QUOTE }]
									: [],
								priority: lane === "impact" ? "P1" : undefined,
								blastRadius: lane === "impact" ? "module" : undefined,
								fixVerdict: lane === "fix-auditor" ? "sound" : undefined,
							})),
						},
					};
				}
				const reviewMatch = /^deep review: (.+?)( \[shard \d+\/\d+\])?$/.exec(label);
				if (reviewMatch?.[1] === "simplification") {
					return {
						stopReason: "completed",
						structured: {
							findings: [
								{ priority: "P3", confidence: "medium", title: "Inline the one-off helper", file: "src/auth.js", line: 3, claim: "The helper wraps a single call site and adds indirection only.", scenario: "The wrapper returns its argument unchanged, so inlining preserves behavior.", evidence: [{ file: "src/auth.js", line: 3, quote: BUG_QUOTE }] },
							],
							sideEffects: [],
						},
					};
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { ctx, agent, commands, toolRegistry, steers } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		// The first stop (nothing ran yet) costs one scan steer.
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 1);
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }, { primary: "R4.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		// The verification completed; the report omits the simplification
		// section (the simplification was refuted, so the section renders
		// "- (none)" and no title could catch its omission — only the header
		// check does).
		harness.agent.session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: "A report that omits the simplification section." }] }];
		ctx.emit("agent/turn-stopping", { agent, turn: 2, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 2);
		assert.match(steers[1].content[0].text, /Simplification Opportunities/, "the steer names the missing section");
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** A user who pinned deep.lenses to the pre-simplification six keeps their
	 * pinned set (README documents it): no simplification reviewer runs, and
	 * the report must say the audit did not happen — not "- (none)" over a
	 * description asserting the simplifier lane audited. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-simplification-pinned-0001",
			deep: { lenses: ["correctness", "failure-paths", "security", "contracts", "consistency", "propagation"] },
		});
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.ok(!scan.roster.some((entry) => entry.lens === "simplification"), "the pinned set runs no simplification reviewer");
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		assert.match(verify.findingsMarkdown, /## Simplification Opportunities \(Non-Blocking\)/);
		assert.doesNotMatch(verify.findingsMarkdown, /- \(none\)/);
		assert.match(verify.findingsMarkdown, /- \(not evaluated — the simplification lens is not in deep\.lenses; add it to enable this audit\)/);
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** A failed simplification reviewer above quorum must not render "- (none)":
	 * the audit did not run, so the section discloses the failed reviewer by id
	 * (the coverage line only counts), and the gate still releases — the
	 * disclosure is report content, and the fidelity check requires only the
	 * header and the confirmed titles. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-simplification-failed-0001",
			scripts: (label, request, started) => {
				if (/^deep review: simplification/.test(label)) return { stopReason: "error", diagnostic: "deterministic provider rejection" };
				return defaultScripts({})(label, request, started);
			},
		});
		const { ctx, agent, commands, toolRegistry, steers } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan.reviewersTotal, 7);
		assert.equal(scan.reviewersSucceeded, 6, "the scan counts above quorum with the simplification reviewer failed");
		assert.match(scan.roster.find((entry) => entry.lens === "simplification").state, /failed/);
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }, { primary: "R2.1" }], dropped: [] });
		assert.equal(verify.pendingRuns, 0);
		// The section discloses the audit that never ran — never "- (none)".
		assert.match(verify.findingsMarkdown, /- \(not evaluated — the simplification reviewer failed \(R4\); the audit did not run\. Re-run the review to retry it\)/);
		assert.doesNotMatch(verify.findingsMarkdown, /- \(none\)/);
		assert.match(verify.findingsMarkdown, /Coverage: 6\/7 reviewers succeeded/);
		// A faithful report (the disclosure copied with the section) releases without steering.
		harness.agent.session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: `The report.\n\n${verify.findingsMarkdown}` }] }];
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 0, "the truthful disclosure releases without steering");
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** A simplification reviewer healed by a scan re-call between a PARTIAL
	 * verify call and the completing verify re-call must not flip the shipped
	 * disclosure to "- (none)": the audit state is sampled once, at the first
	 * verify call (the roster that produced the consolidation), so the healed
	 * reviewer's unconsolidated finding can never ride under a claim that the
	 * audit ran and found nothing. The scan re-call is sanctioned mid-verify
	 * (both tools stay registered; the spent-scan banner invites it), and the
	 * same-groups re-call skips revalidation, so without the snapshot the
	 * completing call would render "- (none)" over a finding that exists in
	 * rawFindings and appears in no group. */
	{
		const attempts = new Map();
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-simplification-heal-0001",
			scripts: (label, request, started) => {
				const attempt = (attempts.get(label) ?? 0) + 1;
				attempts.set(label, attempt);
				// The simplification reviewer fails both in-call attempts on scan
				// call 1 and succeeds on the healing scan re-call.
				if (label === "deep review: simplification") {
					if (attempt <= 2) return { stopReason: "error", diagnostic: "deterministic provider rejection" };
					return {
						stopReason: "completed",
						structured: {
							findings: [{
								priority: "P3", confidence: "medium", title: "Inline the one-off helper",
								file: "src/auth.js", line: 3,
								claim: "The helper wraps a single call site and adds indirection only.",
								scenario: "The wrapper returns its argument unchanged, so inlining preserves behavior.",
								evidence: [{ file: "src/auth.js", line: 3, quote: BUG_QUOTE }],
							}],
							sideEffects: [],
						},
					};
				}
				// The reproducer unit fails both in-call attempts on verify call 1
				// (leaving the verification partial) and succeeds on the re-call.
				if (/^deep verify \[reproducer\]/.test(label) && attempt <= 2) {
					return { stopReason: "error", diagnostic: "deterministic provider rejection" };
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan1 = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan1.reviewersSucceeded, 6, "scan call 1 leaves the simplification reviewer failed above quorum");
		const verify1 = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }, { primary: "R2.1" }], dropped: [] });
		assert.equal(verify1.pendingRuns, 1, "verify call 1 stays partial on the failed reproducer unit");
		const scan2 = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan2.reviewersSucceeded, 7, "the healing scan re-call succeeds the simplification reviewer");
		// The same-groups re-call skips revalidation even though the healed
		// reviewer added R4.1 to rawFindings — the finding can never join this
		// verification.
		const verify2 = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }, { primary: "R2.1" }], dropped: [] });
		assert.equal(verify2.pendingRuns, 0);
		// The shipped disclosure is the snapshot from the first verify call: the
		// simplification reviewer was lost when the consolidation was built.
		assert.match(verify2.findingsMarkdown, /- \(not evaluated — the simplification reviewer failed \(R4\); the audit did not run\. Re-run the review to retry it\)/);
		assert.doesNotMatch(verify2.findingsMarkdown, /- \(none\)/);
		assert.ok(!verify2.findingsMarkdown.includes("The helper wraps a single call site"), "the healed finding never rides under the audit-ran disclosure");
		// The coverage line reflects the healed roster (the scan re-call recomputed
		// it) while the disclosure stays scoped to the verification that shipped.
		assert.match(verify2.findingsMarkdown, /Coverage: 7\/7 reviewers succeeded/);
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** A working-tree edit between the scan and the verify surfaces at verify
	 * time — the integrity check lives at verify time (the scan-side snapshot
	 * only feeds this treeDiff): the verify value names the mid-review change
	 * and the findings markdown carries the stale-lines warning. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-midreview-edit-0001" });
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		await writeFile(path.join(repoRoot, "src", "midreview.js"), "export {}\n");
		try {
			const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
			assert.deepEqual(verify.treeChanged, ["src/midreview.js"], "the mid-review edit is named");
			assert.match(verify.findingsMarkdown, /working tree changed during review/);
			assert.match(verify.findingsMarkdown, /src\/midreview\.js/, "the stale-lines warning names the edit");
		} finally {
			await rm(path.join(repoRoot, "src", "midreview.js"), { force: true });
		}
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** The gate steers an orchestrator that stops early; the pause is per turn,
	 * the steer budget releases with the incomplete marker, and the marker clears
	 * when the pipeline later completes. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-gate-0001" });
		const { ctx, agent, commands, steers, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 1);
		assert.match(steers[0].content[0].text, /deep_review_scan/);

		// A user message claimed in the turn pauses the gate for that turn only.
		ctx.emit("agent/inbox/claimed", { agent, message: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "hold on" }] }, turn: 1 });
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 1, "paused turn does not steer");

		// Another turn steers again; after two steers the gate releases with incomplete.
		ctx.emit("agent/turn-stopping", { agent, turn: 2, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 2);
		ctx.emit("agent/turn-stopping", { agent, turn: 3, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 2, "the third stop releases without steering");
		const status = await runCommandFn(commands, agent, "review", "status");
		assert.match(status.text, /Incomplete: the deep review pipeline did not complete/);
		assert.match(status.text, /Pipeline: scan none, verify none/);

		// A mid-pipeline release marker is cleared when the pipeline later completes.
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "CANARY-DROP style-only" }] });
		assert.doesNotMatch((await runCommandFn(commands, agent, "review", "status")).text, /Incomplete/);
	}

	/** Steering reaches workers started after it, and only the user's messages. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-steer-0001", deep: { maxSteeringEntries: 3 } });
		const { ctx, agent, commands, started, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		assert.ok(started.filter((record) => record.label.startsWith("deep review")).every((record) => !record.prompt.includes("CANARY-STEER")), "no steering before the user spoke");

		// The user types before the scan tool call (the /review --deep handler
		// only begins the run), so the scan workers capture the block too, and
		// the verifiers ride as well.
		ctx.emit("agent/inbox/inserted", { agent, message: { id: "s1", source: { kind: "user" }, content: [{ type: "text", text: "CANARY-STEER prioritize the auth path" }] } });
		// Plugin and gate messages are excluded; another agent's user message is excluded.
		ctx.emit("agent/inbox/inserted", { agent, message: { id: "s2", source: { kind: "apcamargo-dsh-review" }, content: [{ type: "text", text: "CANARY-PLUGIN" }] } });
		ctx.emit("agent/inbox/inserted", { agent: { id: "session-other" }, message: { id: "s3", source: { kind: "user" }, content: [{ type: "text", text: "CANARY-OTHER-AGENT" }] } });

		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		const verifierPrompts = started.filter((record) => record.label.startsWith("deep verify")).map((record) => record.prompt);
		assert.ok(verifierPrompts.every((prompt) => prompt.includes("CANARY-STEER")), "steering rides to every verifier");
		assert.ok(verifierPrompts.every((prompt) => !prompt.includes("CANARY-PLUGIN") && !prompt.includes("CANARY-OTHER-AGENT")));
		assert.match(verify.findingsMarkdown, /Steering received/);
	}

	/** A user message inserted DURING a pool call reaches workers whose prompt
	 * builds after it — the block re-reads at build time, not once per call. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-steer-midcall-0001",
			// Wave 1 (concurrency 3) sleeps past the insert; wave 2 builds after.
			scripts: (label, request, started) => {
				if (started <= 4) return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }), 300));
				return defaultScripts({})(label, request, started);
			},
		});
		const { ctx, agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scanPromise = runToolFn(toolRegistry, agent, "deep_review_scan", {});
		// Insert while the scan pool is in flight: wave 1 (4 reviewers) is still
		// sleeping, wave 2's prompts build after the insert.
		await new Promise((resolve) => setTimeout(resolve, 100));
		ctx.emit("agent/inbox/inserted", { agent, message: { id: "mid1", source: { kind: "user" }, content: [{ type: "text", text: "CANARY-MIDCALL prioritize the auth path" }] } });
		await scanPromise;
		const reviewers = started.filter((record) => record.label.startsWith("deep review"));
		const late = reviewers.filter((record) => record.prompt.includes("CANARY-MIDCALL"));
		const early = reviewers.filter((record) => !record.prompt.includes("CANARY-MIDCALL"));
		assert.ok(late.length >= 1, `a later wave re-read the block: ${late.length}`);
		assert.ok(early.length >= 1, `the first wave built before the insert: ${early.length}`);
	}

	/** A zero-findings scan completes with an explicit empty consolidation:
	 * verify accepts groups [] when rawFindings is empty, the gate releases
	 * without the incomplete marker, and an idempotent re-call returns it. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-empty-consolidation-0001",
			scripts: () => ({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }),
		});
		const { ctx, agent, commands, toolRegistry, steers } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan.reviewersSucceeded, scan.reviewersTotal);
		assert.equal(scan.findings.length, 0);
		// The complyable close: the empty consolidation is accepted.
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [], dropped: [] });
		assert.equal(verify.pendingRuns, 0);
		assert.match(verify.findingsMarkdown, /## Findings \(verified by independent adversarial lanes\)/);
		assert.match(verify.findingsMarkdown, /No findings survived verification/);
		assert.equal(verify.assessed.length, 0);
		// The gate releases without steering and without the incomplete marker.
		harness.agent.session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: `The report.\n\n${verify.findingsMarkdown}` }] }];
		const before = steers.length;
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, before);
		assert.doesNotMatch((await runCommandFn(commands, agent, "review", "status")).text, /Incomplete/);
		// An idempotent empty re-call returns the stored markdown.
		const verifyAgain = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [], dropped: [] });
		assert.equal(verifyAgain.findingsMarkdown, verify.findingsMarkdown);
	}

	/** An everything-dropped consolidation also closes the pipeline: the old
	 * advertised "skip deep_review_verify" escape was impossible. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-everything-dropped-0001" });
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", {
			groups: [],
			dropped: [{ id: "R1.1", reason: "CANARY-DROP style-only" }, { id: "R2.1", reason: "CANARY-DROP no realistic scenario" }],
		});
		assert.equal(verify.pendingRuns, 0);
		assert.match(verify.findingsMarkdown, /## Dropped during consolidation/);
		assert.match(verify.findingsMarkdown, /CANARY-DROP style-only/);
		// A non-empty-groups re-call after completion still names the protocol violation.
		await assert.rejects(
			runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] }),
			/different groups/,
		);
	}

	/** The verify inputHash is normalized: a re-call whose only change is a
	 * reworded drop reason or a reordered consolidation finishes pending
	 * workers instead of throwing; genuinely different args after completion
	 * name the difference; an idempotent re-call returns the stored result.
	 * The consolidation carries two groups and one dropped finding, so one
	 * re-call pins both normalization facets (reasons excluded from the hash,
	 * order sorted away). */
	{
		const failCounts = new Map();
		const base = defaultScripts({
			reviewFindings: (lens) => {
				const usual = reviewerScript(lens);
				if (lens === "failure-paths") {
					// A third raw finding so the consolidation can group two and drop one.
					usual.structured.findings.push({ priority: "P3", confidence: "low", title: "Style drift", file: "src/auth.js", line: 8, claim: "The duplicated try/catch body drifts from the first function's style.", scenario: "The second function's silent recovery reads differently from the first.", evidence: [{ file: "src/auth.js", line: 8, quote: BUG_QUOTE }] });
				}
				return usual;
			},
		});
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-verify-hash-0001",
			scripts: (label, request, started) => {
				const match = /deep verify \[(.+?)\]/.exec(label);
				if (match?.[1] === "impact") {
					const n = (failCounts.get("impact") ?? 0) + 1;
					failCounts.set("impact", n);
					// Fail both in-call attempts (unit + retry) so the verification stays partial.
					if (n <= 2) return { stopReason: "error", diagnostic: "boom" };
				}
				return base(label, request, started);
			},
		});
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		const partial = await runToolFn(toolRegistry, agent, "deep_review_verify", {
			groups: [{ primary: "R1.1" }, { primary: "R2.1" }],
			dropped: [{ id: "R2.2", reason: "style-only" }],
		});
		assert.ok(partial.pendingRuns > 0, `partial: ${partial.pendingRuns}`);
		// The reworded reason and the reordered groups match the id-only,
		// order-insensitive hash: the pending run finishes.
		const finished = await runToolFn(toolRegistry, agent, "deep_review_verify", {
			groups: [{ primary: "R2.1" }, { primary: "R1.1" }],
			dropped: [{ id: "R2.2", reason: "a linter will catch it" }],
		});
		assert.equal(finished.pendingRuns, 0);
		assert.ok(finished.findingsMarkdown.includes("reproduced and traced"));
		// After completion, a genuinely different consolidation throws instead of
		// silently returning the stale stored result.
		await assert.rejects(
			runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1", mergedFrom: ["R2.1"] }], dropped: [] }),
			/different groups/,
		);
		// An idempotent re-call returns the stored result.
		const again = await runToolFn(toolRegistry, agent, "deep_review_verify", {
			groups: [{ primary: "R2.1" }, { primary: "R1.1" }],
			dropped: [{ id: "R2.2", reason: "a linter will catch it" }],
		});
		assert.equal(again.pendingRuns, 0);
	}

	/** A partial verification: a failed lane is retried, then the run completes. */
	{
		const failCounts = new Map();
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-partial-verify-0001",
			scripts: (label, request, started) => {
				const match = /deep verify \[(.+?)\]/.exec(label);
				if (match?.[1] === "skeptic") {
					const n = (failCounts.get("skeptic") ?? 0) + 1;
					failCounts.set("skeptic", n);
					if (n <= 2) return { stopReason: "error", diagnostic: "boom" };
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		assert.equal(verify.pendingRuns, 1);
		assert.match(verify.findingsMarkdown, /## Withheld \(raised but unverified\)/);
		// A re-call with different groups after a partial names the difference.
		await assert.rejects(
			runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1", mergedFrom: ["R2.1"] }], dropped: [] }),
			/different groups/,
		);
		// A re-call with the same groups finishes only the failed run.
		const verify2 = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		assert.equal(verify2.pendingRuns, 0);
		assert.ok(verify2.findingsMarkdown.includes("reproduced and traced"));
		// The failed skeptic unit ran exactly three times (unit, retry, re-call).
		assert.equal(failCounts.get("skeptic") + (started.filter((record) => record.label.includes("[skeptic]")).length - failCounts.get("skeptic")), 3);
	}

	/** Two sessions run separate deep reviews; ending one leaves the other. */
	{
		const harnessA = await makeHarness({ cwd: repoRoot, id: "session-two-a" });
		const harnessB = await makeHarness({ cwd: repoRoot, id: "session-two-b" });
		await runCommandFn(harnessA.commands, harnessA.agent, "review", "uncommitted --deep");
		await runCommandFn(harnessB.commands, harnessB.agent, "review", "uncommitted --deep");
		await runToolFn(harnessA.toolRegistry, harnessA.agent, "deep_review_scan", {});
		const startedBefore = harnessB.started.length;
		await runToolFn(harnessB.toolRegistry, harnessB.agent, "deep_review_scan", {});
		assert.ok(harnessB.started.length > startedBefore);
		// Ending A disposes A's scope and tools, not B's.
		const endReview = harnessA.commands.registered.find((entry) => entry.name === "end-review");
		await endReview.handler({ commandId: "end", agent: harnessA.agent, rawInput: "done", attachments: [], signal: new AbortController().signal });
		assert.deepEqual(harnessA.toolRegistry.registry.registered.map((entry) => entry.name), []);
		assert.deepEqual(harnessB.toolRegistry.registry.registered.map((entry) => entry.name).sort(), ["deep_review_scan", "deep_review_verify"]);
		assert.match((await runCommandFn(harnessA.commands, harnessA.agent, "review", "status")).text, /no review active/);
	}

	/** /end-review summarize on a deep review reads the verified report only. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-summary-0001" });
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runCommandFn(commands, agent, "end-review", "summarize");
		assert.equal(agent.followups.length, 2);
		assert.ok(agent.followups[1].content[0].text.startsWith(REVIEW_SUMMARY_PROMPT));
		assert.match(agent.followups[1].content[0].text, /Deep review notes/);
		assert.deepEqual(toolRegistry.registry.registered.map((entry) => entry.name), []);
	}

	/** The deep prompts never change the base ones. */
	{
		const deepSummary = buildDeepSummaryPrompt();
		assert.ok(deepSummary.startsWith(REVIEW_SUMMARY_PROMPT));
		assert.ok(deepSummary.length > REVIEW_SUMMARY_PROMPT.length);
		assert.ok(buildDeepReviewPrompt({ type: "uncommitted" }, {}, { maxReviewers: 12, maxVerifierRuns: 40 }).includes("# Deep review orchestration"));
	}

	/** The budget: a spent call is loud, and a re-call finishes only the pending reviewers. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-budget-0001",
			deep: { callBudgetMs: 1000 },
			scripts: (label, request, started) => {
				// The correctness reviewer sleeps past the budget on its FIRST start only.
				if (label.startsWith("deep review: correctness") && started <= 6) {
					return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }), 1500));
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan.budgetSpent, true);
		assert.equal(scan.reviewersSucceeded, scan.reviewersTotal - 1);
		// The roster entry names the budget, not a bare "was cancelled": the
		// per-worker reason is where a reader looks for why a worker stopped.
		const correctnessState = scan.roster.find((entry) => entry.lens === "correctness").state;
		assert.equal(correctnessState, "failed (reviewer was cancelled when the call budget expired)", `correctness state: ${correctnessState}`);
		assert.equal(scan.callBudgetMs, 1000);
		// The rendered warning leads the roster and names the seconds.
		const scanDefinition = toolRegistry.registry.registered.find((entry) => entry.name === "deep_review_scan");
		const rendered = scanDefinition.output.render({}, scan)[0].text;
		const warningAt = rendered.indexOf("⚠️ The call budget (1s) was spent");
		assert.ok(warningAt >= 0, `the rendered budget warning names the seconds: ${rendered.slice(0, 160)}`);
		assert.ok(warningAt < rendered.indexOf("## Roster"), "the budget warning precedes the roster");
		assert.match(rendered, /Call deep_review_scan again to retry them/);
		// A re-call re-runs only the correctness reviewer and completes.
		const correctnessRuns = started.filter((record) => record.label.startsWith("deep review: correctness")).length;
		const finished = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(finished.reviewersSucceeded, finished.reviewersTotal);
		assert.equal(finished.budgetSpent, false);
		assert.ok(!scanDefinition.output.render({}, finished)[0].text.includes("⚠️ The call budget"), "a fresh-budget re-call renders no budget warning");
		const correctnessAfter = started.filter((record) => record.label.startsWith("deep review: correctness")).length;
		assert.equal(correctnessAfter, correctnessRuns + 1);
	}

	/** The verify-side budget: a spent call returns what is pending (never a
	 * misleading "cancelled"), and a re-call with the same args finishes. The
	 * budget needs headroom for the scan's context gathering (real git runs),
	 * so the sleeps are long enough that the budget fires mid-verify. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-verify-budget-0001",
			deep: { callBudgetMs: 1000 },
			scripts: (() => {
				// The first verify call starts exactly 3 children — the shared pool
				// runs at deep.concurrency 3 across both lane kinds, so the first
				// three units in roster order (the reproducer, then the first two
				// static lanes) take the whole pool and the other three units queue
				// for the re-call. Sleep for the first 3 verify occurrences — the
				// first verify call — and make every later occurrence instant.
				let verifyOccurrences = 0;
				return (label, request, started) => {
					if (/deep verify \[/.test(label)) {
						verifyOccurrences += 1;
						if (verifyOccurrences <= 3) return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { results: [] } }), 2000));
					}
					return defaultScripts({})(label, request, started);
				};
			})(),
		});
		const { agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		// Before the bookkeeping-signal split, the post-pool snapshot rejected the
		// spent call with `GitError "git ls-files -m: cancelled"`.
		assert.equal(verify.budgetSpent, true);
		assert.ok(verify.pendingRuns > 0, `pendingRuns: ${verify.pendingRuns}`);
		assert.equal(verify.callBudgetMs, 1000);
		assert.match(verify.findingsMarkdown, /## Withheld \(raised but unverified\)/);
		// The rendered markdown names the unfinished runs and the re-call: the
		// structured pendingRuns/budgetSpent fields never reach the orchestrator.
		assert.match(verify.findingsMarkdown, /\d+ verifier run\(s\) did not finish \(the 1s call budget was spent mid-verification\)/);
		assert.match(verify.findingsMarkdown, /call deep_review_verify again with the same groups and dropped findings/);
		// A re-call with the same args creates a fresh budget and completes.
		const verify2 = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		assert.equal(verify2.pendingRuns, 0);
		assert.equal(verify2.budgetSpent, false);
		assert.ok(verify2.findingsMarkdown.includes("reproduced and traced"));
		assert.ok(!verify2.findingsMarkdown.includes("verifier run(s) did not finish"), "a completed verification renders no pending note");
		// A spent call never rejected: nothing extra was spawned by the first call's snapshot.
		const scanStarted = started.filter((record) => !/deep verify \[/.test(record.label)).length;
		assert.ok(scanStarted <= 7, `scan children: ${scanStarted}`);
	}

	// The containment-warning surface, end to end: children with no tools
	// service degrade every worker, and the degradation surfaces in the scan
	// value, the rendered scan text, and the verify markdown — never as a
	// stdout-only warn.
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-containment-0001",
			childTools: false,
		});
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.match(scan.containmentWarning, /\d+ fleet worker\(s\) ran without full tool containment/);
		assert.match(scan.containmentWarning, /no tools service to restrict; the child's tools service exposes no guard hook/, "one distinct note for a uniform degradation");
		const scanDefinition = toolRegistry.registry.registered.find((entry) => entry.name === "deep_review_scan");
		assert.match(scanDefinition.output.render({}, scan)[0].text, /⚠️ \d+ fleet worker\(s\) ran without full tool containment/);
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		assert.match(verify.containmentWarning, /ran without full tool containment/);
		assert.match(verify.findingsMarkdown, /> ⚠️ \d+ fleet worker\(s\) ran without full tool containment/);
		// A clean deployment renders no containment line at all.
		const cleanHarness = await makeHarness({ cwd: repoRoot, id: "session-containment-clean-0001" });
		await runCommandFn(cleanHarness.commands, cleanHarness.agent, "review", "uncommitted --deep");
		const cleanScan = await runToolFn(cleanHarness.toolRegistry, cleanHarness.agent, "deep_review_scan", {});
		assert.equal(cleanScan.containmentWarning, undefined, "fully contained workers carry no warning");
		assert.ok(!cleanScan.roster.some((entry) => entry.state.includes("containment")));
	}

	/** A spent budget below quorum returns the structured value (never the
	 * quorum throw), and a re-call with a fresh budget completes. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-budget-quorum-0001",
			// Concurrency 7 = the full roster: every reviewer's first (sleeping)
			// start lands inside the spent call, so the fresh-budget re-call
			// retries only second starts and completes.
			deep: { concurrency: 7, callBudgetMs: 1000 },
			scripts: ((seenLabels) => (label, request, started) => {
				// Every reviewer sleeps past the budget on its FIRST start only.
				if (!seenLabels.has(label)) {
					seenLabels.add(label);
					return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }), 1500));
				}
				return { stopReason: "completed", structured: { findings: [], sideEffects: [] } };
			})(new Set()),
		});
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		// Below quorum: the spent call returned instead of rejecting.
		assert.equal(scan.budgetSpent, true);
		assert.ok(scan.reviewersSucceeded < scan.reviewersTotal / 2, `below quorum: ${scan.reviewersSucceeded}/${scan.reviewersTotal}`);
		const nonSucceeded = scan.roster.filter((entry) => entry.state !== "succeeded");
		assert.ok(nonSucceeded.length > 0, "non-succeeded reviewers listed");
		assert.ok(nonSucceeded.every((entry) => /pending|failed/.test(entry.state)), `named: ${nonSucceeded.map((entry) => entry.state).join(", ")}`);
		// Below quorum the verify gate blocks with the quorum fraction (rawFindings
		// is empty, so groups: [] would otherwise close the pipeline).
		await assert.rejects(runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [], dropped: [] }), /did not reach quorum/);
		// A re-call with a fresh budget retries every non-succeeded reviewer and completes.
		const finished = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(finished.reviewersSucceeded, finished.reviewersTotal);
		assert.equal(finished.budgetSpent, false);
	}

	/** One persistently-failing reviewer above quorum counts for verification:
	 * the verify gate is the quorum fraction, not the all-succeeded state — a
	 * scan re-call re-runs the doomed worker, and the stop gate steers
	 * verification, not scan retries, releasing a completed verification
	 * without the incomplete marker. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-quorum-0001",
			scripts: (label, request, started) => {
				if (/^deep review: failure-paths/.test(label)) return { stopReason: "error", diagnostic: "deterministic provider rejection" };
				return defaultScripts({})(label, request, started);
			},
		});
		const { ctx, agent, commands, toolRegistry, steers, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan.reviewersTotal, 7);
		assert.equal(scan.reviewersSucceeded, 6);
		assert.match(scan.roster.find((entry) => entry.lens === "failure-paths").state, /failed/);
		// The in-call retry re-spawned the doomed worker once before the failure
		// was declared: the retry also fails, and the entry stays failed.
		assert.equal(started.filter((record) => /^deep review: failure-paths/.test(record.label)).length, 2, "the doomed worker ran twice (unit + one in-call retry)");
		// The gate over a counted scan: two steers on a slow start steer
		// verification (never scan retries of the doomed worker), then a
		// completed verification releases WITHOUT the incomplete marker.
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		ctx.emit("agent/turn-stopping", { agent, turn: 2, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 2);
		assert.doesNotMatch(steers[0].content[0].text, /deep_review_scan/);
		assert.match(steers[0].content[0].text, /deep_review_verify/);
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [] });
		assert.equal(verify.pendingRuns, 0);
		assert.match(verify.findingsMarkdown, /reproduced and traced/);
		// The coverage line treats the failed reviewers' scopes as uncovered.
		assert.match(verify.findingsMarkdown, /Coverage: 6\/7 reviewers succeeded/);
		harness.agent.session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: `The report.\n\n## Simplification Opportunities (Non-Blocking)\n- (none)\n\nThe new auth path returns null instead of failing fast.` }] }];
		ctx.emit("agent/turn-stopping", { agent, turn: 3, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 2, "the counted scan + completed verification release without steering");
		assert.doesNotMatch((await runCommandFn(commands, agent, "review", "status")).text, /Incomplete/);
	}

	/** One in-call reviewer retry: a worker whose first LLM attempt dies
	 * mid-stream (a provider connection reset) is re-spawned once in the same
	 * call — the scan counts the lens succeeded without a re-call, and the
	 * aborted check keeps a spent budget from re-spawning into an abort. */
	{
		const failCounts = new Map();
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-reviewer-retry-0001",
			scripts: (label, request, started) => {
				const match = /^deep review: (.+?)( \[shard \d+\/\d+\])?$/.exec(label);
				if (match?.[1] === "correctness") {
					const n = (failCounts.get("correctness") ?? 0) + 1;
					failCounts.set("correctness", n);
					// Fail only the FIRST in-call attempt; the retry completes.
					if (n === 1) return { stopReason: "error", diagnostic: "connection reset by peer" };
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(scan.reviewersSucceeded, scan.reviewersTotal, "the retried reviewer's second attempt completed");
		assert.equal(scan.roster.find((entry) => entry.lens === "correctness").state, "succeeded");
		// The retried worker ran exactly twice (unit + one in-call retry), and the
		// failure never surfaced: no re-call was needed.
		assert.equal(failCounts.get("correctness"), 2);
		assert.equal(started.filter((record) => record.label.startsWith("deep review: correctness")).length, 2);
	}

	/** The per-run --timeout override reaches the run's settings and changes
	 * the effective per-worker limit: a reviewer that resolves completed
	 * across the flag's abort re-spawns through the in-call retry (the scaled
	 * budget has room) and the entry still ends failed (reviewer timed out). */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-timeout-flag-0001",
			scripts: (label, request, started) => {
				if (/^deep review: correctness/.test(label)) {
					// Resolves completed across the flag's 1000ms abort: the run's
					// per-worker limit stays hard in both directions.
					return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }), 3000));
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { agent, commands, toolRegistry, started } = harness;
		const start = await runCommandFn(commands, agent, "review", "uncommitted --deep --timeout 1");
		// The override reached the run settings: the start message names the
		// effective 1s worker limit and the scaled call budget.
		assert.match(start.text, /Workers run up to 1s each/, `the flag reached the run settings: ${start.text}`);
		assert.match(start.text, /call budget/, "the start message names the effective budget");
		const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.match(scan.roster.find((entry) => entry.lens === "correctness").state, /failed \(reviewer timed out\)/);
		// The in-call retry ran the worker exactly twice under the scaled budget.
		assert.equal(started.filter((record) => record.label.startsWith("deep review: correctness")).length, 2);
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** The per-run --concurrency flag over the config, and the begin-time
	 * harness cap: a request past the harness's live active-subagent capacity
	 * (read off the subagents service at begin, never a hardcoded number) is
	 * capped to it and named in the start message — never silent. */
	{
		// Flag above capacity: capped, the message names the flag, the harness
		// limit, and the effective value; the description hint keeps the request.
		const harness = await makeHarness({ cwd: repoRoot, id: "session-concurrency-flag-0001", capacity: 8 });
		const { agent, commands, toolRegistry } = harness;
		const start = await runCommandFn(commands, agent, "review", "uncommitted --deep --concurrency 16");
		assert.match(start.text, /⚠️ Requested fleet concurrency 16 \(--concurrency\) exceeds the harness's active-subagent limit \(8\); the fleet runs at most 8 workers at once/, `the cap is named: ${start.text}`);
		const status = await runCommandFn(commands, agent, "review", "status");
		assert.match(status.text, /\(workers 16\)/, "the requested value rides the description hint");
		await runCommandFn(commands, agent, "end-review", "done");
		// Flag at capacity: no cap, no notice.
		const atCap = await makeHarness({ cwd: repoRoot, id: "session-concurrency-atcap-0001", capacity: 4 });
		const atCapStart = await runCommandFn(atCap.commands, atCap.agent, "review", "uncommitted --deep --concurrency 4");
		assert.doesNotMatch(atCapStart.text, /active-subagent limit/, "an at-capacity request is not capped");
		await runCommandFn(atCap.commands, atCap.agent, "end-review", "done");
		// Flag below capacity: no cap, no notice.
		const belowCap = await makeHarness({ cwd: repoRoot, id: "session-concurrency-below-0001", capacity: 8 });
		const belowStart = await runCommandFn(belowCap.commands, belowCap.agent, "review", "uncommitted --deep --concurrency 4");
		assert.doesNotMatch(belowStart.text, /active-subagent limit/, "a below-capacity request is not capped");
		await runCommandFn(belowCap.commands, belowCap.agent, "end-review", "done");
		// Unreadable capacity (no config reference on the service): no cap, no
		// notice — the pre-flag behavior, never a hardcoded fallback maximum.
		const unreadable = await makeHarness({ cwd: repoRoot, id: "session-concurrency-unreadable-0001" });
		const unreadableStart = await runCommandFn(unreadable.commands, unreadable.agent, "review", "uncommitted --deep --concurrency 16");
		assert.doesNotMatch(unreadableStart.text, /active-subagent limit/, "an unreadable capacity skips the cap");
		await runCommandFn(unreadable.commands, unreadable.agent, "end-review", "done");
	}

	/** The cap applies to the configured `deep.concurrency` too, and the capped
	 * value reaches the pools: with capacity 2 and the default concurrency 3,
	 * the scan and verify pools run at most 2 workers at once (measured at the
	 * provider seam), and the notice names the config as the source. */
	{
		let concurrent = 0;
		let maxConcurrent = 0;
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-concurrency-capped-pool-0001",
			capacity: 2,
			scripts: (label, request, started) => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				const outcome = defaultScripts({})(label, request, started);
				return new Promise((resolve) => setTimeout(() => {
					concurrent--;
					resolve(outcome);
				}, 50));
			},
		});
		const { agent, commands, toolRegistry } = harness;
		const start = await runCommandFn(commands, agent, "review", "uncommitted --deep");
		assert.match(start.text, /⚠️ Requested fleet concurrency 3 \(deep\.concurrency\) exceeds the harness's active-subagent limit \(2\); the fleet runs at most 2 workers at once/, `the config-sourced cap is named: ${start.text}`);
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		assert.ok(maxConcurrent > 1, `the pool still runs in parallel: max ${maxConcurrent}`);
		assert.ok(maxConcurrent <= 2, `the capped pool holds at most 2 workers: max ${maxConcurrent}`);
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** Two steers spent on a slow start do not mark a completed review
	 * incomplete: the steer-budget release guards on the pipeline state. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-gate-complete-0001" });
		const { ctx, agent, commands, toolRegistry, steers } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		ctx.emit("agent/turn-stopping", { agent, turn: 1, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		ctx.emit("agent/turn-stopping", { agent, turn: 2, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 2);
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		// The pipeline completed: the third stop releases WITHOUT the incomplete marker.
		harness.agent.session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: `The report.\n\n## Simplification Opportunities (Non-Blocking)\n- (none)\n\nThe new auth path returns null instead of failing fast.` }] }];
		ctx.emit("agent/turn-stopping", { agent, turn: 3, signal: new AbortController().signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(steers.length, 2, "the completed pipeline releases without steering");
		assert.doesNotMatch((await runCommandFn(commands, agent, "review", "status")).text, /Incomplete/);
	}

	/** A verifier unit that omits an assigned ref failed instead of falsely
	 * succeeded: the row is not permanently "unassessed" — a re-call retries. */
	{
		const failCounts = new Map();
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-unassessed-0001",
			scripts: (label, request, started) => {
				const match = /deep verify \[(.+?)\]/.exec(label);
				if (match?.[1] === "skeptic") {
					const n = (failCounts.get("skeptic") ?? 0) + 1;
					failCounts.set("skeptic", n);
					if (n === 1) return { stopReason: "completed", structured: { results: [] } }; // omits the assigned ref
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		// The skeptic omitted the ref: the unit failed, the finding withheld.
		assert.equal(verify.pendingRuns, 1);
		assert.match(verify.findingsMarkdown, /## Withheld \(raised but unverified\)/);
		// The re-call retries the failed unit and verifies the finding.
		const verify2 = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		assert.equal(verify2.pendingRuns, 0);
		assert.match(verify2.findingsMarkdown, /reproduced and traced/);
	}

	/** The user's standing instructions and --extra ride to every fleet worker. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-worker-instructions-0001" });
		const { agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "instructions CANARY-CUSTOM prefer fail-fast");
		const start = await runCommandFn(commands, agent, "review", "uncommitted --deep --extra \"CANARY-EXTRA focus on io\"");
		assert.equal(start.kind, "success");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		const reviewerPrompts = started.filter((record) => record.label.startsWith("deep review")).map((record) => record.prompt);
		assert.ok(reviewerPrompts.length > 0);
		assert.ok(reviewerPrompts.every((prompt) => prompt.includes("CANARY-CUSTOM")), "reviewers read the stored instructions");
		assert.ok(reviewerPrompts.every((prompt) => prompt.includes("CANARY-EXTRA")), "reviewers read the --extra instruction");
		await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		const verifierPrompts = started.filter((record) => record.label.startsWith("deep verify")).map((record) => record.prompt);
		assert.ok(verifierPrompts.length > 0);
		assert.ok(verifierPrompts.every((prompt) => prompt.includes("CANARY-CUSTOM")), "verifiers read the stored instructions");
	}

	/** Per-lane `agentOptions` merge over `verifierAgentOptions` at the provider start. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-lane-options-0001",
			deep: { lanes: { impact: { agentOptions: { model: "cheap" } } }, verifierAgentOptions: { maxTokens: 500 } },
		});
		const { agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		const impactStart = started.find((record) => record.label.includes("[impact]"));
		assert.ok(impactStart, "impact verifier started");
		assert.deepEqual(impactStart.agentOptions, { maxTokens: 500, model: "cheap" });
		const skepticStart = started.find((record) => record.label.includes("[skeptic]"));
		assert.ok(skepticStart, "skeptic verifier started");
		assert.deepEqual(skepticStart.agentOptions, { maxTokens: 500 });

		// An explicitly-undefined lane field must not shadow the global.
		const harness2 = await makeHarness({
			cwd: repoRoot,
			id: "session-lane-options-2-0001",
			deep: { lanes: { skeptic: { agentOptions: { maxTokens: undefined } } }, verifierAgentOptions: { maxTokens: 500 } },
		});
		const { agent: agent2, commands: commands2, toolRegistry: toolRegistry2, started: started2 } = harness2;
		await runCommandFn(commands2, agent2, "review", "uncommitted --deep");
		await runToolFn(toolRegistry2, agent2, "deep_review_scan", {});
		await runToolFn(toolRegistry2, agent2, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
		const skepticStart2 = started2.find((record) => record.label.includes("[skeptic]"));
		assert.ok(skepticStart2, "skeptic verifier started");
		assert.deepEqual(skepticStart2.agentOptions, { maxTokens: 500 }, "an explicitly-undefined lane field does not shadow the global");
		console.log("lane options merge: ok");
	}

	/** A failed durable write leaves no untracked review: the regular path
	 * commits the durable write before queueing the model-visible turn. */
	{
		const failingTable = {
			get: () => undefined,
			put: async () => {},
			delete: async () => {},
			update: async (key, fn) => {
				// Mimic the real domain impl: an absent key rejects with the stable
				// missing-key code (state.js materializes the record and re-runs the
				// transform); the re-run's backend put fails first, and a rejected
				// backend write leaves memory untouched.
				if (key === "never-materialized") throw Object.assign(new Error("missing-key"), { code: "missing-key" });
				throw Object.assign(new Error("simulated backend write failure (EACCES on $DSH_HOME/storages)"), { name: "StorageError" });
			},
		};
		const harness = await makeHarness({ cwd: repoRoot, id: "session-failwrite-0001", table: failingTable });
		const { agent, commands, table } = harness;
		const result = await runCommandFn(commands, agent, "review", "folder folderB");
		assert.equal(result.kind, "error");
		assert.match(result.text, /simulated backend write failure/);
		// The order fix: the model-visible rubric turn is queued only after the
		// durable write, so a failed write queues NOTHING.
		assert.equal(agent.followups.length, 0);
		// Memory agrees with the error: no active review.
		const record = table.get("session-failwrite-0001");
		assert.ok(!record?.active);
	}

	/** A concurrent `/review --deep` for a session with a live deep review
	 * errors instead of orphaning the live run's scope and tool definitions. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-guard-0002" });
		const { agent, commands, toolRegistry } = harness;
		const [first, second] = await Promise.all([
			runCommandFn(commands, agent, "review", "uncommitted --deep"),
			runCommandFn(commands, agent, "review", "uncommitted --deep"),
		]);
		const successes = [first, second].filter((r) => r.kind === "success");
		const errors = [first, second].filter((r) => r.kind === "error");
		assert.equal(successes.length, 1, `exactly one deep start wins: ${JSON.stringify([first.kind, second.kind])}`);
		assert.equal(errors.length, 1);
		assert.match(errors[0].text, /already running in this session/);
		// One live run: one orchestrator prompt, one tool pair.
		assert.equal(agent.followups.length, 1);
		assert.deepEqual(toolRegistry.registry.registered.map((entry) => entry.name).sort(), ["deep_review_scan", "deep_review_verify"]);
		// /end-review done disposes the single run cleanly.
		await runCommandFn(commands, agent, "end-review", "done");
		assert.deepEqual(toolRegistry.registry.registered.map((entry) => entry.name), []);
	}

	/** A mid-begin throw propagates to the command boundary and leaves the run
	 * store clean: the registration path re-runs on a retry /review --deep.
	 * (The fix-specific effect — the scope disposed so the poisoned layer entry
	 * is removed and retry un-blocks — is exercised by the real
	 * dsh-scope/dsh-tools graph; the fake registry cannot observe the real
	 * scoped layering.) */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-midbegin-0001" });
		const { agent, commands, toolRegistry } = harness;
		// The failed begin's verify registration throws after scan succeeded.
		toolRegistry.registry.failRegisterAt = 2;
		const callsBefore = toolRegistry.registry.registerCalls;
		const failed = await runCommandFn(commands, agent, "review", "uncommitted --deep");
		assert.equal(failed.kind, "error");
		assert.match(failed.text, /already registered in this scope/);
		// The durable write never happened (begin threw before it): no active review.
		assert.match((await runCommandFn(commands, agent, "review", "status")).text, /no review active/);
		// A retry begin is not the "already running" runs.has error: the store
		// stayed clean and the registration path re-ran (two more register calls).
		const retry = await runCommandFn(commands, agent, "review", "uncommitted --deep");
		assert.equal(retry.kind, "success", retry.text);
		assert.equal(toolRegistry.registry.registerCalls, callsBefore + 4, "the retry begin re-ran both registrations");
		assert.deepEqual(toolRegistry.registry.registered.map((entry) => entry.name).sort(), ["deep_review_scan", "deep_review_scan", "deep_review_verify"]);
		// The retry's live run disposes cleanly.
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** An outside-git folder review walks only the requested paths. */
	{
		const root = await mkdtemp(path.join(tmpdir(), "dsh-review-folders-"));
		try {
			await mkdir(path.join(root, "folderA"), { recursive: true });
			await mkdir(path.join(root, "folderB"), { recursive: true });
			await mkdir(path.join(root, "folderB", "secret"), { recursive: true });
			await writeFile(path.join(root, "folderA", "a.js"), "x");
			await writeFile(path.join(root, "folderB", "b.js"), "y");
			await writeFile(path.join(root, "folderB", "secret", "s.js"), "z");
			if (process.getuid?.() !== 0) await chmod(path.join(root, "folderB", "secret"), 0o000);
			const harness = await makeHarness({ cwd: root, id: "session-folders-0001" });
			const { agent, commands, toolRegistry } = harness;
			const start = await runCommandFn(commands, agent, "review", "folder folderB --deep");
			assert.equal(start.kind, "success");
			// The roster exposes the scope: one file (folderB/b.js), not the whole
			// cwd's two — a whole-cwd walk would list the sibling directory the
			// prompt never named.
			const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
			assert.ok(scan.reviewersTotal >= 1);
			for (const entry of scan.roster) assert.match(entry.scope, /whole change \(1 files\)/, entry.scope);
			// An unreadable directory is skipped and NAMED in the report's coverage.
			if (process.getuid?.() !== 0) {
				const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
				assert.match(verify.findingsMarkdown, /1 path skipped from the walk: folderB\/secret \(unreadable\)/);
			}
		} finally {
			if (process.getuid?.() !== 0) await chmod(path.join(root, "folderB", "secret"), 0o755).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
		console.log("folders: ok");
	}

	/** An in-repo folder review lists untracked net-new files under the
	 * requested paths: the two deployments must agree, or the file-local
	 * lenses never review them. */
	{
		const root = await mkdtemp(path.join(tmpdir(), "dsh-review-folder-untracked-"));
		try {
			const git = async (...args) => {
				const result = await runProcess({ subprocess }, ["git", ...args], root, undefined);
				assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
			};
			await mkdir(path.join(root, "src"), { recursive: true });
			await writeFile(path.join(root, "src", "tracked.js"), "x");
			await git("init", "-b", "main");
			await git("config", "user.email", "test@example.com");
			await git("config", "user.name", "Test");
			await git("add", ".");
			await git("commit", "-m", "initial");
			await writeFile(path.join(root, "src", "untracked.js"), "y");
			const harness = await makeHarness({ cwd: root, id: "session-folder-untracked-0001" });
			const { agent, commands, toolRegistry } = harness;
			await runCommandFn(commands, agent, "review", "folder src --deep");
			const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
			assert.ok(scan.reviewersTotal >= 1);
			// Both files reach the roster: the whole-change scope names 2 files.
			for (const entry of scan.roster) assert.match(entry.scope, /whole change \(2 files\)/, entry.scope);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		console.log("folder untracked: ok");
	}

	/** In-repo folder pathspecs normalize against cwd (worktree-internal
	 * absolute and ../ paths, and the cwd itself), and a worktree-external
	 * pathspec falls back to the requested-path walk with git's diagnostic in
	 * the coverage note. An unmatched-but-valid relative pathspec names the
	 * typo instead of running reviewers with silently empty scopes. */
	{
		const root = await mkdtemp(path.join(tmpdir(), "dsh-review-folder-norm-"));
		try {
			const git = async (...args) => {
				const result = await runProcess({ subprocess }, ["git", ...args], root, undefined);
				assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
			};
			await mkdir(path.join(root, "src"), { recursive: true });
			await mkdir(path.join(root, "sub"), { recursive: true });
			await writeFile(path.join(root, "src", "tracked.js"), "x");
			await git("init", "-b", "main");
			await git("config", "user.email", "test@example.com");
			await git("config", "user.name", "Test");
			await git("add", ".");
			await git("commit", "-m", "initial");
			await writeFile(path.join(root, "src", "untracked.js"), "y");

			// The cwd itself: path.relative yields "" and would be a git fatal as
			// an empty pathspec — the guard passes "." instead.
			{
				const harness = await makeHarness({ cwd: root, id: "session-folder-dot-0001" });
				const { agent, commands, toolRegistry } = harness;
				const start = await runCommandFn(commands, agent, "review", "folder . --deep");
				assert.equal(start.kind, "success");
				const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
				assert.ok(scan.reviewersTotal >= 1);
				// The whole-worktree listing: tracked + untracked under src.
				for (const entry of scan.roster) assert.match(entry.scope, /whole change \(2 files\)/, entry.scope);
				await runCommandFn(commands, agent, "end-review", "done");
			}

			// Worktree-internal absolute path from a subdirectory cwd: pathspec
			// "../src" is accepted; paths print relative to the subdirectory cwd.
			{
				const harness = await makeHarness({ cwd: path.join(root, "sub"), id: "session-folder-abs-0001" });
				const { agent, commands, toolRegistry } = harness;
				const start = await runCommandFn(commands, agent, "review", `folder ${path.join(root, "src")} --deep`);
				assert.equal(start.kind, "success");
				const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
				assert.ok(scan.reviewersTotal >= 1);
				for (const entry of scan.roster) assert.match(entry.scope, /whole change \(2 files\)/, entry.scope);
				await runCommandFn(commands, agent, "end-review", "done");
			}

			// A worktree-external pathspec fails the git listing all-or-nothing;
			// the walk fallback lists the requested paths and carries git's
			// diagnostic in the coverage note.
			const external = await mkdtemp(path.join(tmpdir(), "dsh-review-external-"));
			try {
				await writeFile(path.join(external, "outside.js"), "x");
				const harness = await makeHarness({ cwd: root, id: "session-folder-fallback-0001" });
				const { agent, commands, toolRegistry } = harness;
				const start = await runCommandFn(commands, agent, "review", `folder ${external} --deep`);
				assert.equal(start.kind, "success");
				const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
				assert.ok(scan.reviewersTotal >= 1);
				for (const entry of scan.roster) assert.match(entry.scope, /whole change \(1 files\)/, entry.scope);
				const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
				assert.match(verify.findingsMarkdown, /git listing failed/);
				assert.match(verify.findingsMarkdown, /walked the requested paths directly/);
			} finally {
				await rm(external, { recursive: true, force: true });
			}

			// An unmatched-but-valid relative pathspec succeeds vacuously in git
			// (exit 0, empty output); the note names the typo instead of running
			// reviewers with silently empty scopes.
			{
				const harness = await makeHarness({ cwd: root, id: "session-folder-vacuous-0001" });
				const { agent, commands, toolRegistry } = harness;
				const start = await runCommandFn(commands, agent, "review", "folder typo-dir --deep");
				assert.equal(start.kind, "success");
				const scan = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
				assert.ok(scan.reviewersTotal >= 1);
				const verify = await runToolFn(toolRegistry, agent, "deep_review_verify", { groups: [{ primary: "R1.1" }], dropped: [{ id: "R2.1", reason: "style-only" }] });
				assert.match(verify.findingsMarkdown, /no requested path exists under the worktree: typo-dir/);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		console.log("folder pathspec: ok");
	}

	/** Cancellation: the turn's signal aborts in-flight workers; a re-call finishes. */
	{
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-cancel-0001",
			scripts: (label, request, started) => {
				if (label.startsWith("deep review: correctness") && started <= 6) {
					return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }), 400));
				}
				return defaultScripts({})(label, request, started);
			},
		});
		const { agent, commands, toolRegistry, started } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const controller = new AbortController();
		const scanPromise = runToolFn(toolRegistry, agent, "deep_review_scan", {}, controller.signal);
		// Abort after the context-gathering phase and after the instant reviewers
		// settled, while the correctness reviewer is still in flight.
		await new Promise((resolve) => setTimeout(resolve, 120));
		controller.abort();
		const scan = await Promise.race([scanPromise, new Promise((r) => setTimeout(() => r(undefined), 2000))]);
		assert.ok(started.some((record) => record.disposed), "aborted workers were disposed");
		assert.ok(scan && scan.reviewersSucceeded < scan.reviewersTotal);
		// A re-call finishes the pending reviewers.
		const finished = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(finished.reviewersSucceeded, finished.reviewersTotal);
	}

	/** A genuine cancellation below quorum throws a dedicated cancellation
	 * message (the re-call steer stays) rather than the quorum wording — the
	 * thrown isError is what the cancelled call delivers. run.scan.state stays
	 * partial so a re-call finishes the reviewers. */
	{
		const controller = new AbortController();
		const harness = await makeHarness({
			cwd: repoRoot,
			id: "session-cancel-start-0001",
			scripts: () => {
				// Aborting on the first reviewer start pins the cancel post-gathering
				// (the pool has begun, nothing settled): the dedicated cancellation
				// branch in the quorum throw is what rejects, not a gathering GitError.
				controller.abort();
				return new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }), 1500));
			},
		});
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scanPromise = runToolFn(toolRegistry, agent, "deep_review_scan", {}, controller.signal);
		await assert.rejects(scanPromise, /the scan was cancelled/, "the cancelled call names the stop, not the quorum");
		// A re-call with a fresh signal finishes every reviewer.
		const finished = await runToolFn(toolRegistry, agent, "deep_review_scan", {});
		assert.equal(finished.reviewersSucceeded, finished.reviewersTotal);
		await runCommandFn(commands, agent, "end-review", "done");
	}

	/** A provider that starts children with the parent's context fails loud. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-inherit-0001" });
		const { agent, commands, toolRegistry } = harness;
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		// The provider object is mutable: an inherits-context provider fails loud.
		harness.provider.inheritsParentContext = true;
		await assert.rejects(runToolFn(toolRegistry, agent, "deep_review_scan", {}), /parent's context/);
	}

	/** Deep review without the fleet services answers with the missing-services error. */
	{
		const harness = await makeHarness({ cwd: repoRoot, id: "session-nofleet-0001", withFleet: false });
		const { agent, commands } = harness;
		const result = await runCommandFn(commands, agent, "review", "uncommitted --deep");
		assert.equal(result.kind, "error");
		assert.match(result.text, /tools and subagents/);
		// Regular review works without the fleet and never touches it.
		const regular = await runCommandFn(commands, agent, "review", "uncommitted");
		assert.equal(regular.kind, "success");
		assert.ok(!regular.text.includes("(deep)"));
		assert.equal(agent.followups.length, 1);
		assert.ok(agent.followups[0].content[0].text.startsWith(REVIEW_RUBRIC));
	}

	/** Unload with an in-flight scan: abort, drain, dispose scopes, close the domain. */
	{
		const timeline = [];
		const { provider, started, children } = makeProvider({
			scripts: () => new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", structured: { findings: [], sideEffects: [] } }), 300)),
		});
		const toolRegistry = makeToolRegistry();
		const commands = { registered: [], register(definition) { commands.registered.push(definition); return () => {}; } };
		const table = makeTable();
		const host = new Context();
		host.provide("subprocess", subprocess);
		host.provide("storageDomain", { async open() { return { name: "review", close: async () => void timeline.push("domain closed"), table: () => table }; } });
		host.provide("commands", commands);
		host.provide("tools", toolRegistry);
		host.provide("agents", { get: (id) => children.get(id) });
		host.provide("subagents", { getProvider: () => provider, startActivation: (spec) => provider.startActivation(spec) });
		const agent = {
			id: "session-unload-0001",
			session: { header: { cwd: repoRoot }, deriveMessages: () => [] },
			followups: [],
			followup(message) { this.followups.push(message); },
			steer() {},
		};
		const fiber = host.plugin({ name, inject, apply }, { deep: { callBudgetMs: 30000 } });
		await fiber;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await runCommandFn(commands, agent, "review", "uncommitted --deep");
		const scanPromise = runToolFn(toolRegistry, agent, "deep_review_scan", {}).then(
			(value) => {
				timeline.push("scan settled");
				return value;
			},
			() => {
				// An aborted scan fails loud; the timeline records that it settled.
				timeline.push("scan settled");
				return undefined;
			},
		);
		// Let the context-gathering phase finish and the workers start.
		await new Promise((resolve) => setTimeout(resolve, 120));
		// Unload mid-scan: the fleet teardown aborts the runs and drains the in-flight
		// tools; the review lifecycle's disposer closes the domain after the drain.
		const unloaded = fiber.dispose().then(() => void timeline.push("unload done"));
		await scanPromise;
		await unloaded;
		assert.ok(started.length > 0, "workers started before the unload");
		assert.ok(started.every((record) => record.disposed), "fleet workers were disposed by teardown");
		assert.ok(timeline.includes("scan settled"));
		assert.ok(timeline.includes("unload done"));
		assert.deepEqual(timeline.filter((entry) => entry === "domain closed").length, 1, "the domain closed once, after the drain");
		assert.deepEqual(toolRegistry.registry.registered.map((entry) => entry.name), [], "scopes disposed the deep tools");
		// A command after the plugin unloaded answers cancelled (the lifetime aborted).
		assert.match((await runCommandFn(commands, agent, "review", "status")).text, /Review cancelled/);
	}

	console.log("runtime: ok");
} finally {
	await rm(repoRoot, { recursive: true, force: true });
}

console.log("fleet: all assertions passed");
