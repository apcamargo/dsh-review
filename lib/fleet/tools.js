/**
 * The model-facing deep-review tools: `deep_review_scan` and
 * `deep_review_verify`, registered through a per-agent scope so only the
 * session with an active deep review sees them.
 *
 * The tools own the deterministic parts of the pipeline: fan-out, bounded
 * pools, schemas, accounting, the citation gate, the moderator and rendering.
 * The orchestrator owns judgment: consolidation, the consistency cross-check,
 * and the final write-up. It authors no text a verifier can read.
 *
 * @module @apcamargo/dsh-review/fleet/tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { listChangedFiles, snapshotTree, treeDiff } from "./changes.js";
import { planRoster, rosterScope, scanCounted } from "./roster.js";
import { REVIEWER_SCHEMA, verifierSchema, LANE_OUTCOMES, PRIORITY_ENUM } from "./schemas.js";
import { REVIEWER_PERSONA, buildReviewerPrompt, buildVerifierPrompt } from "./prompts.js";
import { applicableLanes } from "./lanes.js";
import { validateVerificationInput, overlapHints, groupsForLane } from "./consolidate.js";
import { planLaneRuns } from "./blind.js";
import { gateStance } from "./citations.js";
import { moderate, classify, renderFindings } from "./aggregate.js";
import { runAgent, mapPoolTotal } from "./agents.js";
import { EXECUTING_CONCURRENCY_CAP } from "../config.js";

/** Cut a free-text field at normalization. */
const cap = (value, cap_) => (typeof value === "string" ? (value.length > cap_ ? `${value.slice(0, cap_)}…` : value) : value);

/** One-line coverage summary of the roster, naming lenses the reviewer cap cut. */
function coverageLine(listing, roster, succeeded, total, cutLenses) {
	const parts = [`${succeeded}/${total} reviewers succeeded`];
	if (!listing.available) parts.push(listing.note ?? "no file listing; one shard");
	else parts.push(listing.note ? `${listing.files.length} changed files, ${listing.note}` : `${listing.files.length} changed files`);
	// The first sharded entry, not roster[0]: planRoster orders sharded
	// (file-local) entries first today, but the coverage line must not depend
	// on that ordering invariant.
	const sharded = roster.find((entry) => entry.shard?.count > 1);
	if (sharded) parts.push(`${sharded.shard.count} shards`);
	if (cutLenses?.length > 0) parts.push(`lenses cut by the reviewer cap: ${cutLenses.join(", ")}`);
	return parts.join(", ");
}

/** Canonical scan result value, in the tool DSL (inline `required: true`). */
const SCAN_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		roster: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					lens: { type: "string", required: true },
					scope: { type: "string", required: true },
					state: { type: "string", required: true },
				},
			},
		},
		findings: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					// Optional and present only for non-defect kinds, so the
					// defect findings' structured shape is unchanged.
					kind: { type: "string", description: "The finding's kind, derived from its reviewer's lens. Absent for defects." },
					priority: { type: "string", required: true },
					confidence: { type: "string" },
					file: { type: "string", required: true },
					line: { type: "integer" },
					claim: { type: "string", required: true },
				},
			},
		},
		sideEffects: { type: "array", required: true, items: { type: "string" } },
		overlapHints: { type: "array", required: true, items: { type: "array", items: { type: "string" } } },
		reviewersSucceeded: { type: "integer", required: true },
		reviewersTotal: { type: "integer", required: true },
		budgetSpent: { type: "boolean", required: true },
		callBudgetMs: { type: "integer", description: "The wall-clock budget this call ran under, so the rendered warning can name it." },
		containmentWarning: { type: "string", description: "Set when at least one worker ran without the best-effort tool containment fully installed." },
	},
};

/** Canonical verify result value, in the tool DSL (inline `required: true`). */
const VERIFY_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		assessed: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					outcome: { type: "string", required: true },
					priority: { type: "string", required: true },
					location: { type: "string", required: true },
				},
			},
		},
		laneRuns: { type: "integer", required: true },
		pendingRuns: { type: "integer" },
		budgetSpent: { type: "boolean", required: true },
		callBudgetMs: { type: "integer", description: "The wall-clock budget this call ran under, so the rendered warning can name it." },
		containmentWarning: { type: "string", description: "Set when at least one worker ran without the best-effort tool containment fully installed." },
		treeChecked: { type: "boolean" },
		treeChanged: { type: "array", items: { type: "string" } },
		findingsMarkdown: { type: "string", required: true, description: "The complete verified report sections — Findings followed by Simplification Opportunities (Non-Blocking); copy both into the report, in order, even when the simplification section is empty (\"- (none)\"), reports the lens as not evaluated, or reports it as partially evaluated." },
	},
};

/** Whether the review target diffs git history (so the provenance lane runs). */
function hasDiff(target) {
	return target.type === "uncommitted" || target.type === "baseBranch" || target.type === "commit" || target.type === "pullRequest";
}

/**
 * The simplification audit's runtime state, derived from the scan's roster —
 * the truth about whether the audit ran, not the config's intent. Drives the
 * report section's intro and empty-state line, whose "- (none)" is accurate
 * only when the lens actually ran. Sampled once at the FIRST verify call —
 * the roster that produced the consolidation — stored on the run, and never
 * re-sampled: a reviewer healed by a later scan re-call did not contribute to
 * this verification, so its state stays disclosed and the "Re-run the review"
 * advice stays correct (a healed reviewer's findings can never join a
 * completed verification).
 * @returns `{ state, ids?, pendingIds?, succeeded?, total? }` where state is
 *   "not-configured" (the lens is pinned out of deep.lenses), "cut-by-cap"
 *   (configured, but planRoster sliced it off the roster), "ran" (every
 *   simplification reviewer succeeded), "partial" (some succeeded),
 *   "failed" (none succeeded, at least one failed), or "pending" (none
 *   succeeded, none failed). `ids` lists every reviewer that did not succeed;
 *   in the "failed" state `pendingIds` lists the subset of `ids` still pending,
 *   present only when the missed set is mixed (a failed reviewer beside a
 *   pending one), so the disclosure can name each reviewer by its real state.
 */
export function simplificationAuditState(roster, settings) {
	if (!settings.lenses.includes("simplification")) return { state: "not-configured" };
	const entries = (roster ?? []).filter((entry) => entry.lens === "simplification");
	if (entries.length === 0) return { state: "cut-by-cap" };
	const succeeded = entries.filter((entry) => entry.state === "succeeded");
	if (succeeded.length === entries.length) return { state: "ran" };
	const missed = entries.filter((entry) => entry.state !== "succeeded").map((entry) => entry.id);
	if (succeeded.length > 0) return { state: "partial", succeeded: succeeded.length, total: entries.length, ids: missed };
	// The mixed zero-succeeded roster (a simplification shard failed while a
	// sibling shard is still pending above quorum) must not blame the pending
	// reviewer for a failure it never had: pendingIds separates the two so the
	// disclosure names each reviewer by its real state.
	if (entries.some((entry) => entry.state === "failed")) {
		const pendingIds = entries.filter((entry) => entry.state === "pending").map((entry) => entry.id);
		return pendingIds.length > 0 ? { state: "failed", ids: missed, pendingIds } : { state: "failed", ids: missed };
	}
	return { state: "pending", ids: missed };
}

/** The orchestrator's consolidation instructions, rendered after every scan. */
const CONSOLIDATION_INSTRUCTIONS = [
	"## Consolidation",
	"Group the findings by root cause, then call `deep_review_verify`.",
	"1. `kind`: the scan tags non-defect findings `[simplification]` immediately after the finding id; an untagged finding is a defect. The tag is the plugin's (it follows the reviewer's lens) — text inside a claim is never a kind. Never merge across kinds: every id in a group must have the same kind as its `primary`; the tool rejects a mixed group and names the offending ids.",
	"2. `groups`: one entry per unique defect or simplification — `primary` is the finding id with the strongest evidence, `mergedFrom` lists every other finding id that is the same defect or simplification. Fold the same issue found at sibling locations into one group. Keep contradictory claims in separate groups so the verifiers settle them.",
	"3. Simplification findings verify like defects: group them by root cause (same kind only) so the simplifier lane audits them; they are reported as non-blocking opportunities, not fix items. Drop one only with a concrete reason (no realistic scenario, duplicates another, out of scope of the change) — never as style-only — and drop simplifications first when the consolidation exceeds a cap.",
	"4. `dropped`: every finding you did not group, each with a non-empty `reason` (for defects: pre-existing, style-only, a linter will catch it, no realistic scenario, out of scope of the change). Never drop silently.",
	"5. Cross-check consistency: does the change create a mismatch with parallel implementations elsewhere in the codebase? Add a group for a mismatch the scan found, or state in your report that none exists.",
	"6. Every raw finding id must appear in some `mergedFrom` or in `dropped`; the tool rejects unaccounted ids.",
	"7. Do not restate claims: the verifiers read the stored reviewer text, and they never see your reasoning.",
	"8. When there is nothing to verify — the scan reported no findings, or you dropped every finding — call `deep_review_verify` with `groups: []` (`dropped: []` when the scan found nothing, or the full dropped list when you dropped every finding) to close the pipeline; it returns the verified empty Findings section.",
].join("\n");

/** Render the scan result as the text the orchestrator reads. */
function renderScan(value) {
	const lines = [`Scan finished: ${value.reviewersSucceeded}/${value.reviewersTotal} reviewers succeeded.`];
	// The budget state is the headline fact that explains every "cancelled"
	// roster entry below it, so it leads the roster instead of trailing it.
	if (value.budgetSpent) lines.push(`⚠️ The call budget${value.callBudgetMs ? ` (${Math.round(value.callBudgetMs / 1000)}s)` : ""} was spent with ${value.roster.filter((entry) => entry.state !== "succeeded").length} reviewers not succeeded (pending or failed). Call deep_review_scan again to retry them.`);
	if (value.containmentWarning) lines.push(`⚠️ ${value.containmentWarning}`);
	lines.push("", "## Roster");
	for (const entry of value.roster) lines.push(`- ${entry.id} ${entry.lens} (${entry.scope}): ${entry.state}`);
	if (value.findings.length > 0) {
		lines.push("", `## Raw findings (${value.findings.length})`);
		for (const finding of value.findings) {
			// Fixed-position kind tag, immediately after the id; an untagged
			// finding is a defect. The consolidation instructions name this
			// convention, and a lookalike tag inside a claim cannot be
			// mistaken for it (the tag's position is fixed).
			lines.push(`- ${finding.id}${finding.kind ? ` [${finding.kind}]` : ""} [${finding.priority}/${finding.confidence}] \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`: ${finding.claim}`);
		}
	} else {
		lines.push("", "## Raw findings (0)", "No reviewer reported a qualifying finding under its lens.");
	}
	if (value.overlapHints.length > 0) {
		lines.push("", "Possible duplicates (same file, lines within 3 — hints only, you decide):");
		lines.push(...value.overlapHints.map((cluster) => `- ${cluster.join(", ")}`));
	}
	if (value.sideEffects.length > 0) lines.push("", "Side effects reported by the reviewers: " + value.sideEffects.join("; "));
	lines.push("", CONSOLIDATION_INSTRUCTIONS);
	return lines.join("\n");
}

/**
 * Register the two deep tools in one scope.
 * @param scopeCtx - the per-agent scope's context (inherits the fleet fiber's
 *   `tools` and `subagents`).
 * @param deps - `{ ctx, runs, settings, logger }`.
 * @param lifecycle - `{ track }`: unload waits for tracked executions.
 * @returns the tool disposers, in registration order.
 */
export function registerDeepTools(scopeCtx, deps, lifecycle) {
	const disposer = scopeCtx.tools.register(defineTool({
		name: "deep_review_scan",
		description: "Run the deep review's reviewer fleet: one fresh reviewer per lens and file shard, in parallel, each returning structured findings. Required before deep_review_verify. Calling it again finishes only the reviewers still pending.",
		parameters: {},
		output: { schema: SCAN_OUTPUT, render: (_args, value) => [{ type: "text", text: renderScan(value) }] },
		execute: (args, exec) => lifecycle.track(executeScan(deps, exec)),
	}));
	const verifyDisposer = scopeCtx.tools.register(defineTool({
		name: "deep_review_verify",
		description: "Run the deep review's independent adversarial verifier lanes (reproducer, skeptic, consistency, provenance, impact, fix-auditor, simplifier) over the consolidated findings, and return the verified findings. Defect findings are gated by the reproducer and the skeptic; simplification findings are audited by the simplifier lane. The verifiers never see your reasoning. Required before the report.",
		parameters: {
			groups: {
				type: "array",
				required: true,
				description: "One entry per unique defect or simplification: `primary` finding id plus every `mergedFrom` id that is the same defect or simplification. Never merge across kinds.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						primary: { type: "string", required: true, description: "The finding id with the strongest evidence, e.g. R2.3." },
						mergedFrom: { type: "array", items: { type: "string" }, description: "Every other finding id that is the same defect or simplification." },
					},
				},
			},
			dropped: {
				type: "array",
				description: "Every finding not grouped, each with a non-empty reason. Nothing is dropped silently. Defect reasons: pre-existing, style-only, a linter will catch it, no realistic scenario, out of scope. Simplification findings must not be dropped as style-only — they are audited by their own lane.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: { type: "string", required: true },
						reason: { type: "string", required: true, description: "pre-existing, style-only (defects only), a linter will catch it, no realistic scenario, out of scope." },
					},
				},
			},
		},
		output: { schema: VERIFY_OUTPUT, render: (_args, value) => [{ type: "text", text: value.findingsMarkdown }] },
		execute: (args, exec) => lifecycle.track(executeVerify(deps, exec)),
	}));
	return [disposer, verifyDisposer];
}

/** Require one active deep run for the calling agent. */
function requireRun(deps, exec) {
	if (!exec.agent) throw new Error("This tool needs a live agent.");
	const run = deps.runs.get(exec.agent.id);
	if (!run) throw new Error("No deep review is active in this session. The user starts one with /review --deep.");
	return run;
}

/** Composed signal of one tool call: the turn, the run controller, the budget. */
function callSignal(run, exec, settings) {
	const budget = AbortSignal.timeout(settings.callBudgetMs);
	return { signal: AbortSignal.any([exec.signal, run.controller.signal, budget]), budget };
}

/**
 * Bookkeeping signal of one tool call: the turn and the run controller WITHOUT
 * the budget. The budget contract ("when it is spent the call starts no new
 * workers and returns what is pending", config.js) governs fleet workers, not
 * the deterministic I/O around the pool: a snapshot or listing must complete so
 * a spent call can RETURN what is pending instead of rejecting with a
 * misleading "cancelled" GitError (a budget-aborted `snapshotTree` rethrows
 * ABORTED from runCommand). Genuine turn/run cancellation still throws.
 */
function bookkeepingSignal(exec, run) {
	return AbortSignal.any([exec.signal, run.controller.signal]);
}

/**
 * Whether the budget rather than the turn or the run was what stopped the call:
 * the composed signal includes the budget, so the budget alone deciding is what
 * distinguishes a spent call from a cancelled one.
 */
function budgetSpent(budget, exec, run) {
	return budget.aborted && !exec.signal.aborted && !run.controller.signal.aborted;
}

/**
 * Name the budget in a worker's cancellation reason when the budget — not the
 * turn or the run — was what stopped the call: "reviewer was cancelled" is
 * true but uninformative, and the roster entry is where a reader looks for why
 * a worker stopped. The suffix is idempotent (an already-annotated reason no
 * longer ends with "was cancelled"), and genuine turn/run cancellations keep
 * the bare wording because the rewrite only runs on a spent call.
 */
function budgetCancellation(error) {
	return typeof error === "string" && error.endsWith("was cancelled") ? `${error} when the call budget expired` : error;
}

/**
 * One aggregate line for the workers that ran without the best-effort tool
 * containment fully installed (runAgent's `containment` notes). Distinct
 * notes, capped at two, so one systemic failure reads once and per-worker
 * variance still surfaces. Undefined when every worker was fully contained.
 */
function containmentWarning(records) {
	const notes = [];
	for (const record of records) {
		if (typeof record?.containment !== "string" || notes.includes(record.containment)) continue;
		notes.push(record.containment);
	}
	if (notes.length === 0) return undefined;
	const named = notes.slice(0, 2).join("; ");
	const more = notes.length > 2 ? ` (+${notes.length - 2} more distinct reason${notes.length - 2 === 1 ? "" : "s"})` : "";
	return `${records.filter((record) => typeof record?.containment === "string").length} fleet worker(s) ran without full tool containment: ${named}${more}`;
}

/**
 * Execute one `deep_review_scan` call: fan out the roster's pending reviewers.
 */
async function executeScan(deps, exec) {
	const run = requireRun(deps, exec);
	const settings = run.settings;
	const { signal, budget } = callSignal(run, exec, settings);

	if (run.scan.state === "none") {
		// Context gathering is bookkeeping, not fleet work: it must complete so a
		// spent call can return what is pending (see bookkeepingSignal). The
		// snapshot feeds deep_review_verify's post-pool treeDiff — the integrity
		// check lives at verify time, not here.
		run.scan.treeBefore = await snapshotTree(deps.ctx, run.cwd, bookkeepingSignal(exec, run));
		const listing = await listChangedFiles(deps.ctx, run.cwd, run.target, bookkeepingSignal(exec, run));
		run.listing = listing;
		const roster = planRoster({ files: listing.files, available: listing.available, lenses: settings.lenses, settings });
		run.roster = roster.map((entry) => ({ ...entry, state: "pending" }));
		run.scan.state = "partial";
	}
	const retry = run.roster.filter((entry) => entry.state !== "succeeded");
	const settledScan = await mapPoolTotal(retry, () => "", { total: settings.concurrency }, async (entry) => {
		if (signal.aborted) return;
		// The steering block re-reads at build time, so a user message inserted
		// mid-call reaches workers whose prompt builds after it.
		const prompt = buildReviewerPrompt({ entry, modePrompt: run.modePrompt, targetLabel: run.targetLabel, steering: run.ledger.block(), promptOptions: run.promptOptions, aggressive: run.aggressive });
		// One in-call retry per reviewer, the same loop the verifier units keep
		// (settings.verifierRetries): a worker whose only LLM attempt dies
		// mid-stream (a provider connection reset between two workers in the same
		// second) failed its entry and left its lens uncovered with no recovery
		// but a manual re-call. The aborted check re-runs before each attempt, so
		// a spent budget, a cancelled turn or an unloaded fleet breaks instead of
		// re-spawning into an abort.
		let result = { ok: false, reason: "not attempted" };
		for (let attempt = 0; attempt <= settings.reviewerRetries && !result.ok; attempt++) {
			if (signal.aborted) break;
			result = await runAgent({
				ctx: deps.ctx,
				settings,
				kind: "reviewer",
				label: `deep review: ${entry.lens}${entry.shard ? ` [shard ${entry.shard.index}/${entry.shard.count}]` : ""}`,
				prompt,
				persona: REVIEWER_PERSONA,
				outputSchema: REVIEWER_SCHEMA,
				parent: run.agent,
				signal,
				logger: deps.logger,
				guardProfile: "static",
			});
		}
		if (!result.ok) {
			entry.state = "failed";
			entry.error = result.reason;
			entry.containment = result.containment;
			return;
		}
		entry.error = undefined;
		entry.containment = result.containment;
		// Succeeded only after the findings loop: a mid-normalization throw must
		// leave the entry pended, not falsely succeeded.
		for (const finding of normalizeFindings(result.structured, entry, run, settings)) {
			run.rawFindings.set(finding.id, finding);
		}
		entry.state = "succeeded";
	});
	// A pool-callback throw (a plugin-internal error) is converted by
	// mapPoolTotal into a dropped {ok:false} value — surface it as a failed
	// reviewer with its diagnostic instead of a silent "pending" entry.
	for (let i = 0; i < retry.length; i++) {
		const value = settledScan[i];
		if (value && value.ok === false && retry[i].state !== "succeeded") {
			retry[i].state = "failed";
			retry[i].error = value.reason;
		}
	}
	// A spent budget is the cause behind every in-call cancellation above:
	// name it on each affected entry (budgetCancellation), where a reader looks
	// for why a worker stopped, not only in the render's aggregate warning.
	if (budgetSpent(budget, exec, run)) {
		for (const entry of retry) {
			if (entry.state === "failed") entry.error = budgetCancellation(entry.error);
		}
	}

	const succeeded = run.roster.filter((entry) => entry.state === "succeeded").length;
	const total = run.roster.length;
	// A spent budget with below-quorum success must not reject the call: the
	// contract (config.js) returns what is pending, and the verify gate still
	// blocks verification while the scan is partial. A genuine turn/run
	// cancellation still throws (budgetSpent is false then), with a dedicated
	// message naming the stop — the thrown isError is what the cancelled call
	// delivers (the harness replaces a body that resolves across an abort with
	// its canonical "tool call aborted"), and the re-call steer stays.
	if (total > 0 && succeeded / total < settings.minReviewerSuccess && !budgetSpent(budget, exec, run)) {
		run.scan.state = "partial";
		const failed = run.roster.filter((entry) => entry.state !== "succeeded").map((entry) => `${entry.id} (${entry.error ?? "pending"})`);
		if (exec.signal.aborted || run.controller.signal.aborted) {
			throw new Error(`the scan was cancelled with ${failed.length} of ${total} reviewers not succeeded (pending or failed: ${failed.join(", ")}). Call deep_review_scan again to retry them.`);
		}
		throw new Error(`the scan did not reach quorum: ${succeeded}/${total} reviewers succeeded. Failed: ${failed.join(", ")}. Call deep_review_scan again to retry them.`);
	}
	if (run.roster.every((entry) => entry.state === "succeeded")) run.scan.state = "complete";

	const value = {
		roster: run.roster.map((entry) => ({ id: entry.id, lens: entry.lens, scope: rosterScope(entry), state: entry.state === "succeeded" ? "succeeded" : entry.state === "failed" ? `failed (${entry.error ?? "pending"})` : "pending" })),
		findings: [...run.rawFindings.values()].map((finding) => ({
			id: finding.id,
			// Absent for defects: the structured shape of defect findings is
			// unchanged, and renderScan's "untagged = defect" convention is the
			// only kind signal the orchestrator needs.
			...(finding.kind === "simplification" ? { kind: finding.kind } : {}),
			priority: finding.priority,
			confidence: finding.confidence,
			file: finding.file,
			line: finding.line,
			claim: cap(finding.claim, 200),
		})),
		sideEffects: [...run.sideEffects],
		overlapHints: overlapHints(run.rawFindings),
		reviewersSucceeded: succeeded,
		reviewersTotal: total,
		budgetSpent: budgetSpent(budget, exec, run),
		callBudgetMs: settings.callBudgetMs,
		containmentWarning: containmentWarning(run.roster),
	};
	const cutLenses = settings.lenses.filter((lens) => !run.roster.some((entry) => entry.lens === lens));
	run.coverage = coverageLine(run.listing, run.roster, succeeded, total, cutLenses);
	return value;
}

/** Normalize one reviewer's structured findings into the run record. */
function normalizeFindings(structured, entry, run, settings) {
	const list = Array.isArray(structured?.findings) ? structured.findings : [];
	// The kind is the PLUGIN's, derived from the reviewer's lens — never from
	// worker text, the orchestrator, or repository content. It routes the
	// verification lanes and the moderation branch.
	const kind = entry.lens === "simplification" ? "simplification" : "defect";
	const out = [];
	for (const finding of list.slice(0, settings.maxFindingsPerReviewer)) {
		if (!finding?.file || !finding?.claim) continue;
		// A simplification without a behavior-preservation argument is noise:
		// `scenario` is where the lens must argue why the proposal cannot
		// change what the code does (the schema requires the field, but an
		// empty string passes it — rejected here instead).
		const scenario = cap(finding.scenario, 1000) ?? "";
		if (kind === "simplification" && !scenario.trim()) continue;
		// Simplifications are advisory: the lens is told to prefer P3/P2, and a
		// "P0 simplification" would read as defect-grade urgency. Clamp rather
		// than trust.
		let priority = PRIORITY_ENUM.includes(finding.priority) ? finding.priority : "P2";
		if (kind === "simplification" && (priority === "P0" || priority === "P1")) priority = "P2";
		const id = `${entry.id}.${out.length + 1}`;
		out.push({
			id,
			reviewerId: entry.id,
			lens: entry.lens,
			kind,
			priority,
			confidence: ["high", "medium", "low"].includes(finding.confidence) ? finding.confidence : "low",
			category: cap(finding.category, 40),
			title: cap(finding.title, 200),
			file: cap(finding.file, 300),
			line: typeof finding.line === "number" ? finding.line : undefined,
			claim: cap(finding.claim, 1000),
			scenario,
			evidence: (Array.isArray(finding.evidence) ? finding.evidence : []).slice(0, 6).map((item) => ({
				file: cap(item?.file, 300),
				line: typeof item?.line === "number" ? item.line : undefined,
				quote: cap(item?.quote, 300),
			})),
			suggestedFix: cap(finding.suggestedFix, 1000),
		});
	}
	for (const sideEffect of Array.isArray(structured?.sideEffects) ? structured.sideEffects.slice(0, 8) : []) {
		const text = cap(sideEffect, 300);
		if (text && !run.sideEffects.includes(text)) run.sideEffects.push(text);
	}
	return out;
}

/**
 * Normalized hash of one verify call's consolidation: groups sorted by
 * `primary`, `mergedFrom` sorted, `dropped` sorted by id — so a re-call with
 * semantically identical input reordered matches, while genuinely different
 * input names the difference. Dropped items hash as their id only: drop
 * reasons never reach verification (the lanes read the stored reviewer text,
 * not the consolidation), so a reworded reason must not reject a re-call whose
 * purpose is finishing pending workers.
 */
function verifyInputHash({ groups, dropped }) {
	const normalized = {
		groups: (Array.isArray(groups) ? groups : [])
			.map((group) => ({ primary: group?.primary, mergedFrom: [...(group?.mergedFrom ?? [])].sort() }))
			.sort((a, b) => String(a.primary).localeCompare(String(b.primary))),
		dropped: (Array.isArray(dropped) ? dropped : []).map((item) => item?.id).sort(),
	};
	return JSON.stringify(normalized);
}

/**
 * Execute one `deep_review_verify` call: run the lanes over the assessments,
 * apply the citation gate and the moderator, and render the findings.
 */
async function executeVerify(deps, exec) {
	const run = requireRun(deps, exec);
	const settings = run.settings;
	if (run.scan.state === "none") {
		throw new Error("The scan has not run. Call deep_review_scan first; it returns the raw findings to consolidate.");
	}
	// The quorum gate (scanCounted): a scan above deep.minReviewerSuccess counts
	// for verification with failed reviewers' scopes uncovered — the coverage
	// line reports the success count — so one persistently-failing reviewer (a
	// scan re-call re-runs the doomed worker) can never void verification. Below
	// the fraction the scan is retried: a re-call finishes the pending and
	// failed reviewers.
	if (!scanCounted(run, settings.minReviewerSuccess)) {
		const total = run.roster.length;
		const succeeded = run.roster.filter((entry) => entry.state === "succeeded").length;
		throw new Error(`the scan did not reach quorum: ${succeeded}/${total} reviewers succeeded (${settings.minReviewerSuccess} required). Call deep_review_scan again; it finishes only the reviewers still pending.`);
	}
	const input = { groups: exec.arguments?.groups ?? [], dropped: exec.arguments?.dropped ?? [] };
	const inputHash = verifyInputHash(input);
	if (run.verify.state === "complete") {
		// The idempotent early-return is only for identical re-calls: a
		// different consolidation after completion is a protocol violation the
		// orchestrator must see, never silently answered with the stale result.
		if (run.verify.inputHash !== inputHash) {
			throw new Error("This verification is complete: a re-call named different groups. Re-run the review to verify a different consolidation.");
		}
		return run.verify.result;
	}
	if (run.verify.state === "partial" && run.verify.inputHash !== inputHash) {
		throw new Error("This verification is partial: a previous call named different groups. Re-call deep_review_verify with the same groups and dropped findings to finish the pending verifier runs.");
	}
	const { signal, budget } = callSignal(run, exec, settings);
	if (run.verify.state === "none") {
		const lanes = applicableLanes(settings, hasDiff(run.target));
		const validated = validateVerificationInput(input, run.rawFindings, settings, lanes, hasDiff(run.target));
		if (!validated.ok) throw new Error(validated.error);
		run.verify.inputHash = inputHash;
		run.verify.assessments = validated.assessments;
		run.verify.lanes = lanes;
		run.verify.dropped = input.dropped;
		// The audit state describes the roster that produced THIS consolidation:
		// sampled once here and stored, so a scan re-call that heals a reviewer
		// after consolidation began can never make the shipped disclosure claim
		// an audit over findings the verification never saw.
		run.verify.simplificationAudit = simplificationAuditState(run.roster, settings);
		run.verify.state = "partial";
	}

	const lanes = run.verify.lanes;
	const assessments = run.verify.assessments;
	// One (lane, chunk) = one verifier run, keyed by stable unit ids so a partial
	// re-call re-runs only the failed units. groupsForLane (shared with the
	// plannedRuns mirror in consolidate.js) routes each lane to its groups:
	// defect lanes over defect groups, the simplifier over simplification
	// groups, provenance over all kinds on diff targets.
	if (!run.verify.units) {
		run.verify.units = new Map();
		const targetHasDiff = hasDiff(run.target);
		for (const lane of lanes) {
			const laneGroups = groupsForLane(lane, assessments, targetHasDiff);
			if (laneGroups.length === 0) continue;
			const configured = settings.lanes[lane.id];
			const runs = planLaneRuns(lane.id, laneGroups, { chunkSize: configured?.chunkSize ?? lane.chunkSize, seed: run.seed });
			runs.forEach((unit, index) => {
				run.verify.units.set(`${lane.id}#${index + 1}`, { lane, ...unit, state: "pending" });
			});
		}
	}
	const retry = [...run.verify.units.values()].filter((unit) => unit.state !== "succeeded");
	// ONE shared pool for the whole verify phase, sized by the same setting as
	// the scan's reviewer pool (`deep.concurrency`), so both fleet phases hold
	// the same number of simultaneous agents. The executing (reproducer) lanes
	// keep a sub-cap inside that pool — they run tests in the shared working
	// tree, and the old standalone executing pool's bound survives as a
	// scheduling limit, not a second pool.
	const settledVerify = await mapPoolTotal(retry, (unit) => (unit.lane.guard === "executing" ? "executing" : "static"), { total: settings.concurrency, perGroup: { executing: EXECUTING_CONCURRENCY_CAP } }, async (unit) => {
		if (signal.aborted) return;
		const prompt = buildVerifierPrompt({
			lane: unit.lane,
			reports: unit.reports,
			targetDescription: run.targetLabel,
			modeFocus: run.modePrompt,
			// The steering block re-reads at build time, so a user message
			// inserted mid-call reaches units whose prompt builds after it.
			steering: run.ledger.block(),
			promptOptions: run.promptOptions,
			chunkIndex: unit.chunkIndex,
			chunkCount: unit.chunkCount,
		});
		let result = { ok: false, reason: "not attempted" };
		for (let attempt = 0; attempt <= settings.verifierRetries && !result.ok; attempt++) {
			if (signal.aborted) break;
			result = await runAgent({
				ctx: deps.ctx,
				settings,
				kind: "verifier",
				label: `deep verify [${unit.lane.id}] ${unit.chunkIndex}/${unit.chunkCount}`,
				prompt,
				persona: unit.lane.persona,
				outputSchema: verifierSchema(unit.lane.id),
				parent: run.agent,
				signal,
				logger: deps.logger,
				guardProfile: unit.lane.guard,
				options: settings.lanes[unit.lane.id]?.agentOptions,
			});
		}
		if (!result.ok) {
			unit.state = "failed";
			unit.error = result.reason;
			unit.containment = result.containment;
			return;
		}
		unit.error = undefined;
		unit.containment = result.containment;
		// Accounting: every ref the unit was assigned must appear in its results.
		// Succeeded only after the accounting loop: a mid-accounting throw must
		// leave the unit pended, not falsely succeeded.
		const seen = new Set();
		for (const raw of Array.isArray(result.structured?.results) ? result.structured.results : []) {
			const groupId = unit.refMap.get(raw?.ref);
			if (!groupId) continue;
			seen.add(raw.ref);
			setLaneResult(run, groupId, unit.lane, normalizeLaneResult(raw, unit.lane.id));
		}
		for (const [ref, groupId] of unit.refMap) {
			if (!seen.has(ref)) setLaneResult(run, groupId, unit.lane, "unassessed");
		}
		// A unit that did not return every assigned ref failed: a permanently
		// "unassessed" row withholds the finding forever, and only a failed unit
		// is retried by a re-call.
		if (seen.size < unit.refMap.size) {
			unit.state = "failed";
			unit.error = `omitted ${unit.refMap.size - seen.size} of ${unit.refMap.size} assigned reports`;
			return;
		}
		unit.state = "succeeded";
	});
	// A pool-callback throw (a plugin-internal error) is converted by
	// mapPoolTotal into a dropped {ok:false} value — surface it as a failed
	// verifier with its diagnostic instead of a silent "pending" entry.
	for (let i = 0; i < retry.length; i++) {
		const value = settledVerify[i];
		if (value && value.ok === false && retry[i].state !== "succeeded") {
			retry[i].state = "failed";
			retry[i].error = value.reason;
		}
	}
	// The scan's budget rewrite, verbatim: a spent verify call is what its
	// "verifier was cancelled" unit errors mean, and the unit failure is where
	// the reader looks (the rendered per-finding unverified reasons).
	if (budgetSpent(budget, exec, run)) {
		for (const unit of retry) {
			if (unit.state === "failed") unit.error = budgetCancellation(unit.error);
		}
	}

	const laneResults = run.laneResults;
	// The citation gate: cited stances without a verifiable citation demote.
	for (const [groupId, rows] of laneResults) {
		for (const lane of lanes) {
			if (!lane.cited) continue;
			const gated = await gateStance(run.cwd, rows[lane.id], lane.cited);
			if (gated) rows[lane.id] = { ...rows[lane.id], outcome: gated.outcome, citationNote: gated.note };
		}
	}

	const moderated = moderate({ assessments, laneResults, hasDiff: hasDiff(run.target) });
	const classified = classify(moderated, run.aggressive);
	// The post-pool snapshot is bookkeeping: a spent budget must not reject the
	// call after the verification ran — the contract returns what is pending.
	const treeAfter = await snapshotTree(deps.ctx, run.cwd, bookkeepingSignal(exec, run));
	const tree = treeDiff(run.scan.treeBefore, treeAfter);
	const pendingUnits = [...run.verify.units.values()].filter((unit) => unit.state !== "succeeded").length;

	const markdown = renderFindings({
		reportable: classified.reportable,
		withheld: classified.withheld,
		dismissed: classified.dismissed,
		simplifications: classified.simplifications,
		aggressive: run.aggressive,
		// Sampled once at the first verify call (the roster that produced the
		// consolidation) and stored on the run: the shipped disclosure describes
		// the scope this verification covers, whatever a later scan re-call
		// healed.
		simplificationAudit: run.verify.simplificationAudit,
		tree,
		coverage: run.coverage,
		steering: run.ledger.summary(),
		dropped: run.verify.dropped,
		// A partial verification must name its own state in the rendered text:
		// the structured pendingRuns/budgetSpent fields never reach the
		// orchestrator (the render is the output), so without this line a
		// budget-cut verify call reads as a verdict instead of an unfinished
		// one.
		pending: pendingUnits > 0 ? { units: pendingUnits, budgetMs: budgetSpent(budget, exec, run) ? settings.callBudgetMs : undefined } : undefined,
		containmentWarning: containmentWarning([...run.verify.units.values()]),
	});
	const value = {
		assessed: moderated.map((finding) => ({
			id: finding.groupId,
			outcome: finding.outcome,
			priority: finding.priority,
			location: `\`${finding.claims[0]?.file ?? "?"}${finding.claims[0]?.line ? `:${finding.claims[0].line}` : ""}\``,
		})),
		laneRuns: run.verify.units.size,
		pendingRuns: pendingUnits,
		budgetSpent: budgetSpent(budget, exec, run),
		callBudgetMs: settings.callBudgetMs,
		containmentWarning: containmentWarning([...run.verify.units.values()]),
		treeChecked: tree.checked,
		treeChanged: tree.changed,
		findingsMarkdown: markdown,
	};
	run.verify.classified = classified;
	// Persist the verify result BEFORE the completion state, so the invariant
	// "state complete ⇒ result stored" is unconditional (the same run-level
	// discipline the unit accounting keeps: succeeded only after the loop). A
	// throw between state and result would leave the run permanently "complete"
	// with no result — the idempotent early-return would answer undefined, and
	// no re-call could ever recover it. A partial result is never returned
	// idempotently (every re-call recomputes), so the store stays conditional.
	if (pendingUnits === 0) {
		run.verify.result = value;
		// A mid-pipeline release marker must not outlive a later completion.
		run.incomplete = undefined;
		run.verify.state = "complete";
	}
	return value;
}

/** Store one lane result for one group. */
function setLaneResult(run, groupId, lane, result) {
	if (!run.laneResults.has(groupId)) run.laneResults.set(groupId, {});
	run.laneResults.get(groupId)[lane.id] = result;
}

/** Cap one lane result's free-text fields to the run record. */
function normalizeLaneResult(raw, laneId) {
	const outcomes = LANE_OUTCOMES[laneId] ?? ["unclear"];
	const normalized = {
		outcome: outcomes.includes(raw?.outcome) ? raw.outcome : "unclear",
		notes: cap(raw?.notes, 1500) ?? "",
		whatWouldChangeMyMind: cap(raw?.whatWouldChangeMyMind, 500),
		evidence: (Array.isArray(raw?.evidence) ? raw.evidence : []).slice(0, 8).map((item) => ({
			file: cap(item?.file, 300),
			line: typeof item?.line === "number" ? item.line : undefined,
			quote: cap(item?.quote, 300),
		})),
	};
	if (laneId === "reproducer") {
		normalized.method = raw?.method === "executed" ? "executed" : "none";
		normalized.exercisedScenario = cap(raw?.exercisedScenario, 500);
		normalized.reproduction = cap(raw?.reproduction, 2000);
	}
	if (laneId === "impact") {
		normalized.priority = ["P0", "P1", "P2", "P3"].includes(raw?.priority) ? raw.priority : undefined;
		normalized.blastRadius = ["local", "module", "system", "user-data"].includes(raw?.blastRadius) ? raw.blastRadius : undefined;
	}
	if (laneId === "fix-auditor") {
		normalized.fixVerdict = ["sound", "flawed", "absent"].includes(raw?.fixVerdict) ? raw.fixVerdict : "absent";
		normalized.problems = (Array.isArray(raw?.problems) ? raw.problems : []).slice(0, 8).map((problem) => cap(problem, 500)).filter(Boolean);
		normalized.revisedSuggestion = cap(raw?.revisedSuggestion, 1000);
	}
	return normalized;
}
