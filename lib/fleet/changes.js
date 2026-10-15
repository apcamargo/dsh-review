/**
 * Changed-file listing for the deep-review roster, and the working-tree
 * integrity snapshot.
 *
 * Weights are changed lines from `git diff --numstat -z`; untracked files count
 * as a flat 100 lines (their size is unknown without reading each one), and
 * generated or vendored paths are excluded entirely from the uncommitted and
 * diff listings; the in-repo folder path keeps them as 0-weight entries in the
 * whole-change lenses' file list and lists untracked net-new files under the
 * requested paths too (agreeing with the outside-repo walk, which lists
 * everything).
 *
 * In-repo folder pathspecs normalize against cwd first: worktree-internal
 * absolute and ../ paths become pathspecs git accepts from any cwd, and the
 * cwd itself becomes "." because git rejects an empty pathspec. A
 * worktree-external pathspec (absolute-outside, ../-escaping) fails
 * all-or-nothing with git's "outside repository" fatal — the walk then lists
 * the requested paths directly (the outside-repo convention, generated paths
 * re-weighted to 0) and carries git's diagnostic in the note. An empty git
 * listing with no requested path on disk is a typo, not a legitimate empty
 * change, and is named in the note.
 *
 * @module @apcamargo/dsh-review/fleet/changes
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GitError, runCommand } from "../git.js";

/** Flat line weight of one untracked file. */
const UNTRACKED_WEIGHT_LINES = 100;
/** Content above this size is hashed by size only. */
const HASH_SIZE_CAP = 1_000_000;
/** Folders never walked or weighted. (.DS_Store is a file; walkFiles skips
 * dot-files by name, so it needs no folder entry here.) */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "vendor"]);
/** Generated or vendored paths, with per-target semantics: excluded entirely
 * from the uncommitted and diff listings; kept as 0-weight entries in the
 * folder listings (they still reach the whole-change lenses, which grep
 * them). */
const GENERATED = /(^|\/)(node_modules|dist|build|coverage|vendor)(\/|$)|\.lock$|\.min\.[cm]?js$|(^|\/)package-lock\.json$/;

/** Whether a path is generated or vendored, so it carries no sharding weight. */
export function isGeneratedPath(filePath) {
	return GENERATED.test(filePath);
}

/**
 * Parse `git diff --numstat -z` output: NUL-terminated records of
 * `<added>\t<deleted>\t<path>`; `-`/`-` is a binary file, and a rename reads
 * the counts record, then the old path, then the new path (each NUL-separated,
 * unquoted) — the new path is the roster entry.
 */
export function parseNumstat(text) {
	const files = [];
	const parts = text.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const counts = parts[i];
		if (!counts.trim()) continue;
		const fields = counts.split("\t");
		const [added, deleted] = fields;
		if (added === "-" || deleted === "-") continue;
		let filePath;
		if (fields[2] === "") {
			// renamed with -z: the next two NUL records are the old and new paths
			filePath = parts[(i += 2)];
		} else {
			filePath = fields.slice(2).join("\t");
		}
		const lines = (Number(added) || 0) + (Number(deleted) || 0);
		if (filePath) files.push({ path: filePath, lines });
	}
	return files;
}

/** Merge file weights by path, keeping the first occurrence's path. */
function mergeFiles(target, files) {
	for (const file of files) {
		if (isGeneratedPath(file.path)) continue;
		const existing = target.find((entry) => entry.path === file.path);
		if (existing) existing.lines += file.lines;
		else target.push({ ...file });
	}
	return target;
}

async function listUntracked(ctx, cwd, signal) {
	const result = await runCommand(ctx, ["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd, signal);
	// -z paths are verbatim: no quoting under NUL termination, so a filename
	// with leading/trailing whitespace is legal and must survive. Trimming
	// would resolve the trimmed path for the roster and its line weights.
	// Empty records come from the trailing NUL and are dropped by the filter.
	return result.stdout.split("\0").filter((item) => item.length > 0);
}

/** Walk one directory for the folder snapshot review (no git required).
 * Dot-dirs and dot-files are skipped except `.agents` (the DSH convention
 * marker directory), so hidden configuration (.github, .vscode, .DS_Store)
 * never reaches a folder snapshot review; SKIP_DIRS (node_modules, dist, …)
 * are skipped by name. Directories and files that cannot be read, and every
 * non-regular entry inside the walk (a symlinked directory, a FIFO), are
 * skipped and collected with their reasons, so the coverage can name them. */
export async function walkFiles(root, signal, skipped = []) {
	const files = [];
	async function visit(dir) {
		signal?.throwIfAborted();
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			skipped.push({ path: dir, reason: "unreadable" });
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				await visit(full);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				const stats = await fs.stat(full).catch(() => null);
				// A dangling symlink, or a file that vanished between readdir and
				// stat, is named in the coverage like an unreadable directory —
				// silently absent from the roster would read as a complete walk.
				if (!stats) {
					skipped.push({ path: full, reason: "unreadable" });
					continue;
				}
				if (stats.isFile()) files.push({ path: path.relative(root, full), lines: Math.max(1, Math.ceil(stats.size / 40)) });
				// A symlinked directory (or any other non-regular entry: a FIFO, a
				// socket) is neither listed nor recursed — recursing a symlink
				// would walk outside the reviewed root and risk a symlink cycle.
				// It is named in the coverage like an unreadable directory: silently
				// absent from the roster would read as a complete walk.
				else skipped.push({ path: full, reason: stats.isDirectory() ? "symlinked directory" : "not a regular file" });
			}
		}
	}
	await visit(root);
	return files;
}

/**
 * Walk the requested paths directly: the outside-repo folder deployment, and
 * the fallback when an in-repo git pathspec fails all-or-nothing. The note
 * names unreadable directories and every other skipped entry with its reason;
 * the caller carries the triggering git diagnostic in the note.
 * @returns `{ files, available: true, note? }`.
 */
async function listRequestedWalk(cwd, paths, signal) {
	const files = [];
	const seen = new Set();
	const skipped = [];
	for (const item of paths) {
		const root = path.resolve(cwd, item);
		const stats = await fs.stat(root).catch(() => null);
		if (stats?.isFile()) {
			const rel = path.relative(cwd, root);
			if (!seen.has(rel)) { seen.add(rel); files.push({ path: rel, lines: Math.max(1, Math.ceil(stats.size / 40)) }); }
			continue;
		}
		for (const entry of await walkFiles(root, signal, skipped)) {
			const rel = path.relative(cwd, path.join(root, entry.path));
			if (!seen.has(rel)) { seen.add(rel); files.push({ path: rel, lines: entry.lines }); }
		}
	}
	const note = skipped.length > 0
		? `${skipped.length} path${skipped.length === 1 ? "" : "s"} skipped from the walk: ${[...new Set(skipped.map((item) => `${path.relative(cwd, item.path)} (${item.reason})`))].join(", ")}`
		: undefined;
	return { files, available: true, note };
}

/**
 * List the change's files with sharding weights for one resolved target.
 * @returns `{ files, available, note? }`; `available: false` means the roster
 * uses one shard and the coverage notes say why.
 */
export async function listChangedFiles(ctx, cwd, target, signal) {
	if (target.type === "uncommitted") {
		const files = [];
		for (const argv of [["git", "diff", "--numstat", "--cached", "-z"], ["git", "diff", "--numstat", "-z"]]) {
			mergeFiles(files, parseNumstat((await runCommand(ctx, argv, cwd, signal)).stdout));
		}
		for (const untracked of await listUntracked(ctx, cwd, signal)) {
			if (!isGeneratedPath(untracked) && !files.some((file) => file.path === untracked)) {
				files.push({ path: untracked, lines: UNTRACKED_WEIGHT_LINES });
			}
		}
		return { files, available: true };
	}
	if (target.type === "baseBranch" || target.type === "pullRequest") {
		if (!target.mergeBase) return { files: [], available: false, note: "no merge base; the whole change reviews as one shard" };
		// The diff listing excludes generated or vendored paths entirely, the
		// same class the uncommitted listing skips (the header names both
		// listings in one exclusion class): a lock-only PR would otherwise
		// spend sharding weight and reviewer runs on generated noise.
		const files = parseNumstat((await runCommand(ctx, ["git", "diff", "--numstat", "-z", target.mergeBase], cwd, signal)).stdout)
			.filter((file) => !isGeneratedPath(file.path));
		return { files, available: true };
	}
	if (target.type === "commit") {
		const files = parseNumstat(
			(await runCommand(ctx, ["git", "diff-tree", "--no-commit-id", "--numstat", "-z", "-r", "-m", "--first-parent", target.sha], cwd, signal)).stdout,
		).filter((file) => !isGeneratedPath(file.path));
		return { files, available: true };
	}
	if (target.type === "folder") {
		const repo = await isRepo(ctx, cwd, signal);
		// Outside a repository, walk only the REQUESTED paths: the reviewer
		// prompt names them, so a whole-cwd walk would put sibling directories
		// in the roster that no prompt ever named. Generated or vendored paths
		// re-weight to 0, the outside-repo convention the header names and the
		// worktree-external fallback keeps — still listed, never sharding
		// weight.
		if (!repo) {
			const walked = await listRequestedWalk(cwd, target.paths, signal);
			const files = walked.files.map((file) => ({ ...file, lines: isGeneratedPath(file.path) ? 0 : file.lines }));
			return { ...walked, files };
		}
		// Tracked files PLUS untracked net-new files under the requested paths:
		// the outside-repo path lists everything, so the two deployments must
		// agree — an untracked src/new-module.js has to reach the roster or the
		// file-local lenses never review it. Requested paths normalize against
		// cwd first: worktree-internal absolute and ../ paths become pathspecs
		// git accepts from any cwd, and the cwd itself becomes "." because git
		// rejects an empty pathspec.
		const relative = target.paths.map((item) => {
			const normalized = path.relative(cwd, path.resolve(cwd, item));
			return normalized === "" ? "." : normalized;
		});
		const pathspec = ["--", ...relative];
		let listing;
		try {
			const tracked = await runCommand(ctx, ["git", "ls-files", "-z", ...pathspec], cwd, signal);
			const untracked = await runCommand(ctx, ["git", "ls-files", "-z", "--others", "--exclude-standard", ...pathspec], cwd, signal);
			// -z paths are verbatim (no quoting, no trimming): a filename with
			// leading/trailing whitespace is legal, and the roster's fs.stat
			// resolves the exact path. Empty records are dropped by the filter.
			listing = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter((item) => item.length > 0))];
		} catch (error) {
			// A worktree-external pathspec (absolute-outside, ../-escaping) fails
			// all-or-nothing with git's "outside repository" fatal: walk the
			// requested paths directly, agreeing with the outside-repo
			// deployment, and carry git's diagnostic in the coverage note. A
			// cancelled or timed-out listing is not a pathspec failure and
			// rethrows.
			if (!(error instanceof GitError) || error.code !== "FAILED") throw error;
			const walked = await listRequestedWalk(cwd, target.paths, signal);
			const files = walked.files.map((file) => ({ ...file, lines: isGeneratedPath(file.path) ? 0 : file.lines }));
			const diagnostic = `git listing failed (${error.message}); walked the requested paths directly`;
			return { files, available: true, note: walked.note ? `${walked.note}; ${diagnostic}` : diagnostic };
		}
		const files = [];
		for (const filePath of listing) {
			const stats = await fs.stat(path.resolve(cwd, filePath)).catch(() => null);
			files.push({ path: filePath, lines: isGeneratedPath(filePath) ? 0 : Math.max(1, Math.ceil((stats?.size ?? 0) / 40)) });
		}
		// An empty listing with no requested path on disk is a typo, not a
		// legitimate empty change: git succeeds vacuously for an unmatched
		// pathspec, and a silently empty roster would run reviewers with empty
		// scopes. Name it in the coverage note instead.
		if (listing.length === 0) {
			const existing = await Promise.all(target.paths.map((item) => fs.stat(path.resolve(cwd, item)).catch(() => null)));
			if (existing.every((stats) => stats === null)) {
				return { files, available: true, note: `no requested path exists under the worktree: ${target.paths.join(", ")}` };
			}
		}
		return { files, available: true };
	}
	// custom focus: the reviewer decides what to inspect; no listing.
	return { files: [], available: false, note: "custom focus; the reviewers follow the focus text" };
}

/** Whether the working directory is inside a git repository. Exported for the
 * snapshot's outside-a-repo contract (null is documented ONLY for that case). */
export async function isRepo(ctx, cwd, signal) {
	try {
		const result = await runCommand(ctx, ["git", "rev-parse", "--git-dir"], cwd, signal, { allowedCodes: [0, 128] });
		return result.code === 0;
	} catch (error) {
		if (error instanceof GitError && error.code === "UNAVAILABLE") return false;
		throw error;
	}
}

/**
 * Parse `git status --porcelain=v1 -z` output into NUL-joined worktree paths:
 * NUL-terminated records of `XY <path>` (unquoted under -z). A staged rename
 * (XY containing R/C) emits a second NUL record carrying the old path — the
 * rename source, gone from the worktree — which is skipped so it is not hashed
 * as a phantom "deleted" file.
 */
function parseStatusPaths(text) {
	const parts = text.split("\0");
	const out = [];
	for (let i = 0; i < parts.length; i++) {
		const record = parts[i];
		// The record's status chars are always non-whitespace, so the emptiness
		// check never trims the path: `XY <path>` stays verbatim, whitespace
		// in a filename included.
		if (!record) continue;
		out.push(record.slice(3));
		const status = record.slice(0, 2);
		if (status.includes("R") || status.includes("C")) i += 1;
	}
	return out.join("\0");
}

/**
 * Snapshot the working tree's relevant files: tracked-but-modified, deleted,
 * and untracked paths, plus the staged (index vs HEAD) state from
 * `git status` — `git ls-files -m -d -o` lists the worktree against the index
 * and untracked paths only, so a staged-only change (`git add`, `git mv`,
 * `git rm`) would be invisible and the before/after snapshots would match —
 * each with a content hash (size only above the cap).
 * @returns a Map of path → digest, or null outside a repository. A real git
 *   failure inside a repository propagates ({@link GitError}) — only
 *   outside-a-repo (git missing, folder targets outside a worktree) answers
 *   null, so the "files changed during review" guard is never silently off for
 *   a repo whose git broke; both call sites re-derive their state on a re-call.
 */
export async function snapshotTree(ctx, cwd, signal) {
	if (!(await isRepo(ctx, cwd, signal))) return null;
	let paths;
	try {
		const worktree = (await runCommand(ctx, ["git", "ls-files", "-m", "-d", "-o", "--exclude-standard", "-z"], cwd, signal)).stdout;
		// `git status --porcelain -z` also lists the index against HEAD and
		// answers 0 on a repository with no commits, where `git diff HEAD`
		// would fail with a fatal. A staged rename emits two NUL records (new,
		// old): the old path is the rename source, gone from the worktree, so
		// the parse skips it instead of hashing a phantom "deleted" file.
		const index = parseStatusPaths((await runCommand(ctx, ["git", "status", "--porcelain=v1", "-z"], cwd, signal)).stdout);
		paths = `${worktree}\0${index}`;
	} catch (error) {
		// GitError FAILED is NOT conflated with outside-a-repo (the isRepo guard
		// above settled that case): a repo whose git broke propagates its honest
		// diagnostic instead of turning the integrity guard off silently.
		if (error instanceof GitError && error.code === "UNAVAILABLE") return null;
		throw error;
	}
	const snapshot = new Map();
	// -z paths are verbatim: no quoting under NUL termination, so a filename
	// with leading/trailing whitespace is legal and tracked verbatim. Trimming
	// would stat the trimmed path, and both snapshots would record "deleted"
	// under the trimmed key — the "files changed during review" guard never
	// firing for that file. Empty records come from the trailing NUL and are
	// dropped by the filter.
	for (const filePath of [...new Set(paths.split("\0").filter(Boolean))]) {
		const full = path.resolve(cwd, filePath);
		const stats = await fs.stat(full).catch(() => null);
		if (!stats?.isFile()) {
			snapshot.set(filePath, "deleted");
			continue;
		}
		if (stats.size > HASH_SIZE_CAP) {
			snapshot.set(filePath, `size:${stats.size}`);
			continue;
		}
		const content = await fs.readFile(full).catch(() => null);
		snapshot.set(filePath, content ? createHash("sha256").update(content).digest("hex") : "unreadable");
	}
	return snapshot;
}

/**
 * Compare two snapshots. Either side null (outside a repository) reads as
 * not-checked; nothing is ever reverted by the plugin.
 */
export function treeDiff(before, after) {
	if (!before || !after) return { checked: false, changed: [] };
	const changed = [];
	for (const [filePath, digest] of after) {
		if (before.get(filePath) !== digest) changed.push(filePath);
	}
	for (const filePath of before.keys()) {
		if (!after.has(filePath)) changed.push(filePath);
	}
	return { checked: true, changed: [...new Set(changed)].sort() };
}
