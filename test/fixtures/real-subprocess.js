/**
 * Real collect-mode implementation of the harness `subprocess` seam over
 * `child_process`, shared by the tests that run real git. The environment
 * mirrors the lib's own resolution: an `undefined` override removes the
 * variable, which is how the lib scrubs the repository-redirecting variables.
 *
 * @module test/fixtures/real-subprocess
 */

import { spawn } from "node:child_process";

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
export const realSubprocess = {
	spawn(spec) {
		const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: childEnv(spec.env), stdio: ["ignore", "pipe", "pipe"] });
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
