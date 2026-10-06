/**
 * Git and GitHub CLI helpers for the review commands, run through the harness
 * `subprocess` seam (`ctx.subprocess`) so executable lookup, environment
 * scrubbing, and cancellation follow the same execution world as the agent's
 * own shell tools.
 *
 * @module @apcamargo/dsh-review/git
 */

/** stdout byte cap for git invocations (diff-free listing commands are tiny). */
const STDOUT_CAP = 1_000_000;
/** stderr byte cap for diagnostics. */
const STDERR_CAP = 65_536;
/** Default deadline for one git invocation. */
const GIT_TIMEOUT_MS = 60_000;
/** Deadline for `gh pr checkout`, which fetches a full branch. */
const GH_TIMEOUT_MS = 120_000;

/**
 * Run one command to completion through the subprocess seam and collect its
 * output. The caller's signal and a per-call deadline bound the run; the
 * abort starts the provider's terminate escalation on the managed range.
 * @param ctx - context carrying the `subprocess` seam.
 * @param argv - executable and arguments; `argv[0]` is the program.
 * @param cwd - working directory for the child.
 * @param signal - cancellation signal owned by the dispatching request.
 * @param timeoutMs - per-call deadline in milliseconds.
 * @returns exit code (negative when killed by a signal) and collected output.
 */
async function runCommand(ctx, argv, cwd, signal, timeoutMs = GIT_TIMEOUT_MS) {
	const handle = ctx.subprocess.spawn({
		argv,
		cwd,
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: STDOUT_CAP },
			stderr: { maxBytes: STDERR_CAP },
		},
		graceMs: 1_000,
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
	});
	// `done` rejects for spawn or provider failures — a missing executable, for
	// example. Map that to the same "did not run" outcome as a non-zero exit so
	// every probe degrades to its friendly guidance instead of a raw error.
	let outcome;
	try {
		outcome = await handle.done;
	} catch (error) {
		return {
			code: -1,
			stdout: "",
			stderr: `subprocess failed before reporting an outcome: ${error.message}`,
		};
	}
	const stdout = handle.collected.stdout?.readFrom(0) ?? { text: "", lossy: false };
	const stderr = handle.collected.stderr?.readFrom(0) ?? { text: "", lossy: false };
	return {
		code: outcome.exitCode ?? -1,
		stdout: stdout.text,
		stderr: stderr.text,
	};
}

/**
 * Whether the working directory is inside a git repository.
 * @param ctx - context carrying the `subprocess` seam.
 * @param cwd - working directory to test.
 * @param signal - cancellation signal.
 */
async function isGitRepository(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "rev-parse", "--git-dir"], cwd, signal);
	return result.code === 0;
}

/**
 * Get the merge base between HEAD and a branch: the upstream tracking branch
 * first, then the branch name directly. Null when both lookups fail.
 */
async function getMergeBase(ctx, cwd, branch, signal) {
	try {
		const upstream = await runCommand(ctx, ["git", "rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd, signal);
		if (upstream.code === 0 && upstream.stdout.trim()) {
			const mergeBase = await runCommand(ctx, ["git", "merge-base", "HEAD", upstream.stdout.trim()], cwd, signal);
			if (mergeBase.code === 0 && mergeBase.stdout.trim()) return mergeBase.stdout.trim();
		}
		const direct = await runCommand(ctx, ["git", "merge-base", "HEAD", branch], cwd, signal);
		if (direct.code === 0 && direct.stdout.trim()) return direct.stdout.trim();
		return null;
	} catch {
		return null;
	}
}

/** Get the list of local branch names; empty when git fails. */
async function getLocalBranches(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "branch", "--format=%(refname:short)"], cwd, signal);
	if (result.code !== 0) return [];
	return result.stdout.trim().split("\n").map((branch) => branch.trim()).filter((branch) => branch.length > 0);
}

/** Whether there are uncommitted changes (staged, unstaged, or untracked). */
async function hasUncommittedChanges(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "status", "--porcelain"], cwd, signal);
	return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * Whether there are changes that would prevent switching branches: staged or
 * unstaged changes to tracked files. Untracked files are fine.
 */
async function hasPendingChanges(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "status", "--porcelain"], cwd, signal);
	if (result.code !== 0) return false;
	const tracked = result.stdout.trim().split("\n").filter((line) => line.trim()).filter((line) => !line.startsWith("??"));
	return tracked.length > 0;
}

/** Current branch name, or null outside a repository / detached HEAD. */
async function getCurrentBranch(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "branch", "--show-current"], cwd, signal);
	return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** Default branch: remote HEAD first, then main, with master as the fallback when there is no main. */
async function getDefaultBranch(ctx, cwd, signal) {
	const symbolic = await runCommand(ctx, ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd, signal);
	if (symbolic.code === 0 && symbolic.stdout.trim()) {
		return symbolic.stdout.trim().replace("origin/", "");
	}
	const branches = await getLocalBranches(ctx, cwd, signal);
	if (branches.includes("main")) return "main";
	// No `main` anywhere (not even a remote HEAD symbol): master is the
	// fallback, even when it does not exist locally either.
	return "master";
}

/**
 * Parse a PR reference (number or GitHub URL) into a PR number.
 * @returns the PR number, or null when the reference is not one.
 */
function parsePrReference(ref) {
	const trimmed = ref.trim();
	const num = Number.parseInt(trimmed, 10);
	if (Number.isInteger(num) && num > 0) return num;
	const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
	if (urlMatch) return Number.parseInt(urlMatch[1], 10);
	return null;
}

/**
 * Fetch PR metadata through the GitHub CLI.
 * @returns base branch, title, and head branch, or null when `gh` fails.
 */
async function getPrInfo(ctx, cwd, prNumber, signal) {
	const result = await runCommand(
		ctx,
		["gh", "pr", "view", String(prNumber), "--json", "baseRefName,title,headRefName"],
		cwd,
		signal,
		GH_TIMEOUT_MS,
	);
	if (result.code !== 0) return null;
	try {
		const data = JSON.parse(result.stdout);
		return {
			baseBranch: data.baseRefName,
			title: data.title,
			headBranch: data.headRefName,
		};
	} catch {
		return null;
	}
}

/**
 * Check out a PR locally through the GitHub CLI.
 * @returns success, or the child's diagnostic on failure.
 */
async function checkoutPr(ctx, cwd, prNumber, signal) {
	const result = await runCommand(ctx, ["gh", "pr", "checkout", String(prNumber)], cwd, signal, GH_TIMEOUT_MS);
	if (result.code !== 0) {
		return { success: false, error: result.stderr || result.stdout || "Failed to checkout PR" };
	}
	return { success: true };
}

export {
	runCommand,
	isGitRepository,
	getMergeBase,
	getLocalBranches,
	hasUncommittedChanges,
	hasPendingChanges,
	getCurrentBranch,
	getDefaultBranch,
	parsePrReference,
	getPrInfo,
	checkoutPr,
};
