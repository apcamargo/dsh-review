/**
 * End-to-end test: the full `/review` command flow against a real git
 * repository through a real `child_process` implementation of the subprocess
 * seam, with the review state over an in-memory domain table.
 *
 * @module @apcamargo/dsh-review/e2e
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand as runProcess } from "../lib/git.js";
import { apply } from "../lib/index.js";
import { REVIEW_SUMMARY_PROMPT } from "../lib/prompts.js";

/** Real collect-mode implementation of the subprocess seam over child_process. */
const subprocess = {
	spawn(spec) {
		const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
		const done = new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
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
			waitForExit: async () => true,
		};
	},
};

/** In-memory KV table mock with durable-boundary validation. */
function makeTable() {
	const records = new Map();
	return {
		get: (key) => records.get(key),
		put: async (key, value) => {
			records.set(key, structuredClone(value));
		},
		delete: async (key) => records.delete(key),
		update: async (key, fn) => {
			const next = fn(records.get(key));
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

const sharedTable = makeTable();
const storageDomain = {
	async open(spec) {
		return {
			name: spec.name,
			close: async () => {},
			table: () => sharedTable,
		};
	},
};

const registered = [];
const commands = {
	register(definition) {
		registered.push(definition);
		return () => registered.splice(registered.indexOf(definition), 1);
	},
};

const effects = [];
const ctx = {
	commands,
	subprocess,
	storageDomain,
	effect(execute, label) {
		for (const disposer of execute()) effects.push({ label, disposer });
	},
};

const AGENT = {
	id: "session-e2e-0001",
	session: { header: {} },
	followups: [],
	followup(message) {
		this.followups.push(message);
	},
};

async function runCommand(commandName, rawInput) {
	const definition = registered.find((entry) => entry.name === commandName);
	assert.ok(definition, `command ${commandName} registered`);
	return definition.handler({
		commandId: "e2e-command-id",
		agent: AGENT,
		rawInput,
		attachments: [],
		signal: new AbortController().signal,
	});
}

async function main() {
	const root = await mkdtemp(path.join(tmpdir(), "dsh-review-e2e-"));
	try {
		const git = async (...args) => {
			const result = await runProcess(ctx, ["git", ...args], root, undefined);
			assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
		};
		await git("init", "-b", "main");
		await git("config", "user.email", "test@example.com");
		await git("config", "user.name", "Test");
		await writeFile(path.join(root, "README.md"), "# test\n");
		await git("add", ".");
		await git("commit", "-m", "initial commit");
		await git("checkout", "-b", "feature");

		AGENT.session.header.cwd = root;

		// apply() over the harness-shaped context.
		await apply(ctx);
		assert.deepEqual(registered.map((entry) => entry.name).sort(), ["end-review", "review"]);

		// Bare invocation defaults to an uncommitted-changes review.
		let result = await runCommand("review", "");
		assert.equal(result.kind, "success");
		assert.match(result.text, /Review started: current changes/);
		assert.equal(AGENT.followups.length, 1);
		assert.match(AGENT.followups[0].content[0].text, /Review the current code changes/);
		await runCommand("end-review", "done");

		// Branch review against main through REAL git.
		result = await runCommand("review", "branch main");
		assert.equal(result.kind, "success");
		assert.match(result.text, /Review started: changes against 'main'/);
		assert.equal(AGENT.followups.length, 2);
		const prompt = AGENT.followups[1].content[0].text;
		assert.match(prompt, /Review the code changes against the base branch 'main'/);
		assert.match(prompt, /merge base commit for this comparison is [0-9a-f]{40}/);

		// Project guidelines: REVIEW_GUIDELINES.md anchored on a DSH .agents marker.
		await mkdir(path.join(root, ".agents"), { recursive: true });
		await writeFile(path.join(root, "REVIEW_GUIDELINES.md"), "Always check the error budget.\n");
		await runCommand("end-review", "done");

		// Bare `/review branch` (no name) compares against the default branch
		// through REAL git: no remote in this repo, so the local main wins. The
		// prompt content itself is pinned by the named-branch review above.
		result = await runCommand("review", "branch");
		assert.equal(result.kind, "success");
		assert.match(result.text, /Review started: changes against 'main'/);
		assert.equal(AGENT.followups.length, 3);
		await runCommand("end-review", "done");

		// Explicit uncommitted review through REAL git.
		result = await runCommand("review", "uncommitted");
		assert.equal(result.kind, "success");
		assert.ok(AGENT.followups[3].content[0].text.includes("Always check the error budget."));
		assert.ok(AGENT.followups[3].content[0].text.includes("Review the current code changes"));

		// Summarize produces the handoff prompt.
		result = await runCommand("end-review", "summarize");
		assert.equal(result.kind, "success");
		assert.ok(AGENT.followups[4].content[0].text.startsWith(REVIEW_SUMMARY_PROMPT));

		// Outside a git repository: git-dependent modes fail loud, folder reviews work.
		const plainDir = await mkdtemp(path.join(tmpdir(), "dsh-review-norepo-"));
		try {
			AGENT.session.header.cwd = plainDir;
			result = await runCommand("review", "uncommitted");
			assert.equal(result.kind, "error");
			assert.match(result.text, /Not a git repository/);
			assert.match(result.text, /\/review folder/);
			result = await runCommand("review", "folder .");
			assert.equal(result.kind, "success");
			assert.match(result.text, /Review started: folders: \./);
			assert.ok(AGENT.followups[5].content[0].text.includes("Review the code in the following paths: ."));
			await runCommand("end-review", "done");
		} finally {
			await rm(plainDir, { recursive: true, force: true });
			AGENT.session.header.cwd = root;
		}

		// A repository with no `main` branch anywhere (master default, no
		// remote): the bare branch review falls back to master through REAL git.
		const masterRoot = await mkdtemp(path.join(tmpdir(), "dsh-review-master-"));
		try {
			const gitMaster = async (...args) => {
				const masterResult = await runProcess(ctx, ["git", ...args], masterRoot, undefined);
				assert.equal(masterResult.code, 0, `git ${args.join(" ")} failed: ${masterResult.stderr}`);
			};
			await gitMaster("init", "-b", "master");
			await gitMaster("config", "user.email", "test@example.com");
			await gitMaster("config", "user.name", "Test");
			await writeFile(path.join(masterRoot, "README.md"), "# test\n");
			await gitMaster("add", ".");
			await gitMaster("commit", "-m", "initial commit");
			AGENT.session.header.cwd = masterRoot;
			result = await runCommand("review", "branch");
			assert.equal(result.kind, "success");
			assert.match(result.text, /Review started: changes against 'master'/);
			assert.equal(AGENT.followups.length, 7);
			// Bare `/end-review` (no mode) defaults to summarize.
			result = await runCommand("end-review", "");
			assert.equal(result.kind, "success");
			assert.ok(AGENT.followups[7].content[0].text.startsWith(REVIEW_SUMMARY_PROMPT));
		} finally {
			await rm(masterRoot, { recursive: true, force: true });
			AGENT.session.header.cwd = root;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	console.log("e2e: all assertions passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
