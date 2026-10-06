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
const GH_SETUP_INSTRUCTIONS =
	"Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
	"Cannot checkout PR: you have uncommitted changes to tracked files. Please commit or stash them first.";
const REVIEW_USAGE = `Usage:
  /review uncommitted              review staged, unstaged, and untracked changes
  /review branch [<name>]          review changes against a base branch (default: main/master)
  /review commit <sha> [<title>]   review one commit
  /review pr <number|url>          check a GitHub PR out locally via \`gh\`, then review it
  /review folder <paths...>        review folders/files as a snapshot (not a diff)
  /review <focus text>             custom review with that focus (any other text, e.g. "check the error handling")
  /review instructions <text>      set shared custom review instructions (quote "clear" to store the word)
  /review instructions clear       remove them
  /review status                   show the current review session state
  /review --extra "<instruction>"  add one extra instruction to any mode
  /review --aggressive <mode>      hunt for issues: report every candidate, labeled with confidence
                                   (--aggressive rides with any subcommand, before or after it)`;
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
			if (!sha) return { target: null, extraInstruction, aggressive };
			const title = parts.slice(2).join(" ") || undefined;
			return { target: { type: "commit", sha, title }, extraInstruction, aggressive };
		}
		case "folder": {
			const paths = parseReviewPaths(parts.slice(1).join(" "));
			if (paths.length === 0) return { target: null, extraInstruction, aggressive };
			return { target: { type: "folder", paths }, extraInstruction, aggressive };
		}
		case "pr": {
			const ref = parts[1];
			if (!ref) return { target: null, extraInstruction, aggressive };
			return { target: { type: "pr", ref }, extraInstruction, aggressive };
		}
		default:
			// Any other text is a custom review focus: the reviewer reads the focus
			// and decides what to inspect. Works outside a git repository, like the
			// folder snapshot review.
			return { target: { type: "custom", focus: parts.join(" ") }, extraInstruction, aggressive };
	}
}

/**
 * Load project review guidelines: the nearest `REVIEW_GUIDELINES.md` walking up
 * from the session cwd, anchored on a DSH marker directory (`.agents`) or file
 * (`AGENTS.md`), with the Pi `.pi` marker also accepted. Null when none exists.
 */
async function loadProjectReviewGuidelines(cwd) {
	let currentDir = path.resolve(cwd);
	while (true) {
		const hasMarker = await Promise.all([
			fs.stat(path.join(currentDir, ".agents")).then((stats) => stats.isDirectory()).catch(() => false),
			fs.stat(path.join(currentDir, "AGENTS.md")).then((stats) => stats.isFile()).catch(() => false),
			fs.stat(path.join(currentDir, ".pi")).then((stats) => stats.isDirectory()).catch(() => false),
		]);
		if (hasMarker.some(Boolean)) {
			const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
			const stats = await fs.stat(guidelinesPath).then((s) => (s.isFile() ? s : null)).catch(() => null);
			if (stats) {
				try {
					const content = (await fs.readFile(guidelinesPath, "utf8")).trim();
					if (content) return content;
				} catch {
					return null;
				}
			}
			return null;
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

/** Submit one model-visible user message as the agent's next turn. */
function sendReviewTurn(invocation, text) {
	invocation.agent.followup(createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "user" },
	}));
}

/**
 * Ensure the GitHub CLI is installed and authenticated.
 * @returns an error string when `gh` is unusable, else null.
 */
async function githubCliProblem(ctx, cwd, signal) {
	const version = await runCommand(ctx, ["gh", "--version"], cwd, signal);
	if (version.code !== 0) {
		return `PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`;
	}
	const auth = await runCommand(ctx, ["gh", "auth", "status"], cwd, signal);
	if (auth.code !== 0) {
		return "GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.";
	}
	return null;
}

/**
 * Resolve a PR reference into a checked-out pull-request review target.
 * @returns the target, or an error string on failure.
 */
async function resolvePullRequestTarget(ctx, cwd, ref, signal) {
	const ghProblem = await githubCliProblem(ctx, cwd, signal);
	if (ghProblem) return { error: ghProblem };

	if (await hasPendingChanges(ctx, cwd, signal)) {
		return { error: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE };
	}

	const prNumber = parsePrReference(ref);
	if (!prNumber) return { error: "Invalid PR reference. Enter a number or GitHub PR URL." };

	const prInfo = await getPrInfo(ctx, cwd, prNumber, signal);
	if (!prInfo) {
		return { error: `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access (check with \`gh auth status\`).` };
	}

	if (await hasPendingChanges(ctx, cwd, signal)) {
		return { error: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE };
	}

	const checkout = await checkoutPr(ctx, cwd, prNumber, signal);
	if (!checkout.success) return { error: `Failed to checkout PR: ${checkout.error}` };

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
 * Execute one parsed `/review` invocation.
 * @param ctx - context carrying the `subprocess` seam.
 * @param domain - opened review state domain.
 * @param invocation - the registry invocation.
 * @returns the settled command outcome.
 */
async function executeReview(ctx, domain, invocation) {
	const cwd = reviewCwd(invocation.agent);
	const signal = invocation.signal;
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

	const gitRepository = await isGitRepository(ctx, cwd, signal);

	let target = parsed.target;
	let checkedOutBranch;
	if (target?.type === "pr") {
		if (!gitRepository) {
			return errorResult(`Not a git repository — the PR review needs one. \`/review folder <paths>\` works without git.`);
		}
		const resolved = await resolvePullRequestTarget(ctx, cwd, target.ref, signal);
		if (resolved.error) return errorResult(resolved.error);
		target = resolved.target;
		checkedOutBranch = resolved.checkedOut;
	}


	// The uncommitted, branch, and commit reviews diff git history; the folder
	// and custom reviews read files or follow the user's focus directly and work
	// outside a repository.
	if (target.type !== "folder" && target.type !== "custom" && !gitRepository) {
		return errorResult(`Not a git repository — the ${target.type} review needs one. \`/review folder <paths>\` works without git.`);
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
 * Execute one parsed `/end-review` invocation.
 * @returns the settled command outcome.
 */
async function executeEndReview(ctx, domain, invocation) {
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
			handler: (invocation) => executeEndReview(ctx, domain, invocation),
		});
	}, "review commands");
}

export {
	REVIEW_DEFINITION_ID,
	END_REVIEW_DEFINITION_ID,
	REVIEW_USAGE,
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
