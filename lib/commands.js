/**
 * Human-facing `/review` and `/end-review` commands for the DeepSeek Harness
 * human-command registry.
 *
 * Surface adaptations from the Pi TUI:
 * - The interactive preset selector becomes command grammar. `/review` with no
 *   arguments defaults to the uncommitted-changes review, and the registered
 *   `input` hint advertises the grammar in the Web command menu.
 * - "Add/Remove custom review instructions" becomes `/review instructions <text>`
 *   and `/review instructions clear`, persisted per session.
 * - DeepSeek Harness sessions are linear (no Pi session-tree navigation), so the
 *   review runs as a follow-up turn in the current session and `/end-review`
 *   finishes it in place: summarize the findings into a structured handoff,
 *   queue the fix work, or simply mark the session done.
 *
 * @module @apcamargo/dsh-review/commands
 */

import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	GitError,
	runCommand,
	isGitRepository,
	getMergeBase,
	getDefaultBranch,
	hasPendingChanges,
	parsePrReference,
	getPrInfo,
	checkoutPr,
} from "./git.js";
import {
	REVIEW_SUMMARY_PROMPT,
	REVIEW_FIX_FINDINGS_PROMPT,
	buildReviewPrompt,
	buildModePrompt,
	buildDeepReviewPrompt,
	buildDeepSummaryPrompt,
	getUserFacingHint,
} from "./prompts.js";
import {
	getSessionRecord,
	getCustomInstructions,
	setActiveReview,
	clearActiveReview,
	setCustomInstructions,
} from "./state.js";
import { REVIEW_MESSAGE_SOURCE } from "./source.js";

/** Per-definition identities: the brand doc reads as per-definition, and no shipped plugin shares one id. */
const REVIEW_DEFINITION_ID = "@apcamargo/dsh-review/review";
const END_REVIEW_DEFINITION_ID = "@apcamargo/dsh-review/end-review";
const REVIEW_CANCELLED_MESSAGE = "Review cancelled.";
/** How each git-dependent target type reads in the "not a git repository" guidance. */
const GIT_TARGET_LABELS = { uncommitted: "uncommitted", baseBranch: "branch", commit: "commit", pr: "PR" };
const GH_SETUP_INSTRUCTIONS =
	"Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
	"Cannot checkout PR: you have uncommitted changes to tracked files. Please commit or stash them first.";
const COMMIT_SYNTAX = "/review commit <sha> [<title>]";
const PR_SYNTAX = "/review pr <number|url>";
const PATH_SYNTAX = "/review path <paths...>";
const END_REVIEW_USAGE = "Usage: /end-review [summarize|fix|done] — summarize the review, queue fixing work, or finish it.";

/** The session's working directory, or the process cwd before the first request. */
function reviewCwd(agent) {
	return agent?.session?.header?.cwd ?? process.cwd();
}

/**
 * Tokenize one argument line with quote handling; each token records the raw
 * index just past its last raw character, so callers can slice the raw
 * remainder after a head token without re-tokenizing.
 */
function tokenizeArgs(value) {
	const tokens = [];
	let current = "";
	let quote = null;
	let end = -1;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			if (char === "\\" && i + 1 < value.length) {
				current += value[i + 1];
				end = i + 1;
				i += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
				end = i;
				continue;
			}
			current += char;
			end = i;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			end = i;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) tokens.push({ text: current, end: end + 1 });
			current = "";
			continue;
		}
		current += char;
		end = i;
	}
	if (current.length > 0) tokens.push({ text: current, end: end + 1 });
	return tokens;
}

/** Strip one leading `@` file-reference marker from a path token. The composer's
 * file picker inserts `@path` text, and its quoted forms (`@"path"`, the
 * open-quote `@"dir/`) tokenize to one `@`-prefixed token, so the marker
 * survives into the parser and is stripped here — never in the tokenizer, where
 * a literal `@` is indistinguishable from the reference marker. */
function stripAtReference(token) {
	return token.startsWith("@") ? token.slice(1) : token;
}

/** The review paths for one invocation: the tokens after the keyword, each
 * with its optional `@` marker stripped. Tokens are used directly —
 * re-splitting the joined remainder would break a quoted path containing
 * whitespace (`path @"My Docs"` would read as the two paths `My` and `Docs`). */
function parseReviewPaths(tokens) {
	return tokens.map(stripAtReference).filter((item) => item.length > 0);
}

/**
 * The review paths carried by one submission's file attachments, resolved to
 * full host paths through the attachments service. A receipt carries only the
 * attachment id, display name, and byte size — an upload transmits bytes, never
 * the original location — so the stored copy's host path IS the attachment's
 * full path. Image blocks cannot be a review target and are rejected.
 * @throws when an attachment cannot resolve, so the boundary settles the command
 *   with the message instead of starting a review over phantom paths.
 */
function attachmentReviewPaths(ctx, attachments) {
	if (attachments === undefined || attachments.length === 0) return [];
	const store = ctx.get("attachments");
	if (store === undefined) {
		throw new Error("The submission carried file attachments, but no attachment store is composed in this deployment.");
	}
	return attachments.map((block) => {
		if (block.type !== "file") {
			throw new Error("Image attachments cannot be reviewed as paths. Attach or @-reference code files instead.");
		}
		const hostPath = store.fileHostPath(block.attachment);
		if (typeof hostPath !== "string" || hostPath.length === 0) {
			throw new Error(`The attached file "${block.attachment?.name ?? "unknown"}" could not be resolved to a path.`);
		}
		return hostPath;
	});
}

/** Dedupe paths by their absolute resolution against the session cwd, keeping
 * the first occurrence: the same place named twice — as text and as an
 * attachment, or across both forms — reviews once. */
function dedupePaths(cwd, paths) {
	const seen = new Set();
	const out = [];
	for (const item of paths) {
		const absolute = path.resolve(cwd, item);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		out.push(item);
	}
	return out;
}

/** Whether the invocation named no review mode: every token is a plugin flag
 * (the bare `/review` and flags-only forms). Only then can staged attachments
 * become the review target themselves without discarding a deliberate choice. */
function namesNoMode(rawInput) {
	return tokenizeArgs(rawInput).every((token) => isPluginFlag(token.text));
}

/** The plugin's own flags, in every form the partition accepts: the bare
 * flags, `--deep=true`/`--aggressive=true` (tolerated), and the value forms of
 * `--extra`, `--timeout`, and `--concurrency`. The `--extra` value guard uses
 * this so a flag directly after `--extra` is never consumed as the value (and
 * the `--timeout`/`--concurrency` guards use it the same way). */
const isPluginFlag = (text) =>
	text === "--deep" || text.startsWith("--deep=")
	|| text === "--aggressive" || text.startsWith("--aggressive=")
	|| text === "--extra" || text.startsWith("--extra=")
	|| text === "--timeout" || text.startsWith("--timeout=")
	|| text === "--concurrency" || text.startsWith("--concurrency=");

/** The seconds upper bound for `--timeout`: floor(MAX_TIMER_MS / 1000). A
 * larger value would push the derived ms above the Node timer ceiling, where
 * the timer overflow fires at ~1 ms and the derived budget floor clamps back
 * to the ceiling — a 10-digit typo must error, never silently degenerate. */
const MAX_TIMEOUT_SECONDS = 2147483;

/**
 * Parse one `--timeout` value: whole seconds only — a negative, zero,
 * fractional, suffixed (`15m`), or non-numeric value is a typo, not silence
 * (the `--aggressive` rule). The bounds are in seconds here because the
 * config schema's `min(1000)` floor is in ms: the ms conversion happens at the
 * begin-time merge, and a value above the bound would exceed MAX_TIMER_MS
 * after it.
 * @returns `{ value }` in seconds, or `{ error }` the flag's message.
 */
function parseTimeoutSeconds(raw) {
	const text = String(raw ?? "").trim();
	if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > MAX_TIMEOUT_SECONDS) {
		return { target: null, error: "The --timeout flag takes an integer number of seconds between 1 and 2147483." };
	}
	return { value: Number(text) };
}

/**
 * Parse one `--concurrency` value: whole workers only — a negative, zero,
 * fractional, suffixed (`3w`), or non-numeric value is a typo, not silence
 * (the `--timeout` rule). There is no static upper bound: the real bound is
 * the harness's active-subagent capacity, read live from the harness at
 * review start, where the value is capped (never a hardcoded maximum here).
 * @returns `{ value }` in workers, or `{ error }` the flag's message.
 */
function parseConcurrencyCount(raw) {
	const text = String(raw ?? "").trim();
	if (!/^\d+$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
		return { target: null, error: "The --concurrency flag takes an integer number of workers (1 or more). Values above the harness's active-subagent limit are capped at review start." };
	}
	return { value: Number(text) };
}

/**
 * Parse the `/review` grammar: the `instructions` and `status` subcommands
 * plus the mode subcommands and the DSH adaptation of the bare invocation.
 * Pure `@path` input (the composer file picker's text) reads as the path
 * snapshot mode with the markers stripped.
 *
 * `--extra`/`--aggressive`/`--timeout`/`--concurrency` are partitioned once,
 * before any subcommand matching, so they compose with `instructions` and
 * `status` exactly as they compose with the modes.
 */
function parseReviewArgs(rawInput) {
	const input = rawInput?.trim() ?? "";
	if (input.length === 0) return { target: { type: "uncommitted" } };

	const rawParts = tokenizeArgs(input);
	const parts = [];
	let extraInstruction;
	let aggressive = false;
	let deep = false;
	let timeoutSec;
	let concurrency;
	let headEnd;
	for (let i = 0; i < rawParts.length; i++) {
		const { text, end } = rawParts[i];
		if (text === "--deep" || text === "--deep=true") {
			deep = true;
			continue;
		}
		if (text.startsWith("--deep=")) {
			return { target: null, error: "The --deep flag takes no value. Use /review --deep, or omit the flag." };
		}
		if (text === "--extra") {
			const next = rawParts[i + 1];
			// A plugin flag directly after --extra is not the value, in every
			// form the partition accepts (`--deep=true`, `--aggressive=false`,
			// `--extra=...`): consuming one silently swallowed `--extra
			// --deep=true` into a regular review with the literal instruction
			// "--deep=true" (README says the flags compose with any mode). But
			// the guard sees the quote-stripped token: control-vs-value is
			// decided on the RAW remainder after --extra, as the instructions
			// path does — a remainder starting with a quote is the escape hatch
			// that stores the literal word (`--extra "--deep"`); the bare form
			// (`--extra --deep`) is still the control word the guard rejects.
			const nextQuoted = next !== undefined && /^['"]/.test(input.slice(end).trimStart());
			if (!next || (isPluginFlag(next.text) && !nextQuoted)) return { target: null, error: "Missing value for --extra" };
			extraInstruction = next.text;
			i += 1;
			continue;
		}
		if (text.startsWith("--extra=")) {
			extraInstruction = text.slice("--extra=".length);
			continue;
		}
		if (text === "--timeout") {
			const next = rawParts[i + 1];
			// A plugin flag directly after --timeout is not the value, in every
			// form the partition accepts: consuming one silently swallowed
			// `--timeout --deep` into the missing-value path with --deep eaten.
			// Unlike --extra there is no quoted-escape hatch: a numeric flag has
			// no control-word ambiguity, and a quoted non-number errors below.
			if (!next || isPluginFlag(next.text)) return { target: null, error: "Missing value for --timeout" };
			const seconds = parseTimeoutSeconds(next.text);
			if (seconds.error) return seconds;
			timeoutSec = seconds.value;
			i += 1;
			continue;
		}
		if (text.startsWith("--timeout=")) {
			const seconds = parseTimeoutSeconds(text.slice("--timeout=".length));
			if (seconds.error) return seconds;
			timeoutSec = seconds.value;
			continue;
		}
		if (text === "--concurrency") {
			const next = rawParts[i + 1];
			// Symmetric with --timeout: a plugin flag directly after --concurrency
			// is not the value — consuming one silently swallowed `--concurrency
			// --deep` into the missing-value path with --deep eaten.
			if (!next || isPluginFlag(next.text)) return { target: null, error: "Missing value for --concurrency" };
			const workers = parseConcurrencyCount(next.text);
			if (workers.error) return workers;
			concurrency = workers.value;
			i += 1;
			continue;
		}
		if (text.startsWith("--concurrency=")) {
			const workers = parseConcurrencyCount(text.slice("--concurrency=".length));
			if (workers.error) return workers;
			concurrency = workers.value;
			continue;
		}
		// Symmetric with --deep: the bare flag and `--aggressive=true` enable,
		// any other value errors — `--aggressive=false` is a typo, not silence.
		if (text === "--aggressive" || text === "--aggressive=true") {
			aggressive = true;
			continue;
		}
		if (text.startsWith("--aggressive=")) {
			return { target: null, error: "The --aggressive flag takes no value. Use /review --aggressive, or omit the flag." };
		}
		if (parts.length === 0) headEnd = end;
		parts.push(text);
	}
	if (parts.length === 0) return { target: { type: "uncommitted" }, extraInstruction, aggressive, deep, timeoutSec, concurrency };

	// Control subcommands match the first remaining token — the same head rule
	// the mode switch uses. `status` only as the sole token preserves the
	// goal-style whole-input convention for multi-word input.
	const head = parts[0]?.toLowerCase();
	if (parts.length === 1 && head === "status") return { kind: "status" };
	if (head === "instructions") {
		if (parts.length === 1) return { kind: "invalid-instructions" };
		// Control-vs-value is decided on the RAW remainder: after tokenization,
		// `"clear"` and `clear` are indistinguishable, so quoting would lose its
		// distinguishing power. The bare form is the control word; the quoted
		// form is the escape hatch that stores the literal word.
		const remainder = input.slice(headEnd).trim();
		if (remainder.toLowerCase() === "clear") return { kind: "clear-instructions" };
		const value = parts.slice(1).join(" ");
		if (value.length === 0) return { kind: "invalid-instructions" };
		return { kind: "instructions", instructions: value };
	}

	switch (head) {
		case "uncommitted":
			return { target: { type: "uncommitted" }, extraInstruction, aggressive, deep, timeoutSec, concurrency };
		case "branch":
			// The branch name is optional: with no name, executeReview compares the
			// current branch to the repository's default branch (main/master).
			return { target: { type: "baseBranch", branch: parts[1] }, extraInstruction, aggressive, deep, timeoutSec, concurrency };
		case "commit": {
			const sha = parts[1];
			if (!sha) return { target: null, error: `Usage: ${COMMIT_SYNTAX}` };
			const title = parts.slice(2).join(" ") || undefined;
			return { target: { type: "commit", sha, title }, extraInstruction, aggressive, deep, timeoutSec, concurrency };
		}
		case "path": {
			const paths = parseReviewPaths(parts.slice(1));
			if (paths.length === 0) return { target: null, error: `Usage: ${PATH_SYNTAX}` };
			return { target: { type: "path", paths }, extraInstruction, aggressive, deep, timeoutSec, concurrency };
		}
		case "pr": {
			const ref = parts[1];
			if (!ref) return { target: null, error: `Usage: ${PR_SYNTAX}` };
			return { target: { type: "pr", ref }, extraInstruction, aggressive, deep, timeoutSec, concurrency };
		}
		default:
			// Pure @path input — the composer file picker's text, files and
			// directories alike — is a path snapshot review of those paths.
			// Mixed text keeps the custom-focus reading: the reviewer reads the
			// focus and decides what to inspect. Both work outside a git
			// repository, like the path snapshot review.
			if (parts.every((item) => item.startsWith("@"))) {
				const paths = parseReviewPaths(parts);
				if (paths.length > 0) {
					return { target: { type: "path", paths }, extraInstruction, aggressive, deep, timeoutSec, concurrency };
				}
			}
			// Any other text is a custom review focus: the reviewer reads the focus
			// and decides what to inspect.
			return { target: { type: "custom", focus: parts.join(" ") }, extraInstruction, aggressive, deep, timeoutSec, concurrency };
	}
}

/** `fs.stat` that answers null for a path that does not exist; any other failure throws. */
async function statIfPresent(target) {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
		throw error;
	}
}

/**
 * Load project review guidelines: the nearest `REVIEW_GUIDELINES.md` walking up
 * from the session cwd, anchored on a DSH marker directory (`.agents`) or file
 * (`AGENTS.md`), with the Pi `.pi` marker also accepted. Null when none exists.
 * @throws when a marker or the guidelines file exists but cannot be read.
 */
async function loadProjectReviewGuidelines(cwd) {
	let currentDir = path.resolve(cwd);
	while (true) {
		const [agentsDir, agentsFile, piDir] = await Promise.all([
			statIfPresent(path.join(currentDir, ".agents")),
			statIfPresent(path.join(currentDir, "AGENTS.md")),
			statIfPresent(path.join(currentDir, ".pi")),
		]);
		if (agentsDir?.isDirectory() || agentsFile?.isFile() || piDir?.isDirectory()) {
			const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
			const stats = await statIfPresent(guidelinesPath);
			if (!stats?.isFile()) return null;
			return (await fs.readFile(guidelinesPath, "utf8")).trim() || null;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/** Direct error outcome. */
function errorResult(text) {
	return { kind: "error", text };
}

/** Direct success outcome. */
function successResult(text) {
	return { kind: "success", text };
}

/** Submit one model-visible message as the agent's next turn, attributed to this plugin. */
function sendReviewTurn(invocation, text) {
	invocation.agent.followup(createUserMessage({
		content: [{ type: "text", text }],
		source: REVIEW_MESSAGE_SOURCE,
	}));
}

/** Whether `error` is a {@link GitError} of one of the given kinds. */
function isGitError(error, ...codes) {
	return error instanceof GitError && codes.includes(error.code);
}

/**
 * Ensure the GitHub CLI is installed and authenticated.
 * @returns an error string when `gh` is unusable, else null.
 * @throws {GitError} when a check is cancelled, times out, or truncates its output.
 */
async function githubCliProblem(ctx, cwd, signal) {
	try {
		await runCommand(ctx, ["gh", "--version"], cwd, signal);
	} catch (error) {
		if (isGitError(error, "UNAVAILABLE", "FAILED")) {
			return `PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`;
		}
		throw error;
	}
	try {
		await runCommand(ctx, ["gh", "auth", "status"], cwd, signal);
	} catch (error) {
		if (isGitError(error, "FAILED")) {
			return "GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.";
		}
		throw error;
	}
	return null;
}

/**
 * Resolve a PR reference into a checked-out pull-request review target.
 * @returns the target, or an error string on failure.
 */
async function resolvePullRequestTarget(ctx, cwd, ref, signal) {
	const prNumber = parsePrReference(ref);
	if (!prNumber) return { error: "Invalid PR reference. Enter a number or GitHub PR URL." };

	const ghProblem = await githubCliProblem(ctx, cwd, signal);
	if (ghProblem) return { error: ghProblem };

	if (await hasPendingChanges(ctx, cwd, signal)) {
		return { error: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE };
	}

	let prInfo;
	try {
		prInfo = await getPrInfo(ctx, cwd, prNumber, signal);
	} catch (error) {
		if (isGitError(error, "FAILED")) {
			return { error: `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access (check with \`gh auth status\`). ${error.message}` };
		}
		throw error;
	}

	if (await hasPendingChanges(ctx, cwd, signal)) {
		return { error: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE };
	}

	try {
		await checkoutPr(ctx, cwd, prNumber, signal);
	} catch (error) {
		if (isGitError(error, "FAILED")) return { error: `Failed to checkout PR: ${error.message}` };
		throw error;
	}

	return {
		target: {
			type: "pullRequest",
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		},
		checkedOut: prInfo.headBranch,
	};
}

/**
 * Render one session's review state for humans. The incomplete marker reads the
 * in-memory deep run, so a review that released before verification ran says
 * so, and a deep record with no in-memory run (the fleet cleared on restart)
 * renders the gone pipeline instead of an active review with no pipeline line.
 */
function renderReviewState(record, run) {
	const lines = ["Review session state"];
	if (record.active) {
		lines.push(`Status: active${record.deep ? " (deep fleet)" : ""}${record.startedAt ? ` (started ${record.startedAt})` : ""}`);
		lines.push(`Target: ${record.target ?? "unknown"}`);
		if (run?.incomplete) lines.push(`Incomplete: ${run.incomplete}`);
		if (run && record.deep) {
			lines.push(`Pipeline: scan ${run.scan.state}, verify ${run.verify.state}`);
			lines.push(`Raw findings: ${run.rawFindings.size}`);
		} else if (record.deep) {
			// Deep fleet state is in memory: a restart clears the runs while the
			// durable record still says deep, so the status names the gone
			// pipeline instead of showing an active review with no pipeline
			// line (README says the status says so).
			lines.push("Pipeline: gone (the in-memory fleet cleared on restart; /end-review done finishes it)");
		}
	} else {
		lines.push("Status: no review active");
	}
	lines.push(`Custom instructions: ${record.customInstructions?.trim() || "(none)"}`);
	lines.push("");
	lines.push(END_REVIEW_USAGE);
	return lines.join("\n");
}

/**
 * Translate a failure at the command boundary into a settled outcome. A
 * cancelled command reports cancellation; anything else reports its message.
 */
function boundaryError(error, signal) {
	if (signal.aborted) return errorResult(REVIEW_CANCELLED_MESSAGE);
	return errorResult(error instanceof Error ? error.message : String(error));
}

/**
 * Execute one `/review` invocation.
 * @param ctx - context carrying the `subprocess` seam.
 * @param domain - opened review state domain.
 * @param invocation - the registry invocation.
 * @param lifetime - signal that aborts when the plugin unloads.
 * @returns the settled command outcome.
 */
async function executeReview(ctx, domain, invocation, lifetime, fleet) {
	const signal = AbortSignal.any([invocation.signal, lifetime]);
	try {
		return await runReviewCommand(ctx, domain, invocation, signal, fleet);
	} catch (error) {
		return boundaryError(error, signal);
	}
}

/** The `/review` command body; failures propagate to {@link executeReview}. */
async function runReviewCommand(ctx, domain, invocation, signal, fleet) {
	signal.throwIfAborted();
	const cwd = reviewCwd(invocation.agent);
	const sessionId = invocation.agent.id;
	const parsed = parseReviewArgs(invocation.rawInput);

	if (parsed.kind === "status") {
		return successResult(renderReviewState(getSessionRecord(domain, sessionId), fleetRun(fleet, sessionId)));
	}

	if (parsed.kind === "clear-instructions") {
		await setCustomInstructions(domain, sessionId, undefined);
		return successResult("Custom review instructions removed.");
	}
	if (parsed.kind === "instructions") {
		await setCustomInstructions(domain, sessionId, parsed.instructions);
		return successResult(`Custom review instructions saved: "${parsed.instructions}". They apply to every review in this session.`);
	}
	if (parsed.kind === "invalid-instructions") {
		return errorResult("Custom instructions need text: /review instructions <text> or /review instructions clear.");
	}

	if (parsed.error) return errorResult(parsed.error);

	// The flags are fleet-only: a regular review has no workers to time or
	// pool. Checked after the kind subcommands (status/instructions drop flags
	// silently — the existing convention, so `/review --timeout 900 status`
	// still renders status) and before the active check: a static usage error
	// outranks the session state.
	if (parsed.timeoutSec && !parsed.deep) return errorResult("--timeout applies to --deep reviews.");
	if (parsed.concurrency && !parsed.deep) return errorResult("--concurrency applies to --deep reviews.");

	const record = getSessionRecord(domain, sessionId);
	if (record.active) {
		return errorResult("Already in a review. Use /end-review to finish first.");
	}

	let target = parsed.target;
	// File attachments join the review as full host paths (the stored copy's
	// path, resolved by the attachments service — a receipt never carries the
	// original location). They compose with the path mode's paths, deduped by
	// absolute resolution; with no mode named they become the snapshot target
	// themselves; a git-diff mode or a free-form focus cannot take them, since
	// reviewing git history or following a focus while also reviewing attached
	// files is a conflict, not a merge.
	const pathsFromAttachments = attachmentReviewPaths(ctx, invocation.attachments);
	if (pathsFromAttachments.length > 0) {
		if (target.type === "path") {
			target = { ...target, paths: dedupePaths(cwd, [...pathsFromAttachments, ...target.paths]) };
		} else if (target.type === "uncommitted" && namesNoMode(invocation.rawInput)) {
			target = { type: "path", paths: dedupePaths(cwd, pathsFromAttachments) };
		} else {
			return errorResult(
				"Attached files review as a snapshot of the attached paths. "
				+ "Use them on their own or with /review path <paths>; "
				+ "a git-diff mode (uncommitted, branch, commit, pr) or a free-form focus cannot take them.",
			);
		}
	}
	// The uncommitted, branch, commit, and PR reviews diff git history; the
	// path and custom reviews read files or follow the user's focus directly
	// and work outside a repository.
	if (target.type !== "path" && target.type !== "custom" && !(await isGitRepository(ctx, cwd, signal))) {
		return errorResult(
			`Not a git repository — the ${GIT_TARGET_LABELS[target.type]} review needs one. `
			+ `Checked ${cwd}; a repository is detected by walking up from the session's working directory, `
			+ `so a repository in a subfolder is not seen. `
			+ `\`/review path <paths>\` and \`/review <focus text>\` work without git.`
		);
	}

	let checkedOutBranch;
	if (target.type === "pr") {
		const resolved = await resolvePullRequestTarget(ctx, cwd, target.ref, signal);
		if (resolved.error) return errorResult(resolved.error);
		target = resolved.target;
		checkedOutBranch = resolved.checkedOut;
	}

	// Resolve the comparison point for diff-style modes so the prompt carries the
	// exact merge base.
	if (target.type === "baseBranch") {
		// `/review branch` with no name compares the current branch to the
		// repository's default branch: remote HEAD first, then main/master.
		const branch = target.branch ?? await getDefaultBranch(ctx, cwd, signal);
		target = { ...target, branch, mergeBase: await getMergeBase(ctx, cwd, branch, signal) };
	} else if (target.type === "pullRequest") {
		target = { ...target, mergeBase: await getMergeBase(ctx, cwd, target.baseBranch, signal) };
	}

	const promptOptions = {
		aggressive: parsed.aggressive === true,
		customInstructions: getCustomInstructions(domain, sessionId),
		extraInstruction: parsed.extraInstruction,
		projectGuidelines: await loadProjectReviewGuidelines(cwd),
	};

	// Nothing durable or model-visible happens for a request that was cancelled while it gathered context.
	signal.throwIfAborted();
	const aggressiveHint = parsed.aggressive ? " (aggressive)" : "";
	const deepHint = parsed.deep ? " (deep)" : "";
	const timeoutHint = parsed.timeoutSec ? ` (timeout ${parsed.timeoutSec}s)` : "";
	// The requested value, mirroring the timeout hint; a begin-time harness cap
	// (never silent) is named by the start message below, not by this hint.
	const concurrencyHint = parsed.concurrency ? ` (workers ${parsed.concurrency})` : "";
	const modeHint = checkedOutBranch ? ` (checked out ${checkedOutBranch})` : "";

	if (parsed.deep) {
		const fleetHandle = fleet?.();
		if (!fleetHandle) {
			return errorResult("Deep review is not mounted yet — the tools and subagents services are still loading or were unloaded, or this deployment does not provide them. Retry /review --deep shortly, or run /review without --deep.");
		}
		const run = await fleetHandle.begin(invocation.agent, {
			target,
			modePrompt: buildModePrompt(target),
			targetLabel: getUserFacingHint(target),
			aggressive: parsed.aggressive === true,
			promptOptions,
			timeoutMs: parsed.timeoutSec !== undefined ? parsed.timeoutSec * 1000 : undefined,
			concurrency: parsed.concurrency,
		});
		try {
			await setActiveReview(domain, sessionId, { type: target.type, description: `${getUserFacingHint(target)}${aggressiveHint}${deepHint}${timeoutHint}${concurrencyHint}`, deep: true });
		} catch (error) {
			// Roll the run back so a failed durable write never leaves a live fleet.
			await fleetHandle.end(sessionId);
			throw error;
		}
		try {
			sendReviewTurn(invocation, buildDeepReviewPrompt(target, promptOptions, run.settings));
		} catch (error) {
			// The converse of the durable-write rollback above: the write
			// succeeded, the send failed. Roll the run back so the failure never
			// leaves a live fleet whose orchestrator prompt never queued
			// (`followup` is fire-and-forget, so a throw means nothing queued).
			// The durable record still says active, so /end-review done recovers;
			// a best-effort clear here would mask this error with a storage one.
			await fleetHandle.end(sessionId);
			throw error;
		}
		return successResult(
			`Deep review started: ${getUserFacingHint(target)}${aggressiveHint}${deepHint}${timeoutHint}${concurrencyHint}${modeHint}. ` +
			`A fleet of up to ${run.settings.maxReviewers} reviewers and ${run.settings.maxVerifierRuns} verifier runs will scan, verify and consolidate; cost is many times a regular review. ` +
			`Workers run up to ${Math.round(run.settings.reviewerTimeoutMs / 1000)}s each within a ${Math.round(run.settings.callBudgetMs / 1000)}s call budget. ` +
			`Call deep_review_scan to start; finish with /end-review.` +
			// The begin-time harness cap on the requested concurrency, when it
			// fired: the plugin's never-silent rule for effective values.
			(run.startNotice ? ` ⚠️ ${run.startNotice}` : ""),
		);
	}

	// Durable write first, then the model-visible turn (the same discipline the
	// deep path keeps below): a failed durable write leaves no queued review
	// turn the model would perform while the session record says no review.
	await setActiveReview(domain, sessionId, { type: target.type, description: `${getUserFacingHint(target)}${aggressiveHint}` });
	sendReviewTurn(invocation, buildReviewPrompt(target, promptOptions));
	return successResult(`Review started: ${getUserFacingHint(target)}${aggressiveHint}${modeHint}. Findings will appear in this session; finish with /end-review.`);
}

/**
 * Execute one `/end-review` invocation.
 * @param domain - opened review state domain.
 * @param invocation - the registry invocation.
 * @param lifetime - signal that aborts when the plugin unloads.
 * @returns the settled command outcome.
 */
async function executeEndReview(domain, invocation, lifetime, fleet) {
	const signal = AbortSignal.any([invocation.signal, lifetime]);
	try {
		return await runEndReviewCommand(domain, invocation, signal, fleet);
	} catch (error) {
		return boundaryError(error, signal);
	}
}

/** The `/end-review` command body; failures propagate to {@link executeEndReview}. */
async function runEndReviewCommand(domain, invocation, signal, fleet) {
	signal.throwIfAborted();
	// Bare `/end-review` (no mode) defaults to summarize: the handoff preserves
	// the findings before the session returns to ordinary coding work.
	const input = invocation.rawInput.trim().toLowerCase() || "summarize";
	if (input !== "status" && input !== "summarize" && input !== "fix" && input !== "done") {
		return errorResult(END_REVIEW_USAGE);
	}

	const sessionId = invocation.agent.id;
	const record = getSessionRecord(domain, sessionId);

	if (input === "status") {
		return successResult(renderReviewState(record, fleetRun(fleet, sessionId)));
	}

	if (!record.active) {
		return errorResult(`No review is active in this session (start one with /review).\n${END_REVIEW_USAGE}`);
	}

	switch (input) {
		case "summarize":
			// A deep review's history contains raw scan output the lanes filtered;
			// its handoff reads the verified report only.
			sendReviewTurn(invocation, record.deep ? buildDeepSummaryPrompt() : REVIEW_SUMMARY_PROMPT);
			await clearActiveReview(domain, sessionId);
			await endFleet(fleet, sessionId);
			return successResult("Review finished. A structured handoff summary of the findings is queued as the next turn.");
		case "fix":
			sendReviewTurn(invocation, REVIEW_FIX_FINDINGS_PROMPT);
			await clearActiveReview(domain, sessionId);
			await endFleet(fleet, sessionId);
			return successResult("Review finished. A follow-up turn queued to implement the review findings.");
		case "done":
			await clearActiveReview(domain, sessionId);
			await endFleet(fleet, sessionId);
			return successResult("Review finished. The session is back to ordinary coding work.");
	}
}

/** End one session's deep run when the fleet capability is present. */
async function endFleet(fleet, sessionId) {
	const handle = fleet?.();
	await handle?.end?.(sessionId);
}

/** One session's in-memory deep run, when the fleet capability is present. */
function fleetRun(fleet, sessionId) {
	return fleet?.()?.runs?.get(sessionId);
}

/**
 * Track one in-flight command so unloading can wait for it to settle.
 * @returns the same operation.
 */
function track(inFlight, operation) {
	inFlight.add(operation);
	const forget = () => inFlight.delete(operation);
	operation.then(forget, forget);
	return operation;
}

/**
 * Register `/review` and `/end-review` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the `subprocess` seam.
 * @param domain - opened review state domain.
 * @param lifecycle - `signal`: aborts when the plugin unloads; `inFlight`: set receiving each running command.
 */
function registerCommands(ctx, domain, lifecycle) {
	return ctx.effect(function* () {
		yield ctx.commands.register({
			definitionId: CommandDefinitionId(REVIEW_DEFINITION_ID),
			name: "review",
			description: "Review code changes (PR, uncommitted, branch, commit, or paths); --deep runs a reviewer fleet with independent verification",
			input: {
				hint: "[uncommitted|branch [<name>]|commit <sha>|pr <number|url>|path <paths>|instructions <text>|status] [--extra \"...\"] [--aggressive] [--deep] [--timeout <seconds>] [--concurrency <workers>]",
				// Staged file attachments (paperclip / drag-and-drop / paste) are
				// admitted and join the review as full paths; without the flag the
				// harness refuses any submission that carries them.
				attachments: true,
			},
			handler: (invocation) => track(lifecycle.inFlight, executeReview(ctx, domain, invocation, lifecycle.signal, lifecycle.fleet)),
		});
		yield ctx.commands.register({
			definitionId: CommandDefinitionId(END_REVIEW_DEFINITION_ID),
			name: "end-review",
			description: "Finish the active review (summarize findings, queue fixes, or done)",
			input: {
				hint: "[summarize|fix|done]",
			},
			handler: (invocation) => track(lifecycle.inFlight, executeEndReview(domain, invocation, lifecycle.signal, lifecycle.fleet)),
		});
	}, "review commands");
}

export {
	REVIEW_DEFINITION_ID,
	END_REVIEW_DEFINITION_ID,
	END_REVIEW_USAGE,
	tokenizeArgs,
	parseReviewArgs,
	attachmentReviewPaths,
	loadProjectReviewGuidelines,
	resolvePullRequestTarget,
	renderReviewState,
	executeReview,
	executeEndReview,
	registerCommands,
};
