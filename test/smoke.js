/**
 * Smoke test for `@apcamargo/dsh-review` against mock harness services.
 *
 * Exercises the command grammar, the review prompt assembly, durable state
 * transitions, and the plugin lifecycle — no LLM, no real git required.
 *
 * @module @apcamargo/dsh-review/smoke
 */

import assert from "node:assert/strict";
import { apply, name, inject } from "../lib/index.js";
import { REVIEW_DOMAIN_SPEC } from "../lib/state.js";
import { REVIEW_RUBRIC, AGGRESSIVE_PROMPT, REVIEW_SUMMARY_PROMPT, REVIEW_FIX_FINDINGS_PROMPT } from "../lib/prompts.js";

/** In-memory KV table mock validating records at the durable boundary. */
function makeTable() {
	const records = new Map();
	return {
		get: (key) => records.get(key),
		put: async (key, value) => {
			// The storage-domain facility validates every stored record against the
			// spec's zod schema at the durable boundary; mirror that here.
			REVIEW_DOMAIN_SPEC.tables.sessions.valueSchema.parse(value);
			records.set(key, structuredClone(value));
		},
		delete: async (key) => records.delete(key),
		update: async (key, fn) => {
			// The real `update` rejects with the stable `missing-key` code when the
			// record was never written; mirror that so `updateSessionRecord`'s
			// materialize path is exercised.
			if (!records.has(key)) {
				const error = new Error(`domain 'review' table 'sessions' has no record '${key}' to update`);
				error.code = "missing-key";
				throw error;
			}
			const next = fn(records.get(key));
			REVIEW_DOMAIN_SPEC.tables.sessions.valueSchema.parse(next);
			records.set(key, structuredClone(next));
			return structuredClone(next);
		},
		entries: () => records.entries(),
		keys: () => records.keys(),
		get size() {
			return records.size;
		},
	};
}

/**
 * Toggleable simulation state: the repository probe, spawn failures, the
 * `git status` outcome, a hung subprocess, and the argv of every spawned command.
 */
const mockState = {
	gitRepository: true,
	spawnFailure: null,
	ghFailure: null,
	prViewStdout: JSON.stringify({ baseRefName: "main", title: "Add feature", headRefName: "feature" }),
	checkoutCode: 0,
	checkoutStderr: "",
	localBranches: "feature\nmain\n",
	statusStdout: " M src/index.ts\n",
	statusCode: 0,
	statusLossy: false,
	hang: null,
	spawned: [],
};

/** Mock `git`/`gh` command responses keyed by argv prefix; exit codes follow real git (128 = fatal). */
const GIT_RESPONSES = [
	{ match: (argv) => argv[1] === "rev-parse" && argv[2] === "--git-dir", stdout: () => (mockState.gitRepository ? ".git" : ""), code: () => (mockState.gitRepository ? 0 : 128) },
	{ match: (argv) => argv[1] === "rev-parse", code: 128, stdout: "" },
	{
		match: (argv) => argv[1] === "status" && argv[2] === "--porcelain",
		stdout: () => mockState.statusStdout,
		code: () => mockState.statusCode,
		lossy: () => mockState.statusLossy,
	},
	{ match: (argv) => argv[1] === "branch" && argv[2] === "--show-current", stdout: "feature" },
	{ match: (argv) => argv[1] === "symbolic-ref", code: 128, stdout: "" },
	{ match: (argv) => argv[1] === "branch", stdout: () => mockState.localBranches },
	{ match: (argv) => argv[1] === "merge-base", stdout: "abc123def" },
	{ match: (argv) => argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view", stdout: () => mockState.prViewStdout },
	{
		match: (argv) => argv[0] === "gh" && argv[1] === "pr" && argv[2] === "checkout",
		stdout: "",
		stderr: () => mockState.checkoutStderr,
		code: () => mockState.checkoutCode,
	},
	{ match: (argv) => argv[0] === "gh", stdout: "gh version 2.0.0" },
];

/** Subprocess seam mock serving the canned git responses. */
const subprocess = {
	spawn(spec) {
		mockState.spawned.push(spec.argv);
		// A hung child: `done` settles only when the caller's signal aborts, as the
		// real seam does after its terminate escalation.
		if (mockState.hang?.(spec.argv)) {
			return {
				done: new Promise((resolve) => {
					spec.signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGTERM" }), { once: true });
				}),
				collected: {
					stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
					stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
				},
				terminate: () => {},
				waitForExit: async () => true,
			};
		}
		// A missing executable: the real seam's `done` REJECTS with a plain
		// ENOENT-shaped Error (never SubprocessExecutableNotFoundError); mirror
		// that so the runCommand degradation path is exercised.
		const failure = mockState.spawnFailure ?? (mockState.ghFailure && spec.argv[0] === "gh" ? mockState.ghFailure : null);
		if (failure) {
			const error = new Error(failure);
			error.code = "ENOENT";
			return {
				done: Promise.reject(error),
				collected: {
					stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
					stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
				},
				terminate: () => {},
				waitForExit: async () => true,
			};
		}
		const response = GIT_RESPONSES.find((entry) => entry.match(spec.argv)) ?? { code: 1, stdout: "" };
		const stdout = typeof response.stdout === "function" ? response.stdout() : response.stdout ?? "";
		const code = typeof response.code === "function" ? response.code() : response.code ?? 0;
		const stderr = response.stderr?.() ?? "";
		const lossy = response.lossy?.() ?? false;
		return {
			done: Promise.resolve({ exitCode: code, signal: null }),
			collected: {
				stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy }) },
				stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
			},
			terminate: () => {},
			waitForExit: async () => true,
		};
	},
};

/** Domain facility mock opening the review domain over in-memory tables. */
const storageDomain = {
	async open(spec) {
		return {
			name: spec.name,
			close: async () => {},
			table: () => sharedTable,
		};
	},
};

/** Shared in-memory table so a simulated restart sees the same medium. */
const sharedTable = makeTable();

/** Command registry mock capturing registrations. */
const registered = [];
const commands = {
	register(definition) {
		registered.push(definition);
		return () => registered.splice(registered.indexOf(definition), 1);
	},
};

/** Effect collector mock running the generator body and keeping disposers. */
const effects = [];
function makeCtx() {
	return {
		commands,
		subprocess,
		storageDomain,
		effect(execute, label) {
			const iterator = execute();
			for (const disposer of iterator) effects.push({ label, disposer });
		},
	};
}

const SESSION_ID = "session-test-0001";
const AGENT = {
	id: SESSION_ID,
	session: { header: { cwd: process.cwd() } },
	followups: [],
	followup(message) {
		this.followups.push(message);
	},
};

/** Invoke one registered command as the dispatching adapter would. */
async function runCommand(commandName, rawInput, signal = new AbortController().signal) {
	const definition = registered.find((entry) => entry.name === commandName);
	assert.ok(definition, `command ${commandName} registered`);
	return definition.handler({
		commandId: "test-command-id",
		agent: AGENT,
		rawInput,
		attachments: [],
		signal,
	});
}

/** Reject when `promise` has not settled within `ms`, so a hang fails the test instead of stalling it. */
function settlesWithin(promise, ms, label) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function main() {
	// Plugin shape.
	assert.equal(name, "review");
	assert.deepEqual(inject, ["commands", "subprocess", "storageDomain"]);

	// apply() opens the domain and registers both commands.
	const ctx = makeCtx();
	await apply(ctx);
	assert.deepEqual(registered.map((entry) => entry.name).sort(), ["end-review", "review"]);
	const review = registered.find((entry) => entry.name === "review");
	assert.match(review.description, /Review code changes/);
	for (const subcommand of ["uncommitted", "branch", "commit", "pr", "folder", "instructions", "status"]) {
		assert.ok(review.input?.hint.includes(subcommand), `hint advertises ${subcommand}`);
	}

	// Status: no review active, no instructions.
	let result = await runCommand("review", "status");
	assert.equal(result.kind, "success");
	assert.match(result.text, /no review active/);
	assert.match(result.text, /\(none\)/);

	// Instructions: set, render, clear.
	result = await runCommand("review", "instructions focus on performance regressions");
	assert.equal(result.kind, "success");
	assert.match(result.text, /saved: "focus on performance regressions"/);
	result = await runCommand("review", "instructions clear");
	assert.equal(result.kind, "success");
	assert.match(result.text, /removed/);

	// The quoted form is the escape hatch that stores the literal word; the bare
	// form is the control word (case-insensitively). Stored values never contain
	// stray quote chars.
	result = await runCommand("review", "instructions \"clear\"");
	assert.equal(result.kind, "success");
	assert.match(result.text, /saved: "clear"/);
	result = await runCommand("review", "instructions Clear");
	assert.equal(result.kind, "success");
	assert.match(result.text, /removed/);
	result = await runCommand("review", "instructions");
	assert.equal(result.kind, "error");
	assert.match(result.text, /need text/);

	// Flags compose with `instructions` and `status` exactly as with the modes.
	result = await runCommand("review", "--aggressive instructions focus on performance");
	assert.equal(result.kind, "success");
	assert.match(result.text, /saved: "focus on performance"/);
	result = await runCommand("review", "--aggressive status");
	assert.equal(result.kind, "success");
	assert.match(result.text, /no review active/);

	// A mode keyword missing its required argument answers with that mode's usage
	// line, queues nothing, and starts no review.
	for (const [input, usageLine] of [
		["commit", "/review commit <sha> [<title>]"],
		["pr", "/review pr <number|url>"],
		["folder", "/review folder <paths...>"],
	]) {
		result = await runCommand("review", input);
		assert.equal(result.kind, "error", `/review ${input} without an argument is a usage error`);
		assert.ok(result.text.includes(usageLine), `/review ${input} usage names ${usageLine}`);
	}
	assert.equal(AGENT.followups.length, 0);
	result = await runCommand("review", "status");
	assert.match(result.text, /no review active/);

	// Bare invocation defaults to an uncommitted-changes review.
	result = await runCommand("review", "");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Review started: current changes/);
	assert.equal(AGENT.followups.length, 1);
	const reviewMessage = AGENT.followups[0];
	// The harness has no shared plugin source kind: the turn names its producer.
	assert.deepEqual(reviewMessage.source, { kind: "apcamargo-dsh-review" });
	assert.ok(reviewMessage.content[0].text.startsWith(REVIEW_RUBRIC));
	assert.ok(reviewMessage.content[0].text.includes("Review the current code changes"));

	// Base rubric techniques (default mode): two-pass method, confidence rule,
	// false-positive blacklist, failure-path tracing, output confidence tagging.
	assert.ok(reviewMessage.content[0].text.includes("First pass over the diff alone"));
	assert.ok(reviewMessage.content[0].text.includes("Second pass with full context"));
	assert.ok(reviewMessage.content[0].text.includes("Report suspicions as suspicions"));
	assert.ok(reviewMessage.content[0].text.includes("explicitly silenced in the code"));
	assert.ok(reviewMessage.content[0].text.includes("Trace failure paths"));
	assert.ok(reviewMessage.content[0].text.includes("Tag each finding with its confidence"));
	// The aggressive appendix is absent from the default prompt.
	assert.ok(!reviewMessage.content[0].text.includes(AGGRESSIVE_PROMPT));

	// State is active now.
	result = await runCommand("review", "status");
	assert.match(result.text, /Status: active/);
	assert.match(result.text, /current changes/);

	// A second review while active is refused.
	result = await runCommand("review", "branch main");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Already in a review/);

	// end-review summarize: handoff prompt queued, state cleared.
	result = await runCommand("end-review", "summarize");
	assert.equal(result.kind, "success");
	assert.equal(AGENT.followups.length, 2);
	assert.ok(AGENT.followups[1].content[0].text.startsWith(REVIEW_SUMMARY_PROMPT));
	result = await runCommand("review", "status");
	assert.match(result.text, /no review active/);

	// end-review with no active review fails loud.
	result = await runCommand("end-review", "done");
	assert.equal(result.kind, "error");
	assert.match(result.text, /No review is active/);

	// end-review fix: fix prompt queued.
	result = await runCommand("review", "commit abc123def my title");
	assert.equal(result.kind, "success");
	assert.match(result.text, /commit abc123d: my title/);
	result = await runCommand("end-review", "fix");
	assert.equal(result.kind, "success");
	assert.equal(AGENT.followups.length, 4);
	assert.ok(AGENT.followups[3].content[0].text.startsWith(REVIEW_FIX_FINDINGS_PROMPT));

	// Branch review bakes the merge base into the prompt.
	result = await runCommand("review", "branch main");
	assert.equal(result.kind, "success");
	const branchMessage = AGENT.followups[4];
	assert.ok(branchMessage.content[0].text.includes("Review the code changes against the base branch 'main'"));
	assert.ok(branchMessage.content[0].text.includes("abc123def"));
	result = await runCommand("end-review", "done");
	assert.equal(result.kind, "success");

	// Folder review renders the snapshot prompt.
	result = await runCommand("review", "folder src docs");
	assert.equal(result.kind, "success");
	assert.ok(AGENT.followups[5].content[0].text.includes("Review the code in the following paths: src, docs"));
	await runCommand("end-review", "done");

	// --extra rides through to the prompt.
	result = await runCommand("review", "uncommitted --extra \"focus on error handling\"");
	assert.equal(result.kind, "success");
	assert.ok(AGENT.followups[6].content[0].text.includes("Additional user-provided review instruction"));
	await runCommand("end-review", "done");

	// Shared instructions ride through to every review prompt.
	await runCommand("review", "instructions prefer fail-fast error handling");
	result = await runCommand("review", "uncommitted");
	assert.ok(AGENT.followups[7].content[0].text.includes("Shared custom review instructions"));
	await runCommand("end-review", "done");

	// --aggressive flips the stance: appendix present, result + status labeled.
	result = await runCommand("review", "uncommitted --aggressive");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Review started: current changes \(aggressive\)/);
	const aggressiveMessage = AGENT.followups[8];
	assert.ok(aggressiveMessage.content[0].text.includes(AGGRESSIVE_PROMPT));
	result = await runCommand("review", "status");
	assert.match(result.text, /current changes \(aggressive\)/);
	await runCommand("end-review", "done");

	// --aggressive before the mode and --aggressive=true are tolerated; composes with --extra.
	result = await runCommand("review", "--aggressive=true branch main --extra \"error budget\"");
	assert.equal(result.kind, "success");
	assert.match(result.text, /changes against 'main' \(aggressive\)/);
	const composedMessage = AGENT.followups[9];
	assert.ok(composedMessage.content[0].text.includes(AGGRESSIVE_PROMPT));
	assert.ok(composedMessage.content[0].text.includes("Additional user-provided review instruction"));
	await runCommand("end-review", "done");

	// Any non-mode text is a custom review focus: the sentence becomes the focus.
	result = await runCommand("review", "check if the commands are working in the way they are supposed to.");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Review started: focus: check if the commands are working/);
	const customMessage = AGENT.followups[10];
	assert.ok(customMessage.content[0].text.includes("check if the commands are working in the way they are supposed to."));
	result = await runCommand("review", "status");
	assert.match(result.text, /focus: check if the commands are working/);
	await runCommand("end-review", "done");

	// Custom focus composes with --aggressive.
	result = await runCommand("review", "--aggressive check the error handling");
	assert.equal(result.kind, "success");
	const customAggressiveMessage = AGENT.followups[11];
	assert.ok(customAggressiveMessage.content[0].text.includes("check the error handling"));
	assert.ok(customAggressiveMessage.content[0].text.includes(AGGRESSIVE_PROMPT));
	await runCommand("end-review", "done");

	// A multi-word input whose head is a control word stays a custom focus
	// (goal-style whole-input convention, preserved by the sole-token guard).
	result = await runCommand("review", "status extra words");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Review started: focus: status extra words/);
	await runCommand("end-review", "done");

	// Bare `/review branch` (no name) compares the current branch to the
	// repository's default branch: no origin/HEAD symbolic ref in the mock, so
	// the local main wins. The baseBranch prompt assembly itself is pinned by
	// the named-branch review above.
	result = await runCommand("review", "branch");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Review started: changes against 'main'/);
	await runCommand("end-review", "done");

	// No `main` branch anywhere: master is the fallback. (The case where
	// neither main nor master exists is pinned against real git in the
	// integration test.)
	mockState.localBranches = "feature\nmaster\n";
	result = await runCommand("review", "branch");
	assert.equal(result.kind, "success");
	assert.match(result.text, /Review started: changes against 'master'/);
	await runCommand("end-review", "done");
	mockState.localBranches = "feature\nmain\n";

	// Bare `/end-review` (no mode) defaults to summarize: the handoff prompt is
	// queued and the review state is cleared.
	result = await runCommand("review", "uncommitted");
	assert.equal(result.kind, "success");
	result = await runCommand("end-review", "");
	assert.equal(result.kind, "success");
	assert.ok(AGENT.followups[16].content[0].text.startsWith(REVIEW_SUMMARY_PROMPT));
	result = await runCommand("review", "status");
	assert.match(result.text, /no review active/);

	// Finishing drops the finished review's run state: the durable record agrees
	// with the derived "no review active" status.
	const recordAfterDone = sharedTable.get(SESSION_ID);
	assert.equal(recordAfterDone.active, false);
	assert.equal(recordAfterDone.targetKind, undefined);
	assert.equal(recordAfterDone.target, undefined);
	assert.equal(recordAfterDone.startedAt, undefined);

	// end-review bare grammar error.
	result = await runCommand("end-review", "bogus");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Usage: \/end-review/);

	// Outside a git repository, the bare default and explicit git-dependent
	// modes fail loud with the same folder-review guidance.
	mockState.gitRepository = false;
	result = await runCommand("review", "uncommitted");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Not a git repository/);
	assert.match(result.text, /\/review folder/);
	result = await runCommand("review", "");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Not a git repository/);
	assert.match(result.text, /\/review folder/);
	// Folder and custom reviews keep working (their prompt content is pinned
	// above; the behavioral point here is availability outside a repository).
	result = await runCommand("review", "folder src docs");
	assert.equal(result.kind, "success");
	await runCommand("end-review", "done");
	result = await runCommand("review", "check the error budget");
	assert.equal(result.kind, "success");
	await runCommand("end-review", "done");
	mockState.gitRepository = true;

	// A missing `gh` (git still available): the PR review degrades to the
	// GitHub CLI install guidance instead of a raw spawn error.
	mockState.ghFailure = "spawn gh ENOENT";
	result = await runCommand("review", "pr 123");
	assert.equal(result.kind, "error");
	assert.match(result.text, /requires GitHub CLI/);
	assert.match(result.text, /cli\.github\.com/);
	mockState.ghFailure = null;

	// The PR review checks out a branch, so it fails closed when the working-tree
	// check cannot be trusted. The healthy run is the control: the same setup
	// proceeds to the checkout.
	mockState.statusStdout = "";
	mockState.spawned.length = 0;
	result = await runCommand("review", "pr 123");
	assert.equal(result.kind, "success");
	assert.match(result.text, /PR #123/);
	assert.ok(mockState.spawned.some((argv) => argv[0] === "gh" && argv[2] === "checkout"), "healthy run checks the PR out");
	await runCommand("end-review", "done");
	for (const [label, outcome] of [
		["git status exits with a fatal error", { statusCode: 128 }],
		["git status output is truncated", { statusLossy: true }],
	]) {
		Object.assign(mockState, outcome);
		mockState.spawned.length = 0;
		result = await runCommand("review", "pr 123");
		assert.equal(result.kind, "error", label);
		assert.match(result.text, /git status/, `${label}: the error names the failing command`);
		assert.ok(!mockState.spawned.some((argv) => argv[0] === "gh" && argv[2] === "checkout"), `${label}: no checkout`);
		mockState.statusCode = 0;
		mockState.statusLossy = false;
	}
	mockState.statusStdout = " M src/index.ts\n";

	// An invalid reference is rejected before any `gh` or `git` command runs, even
	// with a dirty tree or a missing `gh`.
	for (const ghFailure of [null, "spawn gh ENOENT"]) {
		mockState.ghFailure = ghFailure;
		mockState.spawned.length = 0;
		result = await runCommand("review", "pr abc");
		assert.equal(result.kind, "error");
		assert.match(result.text, /Invalid PR reference/);
		// Only the repository probe runs; no `gh` and no `git status`.
		assert.ok(
			mockState.spawned.every((argv) => argv[0] === "git" && argv[1] === "rev-parse"),
			"an invalid reference runs no gh or status command",
		);
	}
	mockState.ghFailure = null;

	// Pending-changes checks ignore untracked files at the source.
	mockState.statusStdout = "";
	mockState.spawned.length = 0;
	result = await runCommand("review", "pr 123");
	assert.equal(result.kind, "success");
	assert.ok(
		mockState.spawned.some((argv) => argv[1] === "status" && argv.includes("--untracked-files=no")),
		"status skips the untracked scan",
	);
	await runCommand("end-review", "done");

	// A failing checkout keeps the tail of a noisy stderr, where the real cause is.
	mockState.checkoutCode = 1;
	mockState.checkoutStderr = `${"progress line\n".repeat(400)}fatal: cannot switch branch`;
	result = await runCommand("review", "pr 123");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Failed to checkout PR/);
	assert.match(result.text, /fatal: cannot switch branch/);
	mockState.checkoutCode = 0;
	mockState.checkoutStderr = "";

	// `gh pr view` output that is not the expected JSON fails with the command named and checks nothing out.
	for (const [label, stdout] of [
		["non-JSON output", "Update available!\n"],
		["JSON without the PR fields", "{}"],
	]) {
		mockState.prViewStdout = stdout;
		mockState.spawned.length = 0;
		result = await runCommand("review", "pr 123");
		assert.equal(result.kind, "error", label);
		assert.match(result.text, /gh pr view/, `${label}: the error names the failing command`);
		assert.ok(!mockState.spawned.some((argv) => argv[0] === "gh" && argv[2] === "checkout"), `${label}: no checkout`);
	}
	mockState.prViewStdout = JSON.stringify({ baseRefName: "main", title: "Add feature", headRefName: "feature" });
	mockState.statusStdout = " M src/index.ts\n";

	// A missing `git` entirely: the git-dependent forms say git cannot run (not
	// that the directory is no repository), and the snapshot review keeps working.
	mockState.spawnFailure = "spawn git ENOENT";
	result = await runCommand("review", "uncommitted");
	assert.equal(result.kind, "error");
	assert.match(result.text, /Cannot run git/);
	assert.doesNotMatch(result.text, /Not a git repository/);
	result = await runCommand("review", "folder src docs");
	assert.equal(result.kind, "success");
	await runCommand("end-review", "done");
	mockState.spawnFailure = null;

	// A command whose request was already cancelled queues nothing and starts no review.
	const followupsBeforeCancel = AGENT.followups.length;
	result = await runCommand("review", "folder src docs", AbortSignal.abort());
	assert.equal(result.kind, "error");
	assert.match(result.text, /cancelled/i);
	assert.equal(AGENT.followups.length, followupsBeforeCancel);
	result = await runCommand("review", "status");
	assert.match(result.text, /no review active/);

	// Simulated restart: a fresh apply() over the same medium keeps state.
	await runCommand("review", "uncommitted");
	const restartCtx = makeCtx();
	await apply(restartCtx);
	assert.equal(registered.length, 4); // 2 before restart + 2 after
	const statusAfterRestart = await runCommand("review", "status");
	assert.match(statusAfterRestart.text, /Status: active/);
	await runCommand("end-review", "done");

	// Unregistration disposes the commands.
	for (const { disposer } of effects) await disposer();
	assert.equal(registered.length, 0);

	// Unloading mid-command: the in-flight command is cancelled and settles
	// before the review domain closes, so no handler writes to a closed domain.
	{
		const timeline = [];
		const lifecycleRegistered = [];
		const lifecycleDisposers = [];
		const lifecycleCtx = {
			commands: {
				register(definition) {
					lifecycleRegistered.push(definition);
					return () => {};
				},
			},
			subprocess,
			storageDomain: {
				async open(spec) {
					return { name: spec.name, close: async () => void timeline.push("domain closed"), table: () => makeTable() };
				},
			},
			effect(execute) {
				for (const disposer of execute()) lifecycleDisposers.push(disposer);
			},
		};
		await apply(lifecycleCtx);
		const review = lifecycleRegistered.find((entry) => entry.name === "review");
		mockState.hang = (argv) => argv[0] === "gh" && argv[1] === "--version";
		const inFlight = review
			.handler({ commandId: "lifecycle", agent: { ...AGENT, followups: [] }, rawInput: "pr 123", attachments: [], signal: new AbortController().signal })
			.then((outcome) => {
				timeline.push("command settled");
				return outcome;
			});
		// Cordis starts disposers in reverse registration order, async ones concurrently.
		await Promise.all([...lifecycleDisposers].reverse().map((disposer) => disposer()));
		const outcome = await settlesWithin(inFlight, 1000, "in-flight command");
		mockState.hang = null;
		assert.equal(outcome.kind, "error");
		assert.match(outcome.text, /cancelled/i);
		assert.deepEqual(timeline, ["command settled", "domain closed"]);
	}

	console.log("smoke: all assertions passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
