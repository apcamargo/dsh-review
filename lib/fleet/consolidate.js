/**
 * Consolidation bookkeeping: validation of the orchestrator's groups, the
 * blind per-group assessments the lanes read, and the deterministic overlap
 * hints. Pure — no I/O.
 *
 * The orchestrator authors only structure (`primary`, `mergedFrom`, dropped
 * reasons); the plugin builds each lane's input from the stored raw findings,
 * so the orchestrator cannot silently alter reviewer text.
 *
 * @module @apcamargo/dsh-review/fleet/consolidate
 */

/**
 * Build one blind assessment per group: the flattened claims the lanes judge.
 * Reviewer priorities ride along for the aggregation fallback only.
 */
export function buildAssessment(groupId, ids, rawFindings) {
	const raw = [];
	for (const id of ids) {
		const finding = rawFindings.get(id);
		if (finding) raw.push(finding);
	}
	const claims = raw.map((finding) => ({
		file: finding.file,
		line: finding.line,
		claim: finding.claim,
		scenario: finding.scenario,
		fixes: finding.suggestedFix ? [finding.suggestedFix] : [],
	}));
	return {
		groupId,
		claims,
		reviewerPriorities: raw.map((finding) => finding.priority).filter(Boolean),
		reviewerClaims: raw.map((finding) => finding.claim),
		hasFixes: claims.some((claim) => claim.fixes.length > 0),
	};
}

/**
 * Validate the orchestrator's consolidation and build the assessments.
 * @returns `{ ok, error?, assessments?, plannedRuns? }`; `error` is a
 *   correctable message listing the offending ids or counts.
 */
export function validateVerificationInput({ groups, dropped }, rawFindings, settings, lanes, hasDiff) {
	if (!Array.isArray(groups)) return { ok: false, error: "groups must be an array" };
	if (groups.length > settings.maxVerifications) {
		return { ok: false, error: `${groups.length} groups exceed the maximum of ${settings.maxVerifications}; drop the lowest-priority findings with reasons and verify the rest` };
	}
	const seen = new Set();
	for (const group of groups) {
		if (!group?.primary) return { ok: false, error: "every group needs a `primary` finding id" };
		for (const id of [group.primary, ...(group.mergedFrom ?? [])]) {
			if (!rawFindings.has(id)) return { ok: false, error: `unknown finding id "${id}"` };
			if (seen.has(id)) return { ok: false, error: `finding "${id}" appears in more than one group` };
			seen.add(id);
		}
	}
	for (const item of dropped ?? []) {
		if (!item?.id || !item?.reason?.trim()) return { ok: false, error: "every dropped item needs an `id` and a non-empty `reason`" };
		if (!rawFindings.has(item.id)) return { ok: false, error: `unknown dropped finding id "${item.id}"` };
		if (seen.has(item.id)) return { ok: false, error: `finding "${item.id}" is both grouped and dropped` };
		seen.add(item.id);
	}
	const unaccounted = [...rawFindings.keys()].filter((id) => !seen.has(id));
	// An empty consolidation is the pipeline's explicit "nothing to verify"
	// close: rawFindings is empty, or every finding was dropped with a reason
	// (the dropped loop above checked the ids). Empty groups with unaccounted
	// ids is the non-compliance case and keeps its correctable message — the
	// advertised "skip deep_review_verify" escape was impossible (drop-everything
	// is rejected here before the dropped checks were even readable as an
	// escape), which dead-ended the stop gate for a legitimate clean review.
	if (groups.length === 0 && unaccounted.length > 0) {
		return { ok: false, error: "groups must name at least one finding; when every finding was dropped, call deep_review_verify with groups: [] and the dropped list" };
	}
	if (unaccounted.length > 0) {
		return { ok: false, error: `findings not accounted for: ${unaccounted.join(", ")} — merge each into a group or drop it with a reason` };
	}
	const assessments = groups.map((group, index) => buildAssessment(`V${index + 1}`, [group.primary, ...(group.mergedFrom ?? [])], rawFindings));
	// Match the actual planning (tools.js): the fix-auditor runs over the groups
	// that propose a fix, the provenance lane is diff-only, and a lane with no
	// groups plans no runs. Counting the fix-auditor over ALL assessments would
	// spuriously reject valid consolidations against deep.maxVerifierRuns.
	let plannedRuns = 0;
	for (const lane of lanes) {
		const size = settings.lanes[lane.id]?.chunkSize ?? lane.chunkSize;
		const count = lane.id === "fix-auditor" ? assessments.filter((group) => group.hasFixes).length : lane.id === "provenance" && !hasDiff ? 0 : assessments.length;
		if (count === 0) continue;
		plannedRuns += Math.ceil(count / size);
	}
	if (plannedRuns > settings.maxVerifierRuns) {
		return { ok: false, error: `${plannedRuns} verifier runs exceed the maximum of ${settings.maxVerifierRuns}; merge more findings into groups or raise deep.maxVerifierRuns` };
	}
	return { ok: true, assessments, plannedRuns };
}

/**
 * Deterministic overlap hints for the orchestrator: findings in the same file
 * whose cited lines sit within 3 of each other. Hints only — the orchestrator
 * decides what is a duplicate.
 */
export function overlapHints(rawFindings) {
	const findings = [...rawFindings.entries()].filter(([, finding]) => finding.file && typeof finding.line === "number");
	const parent = new Map(findings.map(([id]) => [id, id]));
	const find = (id) => {
		let root = id;
		while (parent.get(root) !== root) root = parent.get(root);
		// Path compression: point every node on the walk at the root.
		while (parent.get(id) !== root) {
			const next = parent.get(id);
			parent.set(id, root);
			id = next;
		}
		return root;
	};
	for (let i = 0; i < findings.length; i++) {
		for (let j = i + 1; j < findings.length; j++) {
			const [idA, a] = findings[i];
			const [idB, b] = findings[j];
			if (a.file === b.file && Math.abs(a.line - b.line) <= 3) parent.set(find(idA), find(idB));
		}
	}
	const clusters = new Map();
	for (const [id] of findings) {
		const root = find(id);
		if (!clusters.has(root)) clusters.set(root, []);
		clusters.get(root).push(id);
	}
	return [...clusters.values()].filter((cluster) => cluster.length > 1);
}
