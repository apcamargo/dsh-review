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
	getUserFacingHint,
} from "./prompts.js";
import {
	getSessionRecord,
	getCustomInstructions,
	setActiveReview,
	clearActiveReview,
	setCustomInstructions,
} from "./state.js";

/** Per-definition identities: the brand doc reads as per-definition, and no shipped plugin shares one id. */
const REVIEW_DEFINITION_ID = "@apcamargo/dsh-review/review";
const END_REVIEW_DEFINITION_ID = "@apcamargo/dsh-review/end-review";
/** Producer identity of the turns this plugin queues; the harness has no shared catch-all `plugin` source kind. */
const REVIEW_MESSAGE_SOURCE = Object.freeze({ kind: "apcamargo-dsh-review" });
const REVIEW_CANCELLED_MESSAGE = "Review cancelled.";
/** How each git-dependent target type reads in the "not a git repository" guidance. */
const GIT_TARGET_LABELS = { uncommitted: "uncommitted", baseBranch: "branch", commit: "commit", pr: "PR" };
const GH_SETUP_INSTRUCTIONS =
	"Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
	"Cannot checkout PR: you have uncommitted changes to tracked files. Please commit or stash them first.";
const COMMIT_SYNTAX = "/review commit <sha> [<title>]";
const PR_SYNTAX = "/review pr <number|url>";
const FOLDER_SYNTAX = "/review folder <paths...>";
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

/** Split one folder argument into whitespace-separated paths. */
function parseReviewPaths(value) {
	return value.split(/\s+/).map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Parse the `/review` grammar: the `instructions` and `status` subcommands
 * plus the mode subcommands and the DSH adaptation of the bare invocation.
 *
 * `--extra`/`--aggressive` are partitioned once, before any subcommand
 * matching, so they compose with `instructions` and `status` exactly as they
 * compose with the modes.
 */
function parseReviewArgs(rawInput) {
	const input = rawInput?.trim() ?? "";
	if (input.length === 0) return { target: { type: "uncommitted" } };

	const rawParts = tokenizeArgs(input);
	const parts = [];
	let extraInstruction;
	let aggressive = false;
	let headEnd;
	for (let i = 0; i < rawParts.length; i++) {
		const { text, end } = rawParts[i];
		if (text === "--extra") {
			const next = rawParts[i + 1];
			if (!next) return { target: null, error: "Missing value for --extra" };
			extraInstruction = next.text;
			i += 1;
			continue;
		}
		if (text.startsWith("--extra=")) {
			extraInstruction = text.slice("--extra=".length);
			continue;
		}
		if (text === "--aggressive" || text.startsWith("--aggressive=")) {
			aggressive = true;
			continue;
		}
		if (parts.length === 0) headEnd = end;
		parts.push(text);
	}
	if (parts.length === 0) return { target: { type: "uncommitted" }, extraInstruction, aggressive };

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
			return { target: { type: "uncommitted" }, extraInstruction, aggressive };
		case "branch":
			// The branch name is optional: with no name, executeReview compares the
			// current branch to the repository's default branch (main/master).
			return { target: { type: "baseBranch", branch: parts[1] }, extraInstruction, aggressive };
		case "commit": {
			const sha = parts[1];
			if (!sha) return { target: null, error: `Usage: ${COMMIT_SYNTAX}` };
			const title = parts.slice(2).join(" ") || undefined;
			return { target: { type: "commit", sha, title }, extraInstruction, aggressive };
		}
		case "folder": {
			const paths = parseReviewPaths(parts.slice(1).join(" "));
			if (paths.length === 0) return { target: null, error: `Usage: ${FOLDER_SYNTAX}` };
			return { target: { type: "folder", paths }, extraInstruction, aggressive };
		}
		case "pr": {
			const ref = parts[1];
			if (!ref) return { target: null, error: `Usage: ${PR_SYNTAX}` };
			return { target: { type: "pr", ref }, extraInstruction, aggressive };
		}
		default:
			// Any other text is a custom review focus: the reviewer reads the focus
			// and decides what to inspect. Works outside a git repository, like the
			// folder snapshot review.
			return { target: { type: "custom", focus: parts.join(" ") }, extraInstruction, aggressive };
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

/** Render one session's review state for humans. */
function renderReviewState(record) {
	const lines = ["Review session state"];
	if (record.active) {
		lines.push(`Status: active${record.startedAt ? ` (started ${record.startedAt})` : ""}`);
		lines.push(`Target: ${record.target ?? "unknown"}`);
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
 * @returns the settled command outcome.
 */
async function executeReview(ctx, domain, invocation) {
	const signal = invocation.signal;
	try {
		return await runReviewCommand(ctx, domain, invocation, signal);
	} catch (error) {
		return boundaryError(error, signal);
	}
}

/** The `/review` command body; failures propagate to {@link executeReview}. */
async function runReviewCommand(ctx, domain, invocation, signal) {
	const cwd = reviewCwd(invocation.agent);
	const sessionId = invocation.agent.id;
	const parsed = parseReviewArgs(invocation.rawInput);

	if (parsed.kind === "status") {
		return successResult(renderReviewState(getSessionRecord(domain, sessionId)));
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

	const record = getSessionRecord(domain, sessionId);
	if (record.active) {
		return errorResult("Already in a review. Use /end-review to finish first.");
	}

	let target = parsed.target;
	// The uncommitted, branch, commit, and PR reviews diff git history; the
	// folder and custom reviews read files or follow the user's focus directly
	// and work outside a repository.
	if (target.type !== "folder" && target.type !== "custom" && !(await isGitRepository(ctx, cwd, signal))) {
		return errorResult(`Not a git repository — the ${GIT_TARGET_LABELS[target.type]} review needs one. \`/review folder <paths>\` works without git.`);
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

	const prompt = buildReviewPrompt(target, {
		aggressive: parsed.aggressive === true,
		customInstructions: getCustomInstructions(domain, sessionId),
		extraInstruction: parsed.extraInstruction,
		projectGuidelines: await loadProjectReviewGuidelines(cwd),
	});

	const aggressiveHint = parsed.aggressive ? " (aggressive)" : "";
	await setActiveReview(domain, sessionId, { type: target.type, description: `${getUserFacingHint(target)}${aggressiveHint}` });
	sendReviewTurn(invocation, prompt);

	const modeHint = checkedOutBranch ? ` (checked out ${checkedOutBranch})` : "";
	return successResult(`Review started: ${getUserFacingHint(target)}${aggressiveHint}${modeHint}. Findings will appear in this session; finish with /end-review.`);
}

/**
 * Execute one `/end-review` invocation.
 * @param domain - opened review state domain.
 * @param invocation - the registry invocation.
 * @returns the settled command outcome.
 */
async function executeEndReview(domain, invocation) {
	const signal = invocation.signal;
	try {
		return await runEndReviewCommand(domain, invocation, signal);
	} catch (error) {
		return boundaryError(error, signal);
	}
}

/** The `/end-review` command body; failures propagate to {@link executeEndReview}. */
async function runEndReviewCommand(domain, invocation, signal) {
	// Bare `/end-review` (no mode) defaults to summarize: the handoff preserves
	// the findings before the session returns to ordinary coding work.
	const input = invocation.rawInput.trim().toLowerCase() || "summarize";
	if (input !== "status" && input !== "summarize" && input !== "fix" && input !== "done") {
		return errorResult(END_REVIEW_USAGE);
	}

	const sessionId = invocation.agent.id;
	const record = getSessionRecord(domain, sessionId);

	if (input === "status") {
		return successResult(renderReviewState(record));
	}

	if (!record.active) {
		return errorResult(`No review is active in this session (start one with /review).\n${END_REVIEW_USAGE}`);
	}

	switch (input) {
		case "summarize":
			sendReviewTurn(invocation, REVIEW_SUMMARY_PROMPT);
			await clearActiveReview(domain, sessionId);
			return successResult("Review finished. A structured handoff summary of the findings is queued as the next turn.");
		case "fix":
			sendReviewTurn(invocation, REVIEW_FIX_FINDINGS_PROMPT);
			await clearActiveReview(domain, sessionId);
			return successResult("Review finished. A follow-up turn queued to implement the review findings.");
		case "done":
			await clearActiveReview(domain, sessionId);
			return successResult("Review finished. The session is back to ordinary coding work.");
	}
}

/**
 * Register `/review` and `/end-review` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the `subprocess` seam.
 * @param domain - opened review state domain.
 */
function registerCommands(ctx, domain) {
	return ctx.effect(function* () {
		yield ctx.commands.register({
			definitionId: CommandDefinitionId(REVIEW_DEFINITION_ID),
			name: "review",
			description: "Review code changes (PR, uncommitted, branch, commit, or folder)",
			input: {
				hint: "[uncommitted|branch [<name>]|commit <sha>|pr <number|url>|folder <paths>|instructions <text>|status] [--extra \"...\"] [--aggressive]",
			},
			handler: (invocation) => executeReview(ctx, domain, invocation),
		});
		yield ctx.commands.register({
			definitionId: CommandDefinitionId(END_REVIEW_DEFINITION_ID),
			name: "end-review",
			description: "Finish the active review (summarize findings, queue fixes, or done)",
			input: {
				hint: "[summarize|fix|done]",
			},
			handler: (invocation) => executeEndReview(domain, invocation),
		});
	}, "review commands");
}

export {
	REVIEW_DEFINITION_ID,
	END_REVIEW_DEFINITION_ID,
	END_REVIEW_USAGE,
	tokenizeArgs,
	parseReviewArgs,
	loadProjectReviewGuidelines,
	resolvePullRequestTarget,
	renderReviewState,
	executeReview,
	executeEndReview,
	registerCommands,
};
