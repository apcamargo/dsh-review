/**
 * Roster planning for the deep review scan: which reviewer runs, on which lens
 * and shard. Pure planning — no I/O.
 *
 * The file-local lenses split large changes into balanced shards; the
 * cross-cutting lenses always review the whole change and receive the shard
 * map, so cross-file conclusions (contracts, consistency, propagation) are
 * never drawn from a fragment.
 *
 * @module @apcamargo/dsh-review/fleet/roster
 */

/** Lenses that may shard the change. */
export const LOCAL_LENSES = Object.freeze(["correctness", "failure-paths", "security"]);
/** Lenses that always review the whole change. */
export const CROSS_LENSES = Object.freeze(["contracts", "consistency", "propagation", "performance"]);

/**
 * Split weighted files into `count` shards balanced by line weight.
 * @returns an array of `count` file arrays.
 */
export function balancedShards(files, count) {
	if (count <= 1) return [[...files]];
	const sorted = [...files].sort((a, b) => b.lines - a.lines);
	const shards = Array.from({ length: count }, () => []);
	const weights = new Array(count).fill(0);
	for (const file of sorted) {
		const lightest = weights.indexOf(Math.min(...weights));
		shards[lightest].push(file);
		weights[lightest] += file.lines;
	}
	return shards.map((shard) => shard.sort((a, b) => a.path.localeCompare(b.path)));
}

/**
 * Plan one scan's reviewers.
 * @param input - weighted files, whether the listing is available, the enabled
 *   lenses, and the deep settings.
 * @returns roster entries `{ id, lens, shard, files }` in run order, where
 *   `shard` is `{ index, count }` or null for a whole-change lens.
 */
export function planRoster({ files, available, lenses, settings }) {
	const localLenses = lenses.filter((lens) => LOCAL_LENSES.includes(lens));
	const crossLenses = lenses.filter((lens) => CROSS_LENSES.includes(lens)).slice(0, Math.max(1, settings.maxReviewers));
	const totalLines = files.reduce((sum, file) => sum + file.lines, 0);
	let count = 1;
	if (available && totalLines > settings.shardThresholdLines && localLenses.length > 0) {
		const byLines = Math.ceil(totalLines / settings.shardThresholdLines);
		const bySlots = Math.floor((settings.maxReviewers - crossLenses.length) / localLenses.length);
		count = Math.max(1, Math.min(byLines, bySlots));
	}
	const shards = balancedShards(files, count);
	const single = shards.length === 1;
	const roster = [];
	for (let index = 0; index < shards.length; index++) {
		for (const lens of localLenses) {
			roster.push({ id: `R${roster.length + 1}`, lens, shard: single ? null : { index: index + 1, count: shards.length }, files: shards[index] });
		}
	}
	for (const lens of crossLenses) {
		roster.push({ id: `R${roster.length + 1}`, lens, shard: null, files });
	}
	return roster.slice(0, settings.maxReviewers);
}

/** One-line label of a roster entry's scope, for prompts and results. */
export function rosterScope(entry) {
	if (!entry.shard) return entry.files.length ? `whole change (${entry.files.length} files)` : "whole change";
	return `shard ${entry.shard.index}/${entry.shard.count} (${entry.files.length} files)`;
}

/**
 * Whether one deep run's scan counts for verification: every roster entry
 * succeeded, or the succeeded fraction reached the configured quorum — a
 * degraded scan above the fraction counts, and failed reviewers' scopes are
 * uncovered (the coverage line reports the success count). A scan that has
 * not run, or a "partial" state with no roster, does not count. Shared by
 * deep_review_verify's gate (tools.js) and the stop gate (gate.js): the same
 * notion must gate both, or one persistently-failing reviewer above quorum
 * leaves the verify tool reachable while the stop gate loops scan re-calls of
 * the doomed worker and releases a completed review with the incomplete
 * marker.
 */
export function scanCounted(run, minReviewerSuccess) {
	if (run.scan.state === "complete") return true;
	if (run.scan.state !== "partial") return false;
	const total = run.roster?.length ?? 0;
	if (total === 0) return false;
	return run.roster.filter((entry) => entry.state === "succeeded").length / total >= minReviewerSuccess;
}
