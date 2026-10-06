/**
 * Review prompts.
 *
 * The rubric and mode prompts are shared by every review mode; only the
 * target focus differs.
 *
 * @module @apcamargo/dsh-review/prompts
 */

/** Review target types. */

const UNCOMMITTED_PROMPT =
	"Review the current code changes and provide prioritized findings. Gather the staged changes (`git diff --cached`), the unstaged changes (`git diff`), and the untracked (net new) files (`git status --short`), then read the modified and untracked files in full for context.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
	"Review the code changes against the base branch '{branch}'. Start by finding the merge diff between the current branch and {branch}'s upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{branch}@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
	'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT = "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
	'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.';

const PULL_REQUEST_PROMPT_FALLBACK =
	'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.';

const FOLDER_REVIEW_PROMPT =
	"Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.";

/** The detailed review rubric. */
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Gathering context

Diffs alone are not enough. After inspecting the changes, read the entire file(s) being modified to understand the full context: code that looks wrong in isolation may be correct given surrounding logic — and vice versa.

Work in two passes:

1. First pass over the diff alone, looking for obvious defects: syntax errors, type errors, missing imports, unresolved references, and definite logic errors.
2. Second pass with full context: read the modified files in full (and untracked (net new) files in their entirety) to find issues that only appear with surrounding logic.
3. Understand the existing patterns, control flow, and error handling around each change before judging it.
4. Check for conventions files (AGENTS.md, CONVENTIONS.md, .editorconfig, …) and project review guidelines before flagging style.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.
11. Violate the clean-code guidelines below.
12. Introduce error handling that conflicts with the fail-fast guidelines below.

Trace failure paths, not just the happy path: follow how bad inputs, retries, concurrent actions, and partially completed operations move through the changed code. Code that only works on the happy path is a real weakness.

Typical candidates: logic errors and off-by-one mistakes; incorrect conditionals; missing, incorrect, or unreachable if-else guards; unhandled edge cases (null/empty/undefined inputs, error conditions, race conditions); security issues (injection, auth bypass, data exposure); behavior changes, especially possibly unintentional ones; and performance problems that are obvious and impactful (O(n²) over unbounded data, N+1 queries, blocking I/O on hot paths).

## Before you flag

Be certain before you assert. Before calling something a bug, be confident it actually is one — and honest about everything else.

1. Investigate first: when unsure whether something is a bug, read the surrounding code and check callers before flagging.
2. Don't invent hypothetical problems: if an edge case matters, explain the realistic scenario where it breaks.
3. Report suspicions as suspicions, never silently: if you cannot verify a concern, flag it as a labeled suspicion with its confidence (high/medium/low) and what evidence would settle it. Never drop a concern without reporting it, and never assert an unverified concern as a definite bug.
4. Do not flag false positives: issues a linter will catch, and issues explicitly silenced in the code (lint-ignore comments, documented fallbacks) are noise, not findings.

## Clean-code guidelines

1. Check whether each newly added function duplicates existing functionality elsewhere in the codebase. Flag actual duplication and identify the existing implementation.
2. Flag one-off helper functions that add indirection without improving clarity or reuse (for example, \`isRecord\` or \`asString\`).
3. Flag abstractions introduced without a concrete need in the reviewed change, including wrappers created only for hypothetical future use.
4. Flag defensive checks or fallback behavior that mask programming errors, especially when callers already guarantee the relevant invariants.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or "best effort" silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed> (call out re-use of dormant feature flags!)
- **This change changes configuration defaults:** <config var changed>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Tag each finding with its confidence (high/medium/low) in the title or first line, so the human sees how settled each issue is. Suspicions are reported as low-confidence findings, not omitted.
6. Ignore trivial style issues unless they obscure meaning or violate documented standards.
7. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.
8. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;

/** Custom prompt for review summaries — focuses on preserving actionable findings. */
const REVIEW_SUMMARY_PROMPT = `We are leaving a code-review session and returning to ordinary coding work.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this session so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P3]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

## Human Reviewer Callouts (Non-Blocking)
Include only applicable callouts (no yes/no lines):
- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>

If none apply, write "- (none)".

These are informational callouts for humans and are not fix items by themselves.

Preserve exact file paths, function names, and error messages where available.`;

const REVIEW_FIX_FINDINGS_PROMPT = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Treat "Human Reviewer Callouts (Non-Blocking)" as informational only; do not convert them into fix tasks unless there is a separate explicit finding.
5. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
6. If you add or keep a \`try/catch\`, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
7. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
8. Run relevant tests/checks for touched code where practical.
9. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;

/**
 * Build the mode-specific review prompt for one target.
 * @param target - resolved review target.
 * @returns the mode prompt with every placeholder substituted.
 */
function buildModePrompt(target) {
	switch (target.type) {
		case "uncommitted":
			return UNCOMMITTED_PROMPT;
		case "baseBranch": {
			const prompt = target.mergeBase
				? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(/{mergeBaseSha}/g, target.mergeBase)
				: BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
			return prompt;
		}
		case "commit": {
			const prompt = target.title
				? COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title)
				: COMMIT_PROMPT.replace("{sha}", target.sha);
			return prompt;
		}
		case "pullRequest": {
			const prompt = target.mergeBase
				? PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber)).replace(/{title}/g, target.title).replace(/{baseBranch}/g, target.baseBranch).replace(/{mergeBaseSha}/g, target.mergeBase)
				: PULL_REQUEST_PROMPT_FALLBACK.replace(/{prNumber}/g, String(target.prNumber)).replace(/{title}/g, target.title).replace(/{baseBranch}/g, target.baseBranch);
			return prompt;
		}
		case "folder":
			return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
		case "custom":
			// The user's own focus text is the review focus; the reviewer reads it
			// and decides what to inspect.
			return target.focus;
		/* v8 ignore next 2 -- the target union is closed; every member is handled above */
		default:
			throw new TypeError(`unknown review target type: ${String(target?.type)}`);
	}
}

/**
 * Aggressive-mode appendix: flips the review stance to adversarial hunting.
 * Lowered reporting bar (report every candidate, including weak suspicions)
 * paired with the grounding bar (defensible, concrete, no invention), so
 * aggression surfaces issues without turning into noise.
 */
const AGGRESSIVE_PROMPT = `## Aggressive mode

Your job in this review is to break confidence in the change, not to validate it.

1. Default to skepticism. Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise. Do not give credit for good intent, partial fixes, or likely follow-up work.
2. Actively try to disprove the change: look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress. Trace how bad inputs, retries, concurrent actions, and partially completed operations move through the changed code.
3. Hunt the failure classes that are expensive or hard to detect: auth/permissions/trust boundaries; data loss, corruption, and irreversible state changes; rollback safety, retries, partial failure, and idempotency gaps; race conditions, ordering assumptions, stale state, and re-entrancy; empty-state, null, timeout, and degraded-dependency behavior; version skew, schema drift, and compatibility regressions; observability gaps that would hide failure.
4. Lower the reporting bar: report every candidate the author would want to know, including weak suspicions, and do not stop early. Confidence labeling still applies — a weak suspicion is reported as low confidence, never omitted and never asserted as definite.
5. Stay grounded: every finding must be defensible from the actual diff and code. Do not invent files, lines, code paths, or runtime behavior. A suspicion you cannot tie to a concrete location and a plausible failure scenario is omitted, not reported.`;

/** Combined rubric + focus prompt for one review target. */
function buildReviewPrompt(target, options = {}) {
	let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${buildModePrompt(target)}`;
	if (options.aggressive) {
		fullPrompt += `\n\n${AGGRESSIVE_PROMPT}`;
	}
	if (options.customInstructions) {
		fullPrompt += `\n\nShared custom review instructions (applies to all reviews):\n\n${options.customInstructions}`;
	}
	if (options.extraInstruction?.trim()) {
		fullPrompt += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
	}
	if (options.projectGuidelines) {
		fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${options.projectGuidelines}`;
	}
	return fullPrompt;
}

/** User-facing hint for one review target. */
function getUserFacingHint(target) {
	switch (target.type) {
		case "uncommitted":
			return "current changes";
		case "baseBranch":
			return `changes against '${target.branch}'`;
		case "commit": {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
		}
		case "pullRequest": {
			const shortTitle = target.title.length > 30 ? target.title.slice(0, 27) + "..." : target.title;
			return `PR #${target.prNumber}: ${shortTitle}`;
		}
		case "folder": {
			const joined = target.paths.join(", ");
			return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
		}
		case "custom": {
			const focus = target.focus.trim();
			return focus.length > 40 ? `focus: ${focus.slice(0, 37)}...` : `focus: ${focus}`;
		}
		/* v8 ignore next 2 -- the target union is closed; every member is handled above */
		default:
			throw new TypeError(`unknown review target type: ${String(target?.type)}`);
	}
}

export {
	REVIEW_RUBRIC,
	AGGRESSIVE_PROMPT,
	REVIEW_SUMMARY_PROMPT,
	REVIEW_FIX_FINDINGS_PROMPT,
	buildReviewPrompt,
	getUserFacingHint,
};
