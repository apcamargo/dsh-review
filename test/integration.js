/**
 * Integration test: the git helpers against a real git repository, run through
 * a real `child_process` implementation of the subprocess collect-mode seam.
 *
 * @module @apcamargo/dsh-review/integration
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitError, runCommand, getMergeBase, getLocalBranches, hasUncommittedChanges, hasPendingChanges, getCurrentBranch, getDefaultBranch, isGitRepository } from "../lib/git.js";

/** Process environment with the spec's overrides applied; an `undefined` override removes the variable. */
function childEnv(overrides = {}) {
	const env = { ...process.env };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

/** Real collect-mode implementation of the subprocess seam over child_process. */
const subprocess = {
	spawn(spec) {
		const child = spawn(spec.argv[0], spec.argv.slice(1), {
			cwd: spec.cwd,
			env: childEnv(spec.env),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
		const done = new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
		});
		let settled = false;
		done.then(() => {
			settled = true;
		});
		return {
			done,
			collected: {
				stdout: {
					readFrom: () => {
						const text = Buffer.concat(stdoutChunks).toString("utf8");
						return { text, nextOffset: Buffer.byteLength(text), lossy: false };
					},
				},
				stderr: {
					readFrom: () => {
						const text = Buffer.concat(stderrChunks).toString("utf8");
						return { text, nextOffset: Buffer.byteLength(text), lossy: false };
					},
				},
			},
			terminate: () => child.kill(),
			waitForExit: async () => settled,
		};
	},
};

const ctx = { subprocess };

async function initRepo(root) {
	const run = async (...args) => {
		const result = await runCommand(ctx, ["git", ...args], root, undefined);
		assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	};
	await run("init", "-b", "main");
	await run("config", "user.email", "test@example.com");
	await run("config", "user.name", "Test");
	await writeFile(path.join(root, "README.md"), "# test\n");
	await run("add", ".");
	await run("commit", "-m", "initial");
	await run("checkout", "-b", "feature");
	await writeFile(path.join(root, "src.ts"), "export {}\n");
	await run("add", ".");
	await run("commit", "-m", "feature change");
}

/** One-commit repository on the given default branch, for fallback checks. */
async function initSimpleRepo(root, defaultBranch) {
	const run = async (...args) => {
		const result = await runCommand(ctx, ["git", ...args], root, undefined);
		assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	};
	await run("init", "-b", defaultBranch);
	await run("config", "user.email", "test@example.com");
	await run("config", "user.name", "Test");
	await writeFile(path.join(root, "README.md"), "# test\n");
	await run("add", ".");
	await run("commit", "-m", "init");
}

async function main() {
	const root = await mkdtemp(path.join(tmpdir(), "dsh-review-"));
	try {
		await initRepo(root);

		assert.equal(await isGitRepository(ctx, root, undefined), true);
		assert.equal(await getCurrentBranch(ctx, root, undefined), "feature");
		assert.deepEqual(await getLocalBranches(ctx, root, undefined).then((branches) => branches.sort()), ["feature", "main"]);
		assert.equal(await getDefaultBranch(ctx, root, undefined), "main");
		assert.equal(await hasUncommittedChanges(ctx, root, undefined), false);
		assert.equal(await hasPendingChanges(ctx, root, undefined), false);

		const mergeBase = await getMergeBase(ctx, root, "main", undefined);
		assert.ok(mergeBase && /^[0-9a-f]{40}$/.test(mergeBase), `merge base resolved: ${mergeBase}`);

		// Untracked files count as uncommitted but not as pending (branch-switch-safe).
		await writeFile(path.join(root, "untracked.txt"), "hi\n");
		assert.equal(await hasUncommittedChanges(ctx, root, undefined), true);
		assert.equal(await hasPendingChanges(ctx, root, undefined), false);

		// Tracked modifications block branch switching.
		await writeFile(path.join(root, "README.md"), "# changed\n");
		assert.equal(await hasPendingChanges(ctx, root, undefined), true);

		// A repository-redirecting variable inherited from the host process must not
		// point git away from the repository that the working directory identifies.
		process.env.GIT_DIR = path.join(root, "no-such-git-dir");
		try {
			assert.equal(await isGitRepository(ctx, root, undefined), true);
			assert.equal(await getCurrentBranch(ctx, root, undefined), "feature");
		} finally {
			delete process.env.GIT_DIR;
		}

		// Real git reports a plain directory as outside a repository, and only that
		// fatal exit means "no repository": every other command fails loudly there.
		const plainDir = await mkdtemp(path.join(tmpdir(), "dsh-review-norepo-"));
		try {
			assert.equal(await isGitRepository(ctx, plainDir, undefined), false);
			await assert.rejects(getLocalBranches(ctx, plainDir, undefined), (error) => error instanceof GitError && error.code === "FAILED");
		} finally {
			await rm(plainDir, { recursive: true, force: true });
		}

		// Default-branch fallback: with no `main` anywhere, master is used —
		// both when master exists and when it does not.
		for (const startBranch of ["master", "develop"]) {
			const fallbackRoot = await mkdtemp(path.join(tmpdir(), `dsh-review-fallback-${startBranch}-`));
			try {
				await initSimpleRepo(fallbackRoot, startBranch);
				assert.equal(await getDefaultBranch(ctx, fallbackRoot, undefined), "master",
					`repo initialized on '${startBranch}' with no main falls back to master`);
			} finally {
				await rm(fallbackRoot, { recursive: true, force: true });
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	console.log("integration: all assertions passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
