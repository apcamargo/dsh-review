/**
 * Verifier blindness: what each lane's verifiers see, enforced by construction.
 *
 * A lane's prompt is built only from stored REVIEWER-authored finding fields,
 * projected per lane. The orchestrator's reasoning (drop reasons, group
 * framing, consolidation rationale), the reviewers' evidence, priority,
 * confidence and lens, and every other lane's input or output never reach a
 * verifier. Finding order and chunk membership are shuffled per lane with a
 * seeded PRNG, so lanes see different neighbors and positions; the seed is
 * (run id + lane id), so tests are reproducible. Refs are opaque per lane
 * (`C1…Cn`) and mapped back by the plugin.
 *
 * @module @apcamargo/dsh-review/fleet/blind
 */

/** FNV-1a string hash, so a text seed becomes a 32-bit PRNG seed. */
export function hashSeed(text) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Mulberry32 PRNG; deterministic per seed and reproducible in tests. */
export function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher-Yates copy; the input is never mutated. */
export function shuffled(items, rng) {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

/**
 * The finding fields one lane sees for one report. Everything else — the
 * reviewers' evidence, priority, confidence, lens and ids, the orchestrator's
 * framing — is projected out here, so no code path can leak it.
 * @returns an array of `{ file, line, claim, scenario, fixes }`, one per
 *   merged claim; `fixes` only for the fix-auditor and the simplifier.
 */
export function projectForLane(laneId, claims) {
	const projected = claims.map((claim) => {
		const base = { file: claim.file, line: claim.line, claim: claim.claim, scenario: claim.scenario };
		// The fix-auditor needs the proposed fix; the simplifier audits the
		// proposed simplification, which IS the fix.
		if (laneId === "fix-auditor" || laneId === "simplifier") base.fixes = claim.fixes;
		return base;
	});
	return projected;
}

/** One anonymous report block; numbered, untrusted framing handled by the prompt builder. */
export function renderReport(index, claims) {
	const lines = [`<report ref="C${index}">`];
	if (claims.length > 1) {
		lines.push("Independent reports of what the reporting reviewers judged to be the same issue (they may overlap or contradict each other; say so in `notes`):");
	}
	claims.forEach((claim, i) => {
		const prefix = claims.length > 1 ? `[${i + 1}] ` : "";
		lines.push(`${prefix}Location: \`${claim.file}${claim.line ? `:${claim.line}` : ""}\``);
		lines.push(`${prefix}Claim: ${claim.claim}`);
		if (claim.scenario) lines.push(`${prefix}Scenario: ${claim.scenario}`);
		if (claim.fixes?.length) for (const fix of claim.fixes) lines.push(`${prefix}Proposed fix: ${fix}`);
	});
	lines.push("</report>");
	return lines.join("\n");
}

/**
 * Plan one lane's verifier runs over the assessment groups.
 * @returns runs `{ laneId, chunkIndex, chunkCount, refMap, reports }` where
 *   `refMap` maps each opaque ref back to its group id and `reports` is the
 *   shuffled, projected report text.
 */
export function planLaneRuns(laneId, groups, { chunkSize, seed }) {
	const rng = mulberry32(hashSeed(`${seed}::${laneId}`));
	const ordered = shuffled(groups, rng);
	const chunks = [];
	for (let i = 0; i < ordered.length; i += chunkSize) chunks.push(ordered.slice(i, i + chunkSize));
	return chunks.map((chunk, chunkIndex) => {
		const refMap = new Map();
		const reports = [];
		chunk.forEach((group, position) => {
			const ref = `C${position + 1}`;
			refMap.set(ref, group.groupId);
			const claims = shuffled(projectForLane(laneId, group.claims), rng);
			reports.push(renderReport(position + 1, claims));
		});
		return { laneId, chunkIndex: chunkIndex + 1, chunkCount: chunks.length, refMap, reports };
	});
}
