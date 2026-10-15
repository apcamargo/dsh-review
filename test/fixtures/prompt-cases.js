/**
 * The target and option matrix whose `buildReviewPrompt` output is pinned in
 * `prompt-snapshots.json`, so refactors of the rubric cannot change the
 * non-deep prompt unnoticed.
 */
export const TARGETS = [
	{ type: "uncommitted" },
	{ type: "baseBranch", branch: "main", mergeBase: "a".repeat(40) },
	{ type: "baseBranch", branch: "main" },
	{ type: "commit", sha: "abc1234", title: "Fix thing" },
	{ type: "commit", sha: "abc1234" },
	{ type: "pullRequest", prNumber: 7, title: "Add feature", baseBranch: "main", mergeBase: "b".repeat(40) },
	{ type: "pullRequest", prNumber: 7, title: "Add feature", baseBranch: "main" },
	{ type: "folder", paths: ["src", "docs"] },
	{ type: "custom", focus: "check the error handling" },
];

export const OPTIONS = [
	{},
	{ aggressive: true },
	{ customInstructions: "prefer fail-fast", extraInstruction: " focus on io ", projectGuidelines: "Check the budget." },
	{ aggressive: true, customInstructions: "x", extraInstruction: "y", projectGuidelines: "z" },
];
