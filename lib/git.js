/**
 * Git and GitHub CLI helpers for the review commands, run through the harness
 * `subprocess` seam (`ctx.subprocess`) so executable lookup, environment
 * scrubbing, and cancellation follow the same execution world as the agent's
 * own shell tools.
 *
 * Every helper fails fast: a command that cannot run, is cancelled, times out,
 * truncates its output, or exits with an unexpected code throws a
 * {@link GitError}. A helper returns a negative answer (`false`, `null`) only
 * for an exit code it names as that answer.
 *
 * @module @apcamargo/dsh-review/git
 */

/** stdout byte cap for git invocations (diff-free listing commands are tiny). */
const STDOUT_CAP = 1_000_000;
/** stderr byte cap for diagnostics. */
const STDERR_CAP = 65_536;
/** Characters of stderr kept in a failure message. */
const STDERR_DETAIL_CHARS = 2_000;
/** Default deadline for one git invocation. */
const GIT_TIMEOUT_MS = 60_000;
/** Deadline for `gh pr checkout`, which fetches a full branch. */
const GH_TIMEOUT_MS = 120_000;

/** Exit code git uses for a fatal error: not a repository, unknown ref, no upstream, no symbolic ref. */
const GIT_FATAL = 128;
/** Exit code `git merge-base` uses when the two commits share no ancestor. */
const GIT_NO_MERGE_BASE = 1;

/**
 * Repository-local git environment: each variable would redirect git away from
 * the repository that `cwd` and its worktree metadata identify.
 */
const REPOSITORY_ENV_NAMES = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_DIR",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_GRAFT_FILE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_REPLACE_REF_BASE",
	"GIT_SHALLOW_FILE",
	"GIT_WORK_TREE",
];

/** Child environment: repository overrides removed, interactive prompts and pagers off. */
const CHILD_ENV = {
	...Object.fromEntries(REPOSITORY_ENV_NAMES.map((name) => [name, undefined])),
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_PAGER: "cat",
	GH_PROMPT_DISABLED: "1",
};

/**
 * A command that did not produce a trustworthy result. Callers branch on
 * `code`, never on the message.
 *
 * - `ABORTED`: the caller's signal aborted.
 * - `TIMEOUT`: the per-call deadline passed.
 * - `UNAVAILABLE`: the executable could not be started.
 * - `OUTPUT_TRUNCATED`: stdout or stderr exceeded its cap.
 * - `FAILED`: the command ended by signal or with an exit code the caller did not allow.
 * - `INVALID_OUTPUT`: the command succeeded but printed output the caller cannot use.
 */
class GitError extends Error {
	/**
	 * @param code - stable failure kind.
	 * @param message - human-readable account naming the command.
	 */
	constructor(code, message) {
		super(message);
		this.name = "GitError";
		this.code = code;
	}
}

/**
 * Run one command to completion through the subprocess seam and collect its
 * output. The caller's signal and a per-call deadline bound the run; the
 * abort starts the provider's terminate escalation on the managed range.
 * @param ctx - context carrying the `subprocess` seam.
 * @param argv - executable and arguments; `argv[0]` is the program.
 * @param cwd - working directory for the child.
 * @param signal - cancellation signal owned by the dispatching request.
 * @param options - `timeoutMs`: per-call deadline; `allowedCodes`: exit codes that are results, not failures.
 * @returns exit code and collected output.
 * @throws {GitError} when the command did not produce a trustworthy result.
 */
async function runCommand(ctx, argv, cwd, signal, { timeoutMs = GIT_TIMEOUT_MS, allowedCodes = [0] } = {}) {
	const command = argv.slice(0, 3).join(" ");
	const deadline = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	// The caller's cancellation wins over the deadline when both have passed.
	const settledAbort = () => {
		if (signal?.aborted) return new GitError("ABORTED", `${command}: cancelled`);
		if (deadline.aborted) return new GitError("TIMEOUT", `${command}: timed out after ${timeoutMs} ms`);
		return null;
	};
	let outcome;
	let handle;
	try {
		handle = ctx.subprocess.spawn({
			argv,
			cwd,
			env: CHILD_ENV,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: STDOUT_CAP },
				stderr: { maxBytes: STDERR_CAP },
			},
			graceMs: 1_000,
			signal: combined,
		});
		outcome = await handle.done;
	} catch (error) {
		// `done` rejects for spawn or provider failures — a missing executable, for example.
		throw settledAbort() ?? new GitError("UNAVAILABLE", `Cannot run ${argv[0]}: ${error.message}`);
	}
	const aborted = settledAbort();
	if (aborted) throw aborted;
	const stdout = handle.collected.stdout?.readFrom(0) ?? { text: "", lossy: false };
	const stderr = handle.collected.stderr?.readFrom(0) ?? { text: "", lossy: false };
	if (stdout.lossy || stderr.lossy) {
		throw new GitError("OUTPUT_TRUNCATED", `${command}: output was truncated`);
	}
	if (outcome.signal || outcome.exitCode === null || !allowedCodes.includes(outcome.exitCode)) {
		const how = outcome.signal ? `terminated by ${outcome.signal}` : `exit ${outcome.exitCode}`;
		// Keep the tail: progress and hook output come first, the fatal line last.
		const text = stderr.text.trim();
		const detail = text.length > STDERR_DETAIL_CHARS ? `…${text.slice(-STDERR_DETAIL_CHARS)}` : text;
		throw new GitError("FAILED", `${command} failed (${how})${detail ? `: ${detail}` : ""}`);
	}
	return { code: outcome.exitCode, stdout: stdout.text, stderr: stderr.text };
}

/**
 * Whether the working directory is inside a git repository.
 * @param ctx - context carrying the `subprocess` seam.
 * @param cwd - working directory to test.
 * @param signal - cancellation signal.
 * @throws {GitError} when git cannot answer; only git's fatal exit means "not a repository".
 */
async function isGitRepository(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "rev-parse", "--git-dir"], cwd, signal, { allowedCodes: [0, GIT_FATAL] });
	return result.code === 0;
}

/**
 * Get the merge base between HEAD and a branch: the upstream tracking branch
 * first, then the branch name directly. Null when git reports no upstream,
 * no such ref, or no common ancestor.
 */
async function getMergeBase(ctx, cwd, branch, signal) {
	const upstream = await runCommand(ctx, ["git", "rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd, signal, {
		allowedCodes: [0, GIT_FATAL],
	});
	if (upstream.code === 0 && upstream.stdout.trim()) {
		const mergeBase = await runCommand(ctx, ["git", "merge-base", "HEAD", upstream.stdout.trim()], cwd, signal, {
			allowedCodes: [0, GIT_NO_MERGE_BASE, GIT_FATAL],
		});
		if (mergeBase.code === 0 && mergeBase.stdout.trim()) return mergeBase.stdout.trim();
	}
	const direct = await runCommand(ctx, ["git", "merge-base", "HEAD", branch], cwd, signal, {
		allowedCodes: [0, GIT_NO_MERGE_BASE, GIT_FATAL],
	});
	if (direct.code === 0 && direct.stdout.trim()) return direct.stdout.trim();
	return null;
}

/** Get the list of local branch names. */
async function getLocalBranches(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "branch", "--format=%(refname:short)"], cwd, signal);
	return result.stdout.trim().split("\n").map((branch) => branch.trim()).filter((branch) => branch.length > 0);
}

/** Whether there are uncommitted changes (staged, unstaged, or untracked). */
async function hasUncommittedChanges(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "status", "--porcelain"], cwd, signal);
	return result.stdout.trim().length > 0;
}

/**
 * Whether there are changes that would prevent switching branches: staged or
 * unstaged changes to tracked files. Untracked files are fine.
 */
async function hasPendingChanges(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "status", "--porcelain", "--untracked-files=no"], cwd, signal);
	return result.stdout.trim().length > 0;
}

/** Current branch name, or null on a detached HEAD. */
async function getCurrentBranch(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "branch", "--show-current"], cwd, signal);
	return result.stdout.trim() || null;
}

/** Default branch: remote HEAD first, then main, with master as the fallback when there is no main. */
async function getDefaultBranch(ctx, cwd, signal) {
	const symbolic = await runCommand(ctx, ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd, signal, {
		allowedCodes: [0, GIT_FATAL],
	});
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
 * @returns base branch, title, and head branch.
 * @throws {GitError} when `gh` fails; `FAILED` means the PR is unreachable.
 * @throws {GitError} `INVALID_OUTPUT` when `gh` prints output that is not the expected JSON.
 */
async function getPrInfo(ctx, cwd, prNumber, signal) {
	const result = await runCommand(
		ctx,
		["gh", "pr", "view", String(prNumber), "--json", "baseRefName,title,headRefName"],
		cwd,
		signal,
		{ timeoutMs: GH_TIMEOUT_MS },
	);
	let data;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		data = null;
	}
	const isName = (value) => typeof value === "string" && value.length > 0;
	if (!data || !isName(data.baseRefName) || !isName(data.headRefName) || typeof data.title !== "string") {
		throw new GitError(
			"INVALID_OUTPUT",
			`gh pr view ${prNumber}: unexpected output (expected JSON with baseRefName, title, headRefName)`,
		);
	}
	return {
		baseBranch: data.baseRefName,
		title: data.title,
		headBranch: data.headRefName,
	};
}

/**
 * Check out a PR locally through the GitHub CLI.
 * @throws {GitError} when `gh` fails; `FAILED` carries the child's diagnostic.
 */
async function checkoutPr(ctx, cwd, prNumber, signal) {
	await runCommand(ctx, ["gh", "pr", "checkout", String(prNumber)], cwd, signal, { timeoutMs: GH_TIMEOUT_MS });
}

export {
	GitError,
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
