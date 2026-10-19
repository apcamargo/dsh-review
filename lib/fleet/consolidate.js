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
 * Reviewer priorities ride along for the aggregation fallback only. `kind` is
 * the group's finding kind ("defect" or "simplification"), which routes the
 * verification lanes (groupsForLane) and the moderation branch; the mixed-kind
 * check in validateVerificationInput guarantees the members agree before this
 * runs, so the first member's kind is the group's.
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
		kind: raw[0]?.kind ?? "defect",
		claims,
		reviewerPriorities: raw.map((finding) => finding.priority).filter(Boolean),
		reviewerClaims: raw.map((finding) => finding.claim),
		hasFixes: claims.some((claim) => claim.fixes.length > 0),
	};
}

/**
 * The per-lane group routing shared by deep_review_verify's unit planning
 * (tools.js) and validateVerificationInput's plannedRuns mirror — the two sites
 * MUST agree or the maxVerifierRuns estimate diverges from the runs actually
 * planned (this file's own history documents exactly that divergence class for
 * the fix-auditor). Defect lanes judge defect groups; the fix-auditor only the
 * defect groups that propose a fix; the simplifier audits simplification
 * groups; provenance filters both kinds but only on diff targets (the hasDiff
 * guard stays here rather than relying on applicableLanes, because callers may
 * pass a lane list that includes provenance with hasDiff=false — the pinned
 * accounting test does exactly that).
 * @returns the assessments this lane runs over.
 */
export function groupsForLane(lane, assessments, hasDiff) {
	switch (lane.id) {
		case "reproducer":
		case "skeptic":
		case "consistency":
		case "impact":
			return assessments.filter((group) => group.kind === "defect");
		case "fix-auditor":
			return assessments.filter((group) => group.kind === "defect" && group.hasFixes);
		case "simplifier":
			return assessments.filter((group) => group.kind === "simplification");
		case "provenance":
			return hasDiff ? [...assessments] : [];
		/* v8 ignore next 2 -- the lane catalog is closed; every member is handled above */
		default:
			throw new Error(`review: unknown verifier lane "${String(lane?.id)}"`);
	}
}

/**
 * Validate the orchestrator's consolidation and build the assessments.
 * @returns `{ ok, error?, assessments?, plannedRuns? }`; `error` is a
 *   correctable message listing the offending ids or counts.
 */
export function validateVerificationInput({ groups, dropped }, rawFindings, settings, lanes, hasDiff) {
	if (!Array.isArray(groups)) return { ok: false, error: "groups must be an array" };
	if (groups.length > settings.maxVerifications) {
		return { ok: false, error: `${groups.length} groups exceed the maximum of ${settings.maxVerifications}; drop simplification groups first, then the lowest-priority defect findings, each with a reason, and verify the rest` };
	}
	// The kind cap allows at most ceil(maxVerifications / 3) simplification
	// groups — a third of the cap, rounded up so a maxVerifications of 1 or 2
	// can still verify one simplification; the rest of the cap stays for defect
	// findings, so a simplification flood (possible under --aggressive on a
	// cleanup-heavy diff) can never crowd defect verification out of the
	// consolidation, and the drop order is enforced here rather than trusted to
	// the orchestrator's instructions.
	const maxSimplificationGroups = Math.ceil(settings.maxVerifications / 3);
	const seen = new Set();
	let simplificationGroups = 0;
	for (const group of groups) {
		if (!group?.primary) return { ok: false, error: "every group needs a `primary` finding id" };
		let groupKind;
		for (const id of [group.primary, ...(group.mergedFrom ?? [])]) {
			if (!rawFindings.has(id)) return { ok: false, error: `unknown finding id "${id}"` };
			if (seen.has(id)) return { ok: false, error: `finding "${id}" appears in more than one group` };
			seen.add(id);
			// Mixed-kind groups are forbidden: defect and simplification
			// findings verify under different lanes, so a merged group would
			// silently lose one kind's gate (the defect lanes never see it, or
			// the simplifier audits a defect). Checked per id so the error can
			// name the offending finding.
			const kind = rawFindings.get(id)?.kind ?? "defect";
			if (groupKind === undefined) groupKind = kind;
			else if (kind !== groupKind) return { ok: false, error: `finding "${id}" is a ${kind} but group "${group.primary}" is ${groupKind} — never merge kinds; move "${id}" to a ${kind}-only group or drop it with a reason` };
		}
		if (groupKind === "simplification") simplificationGroups++;
	}
	if (simplificationGroups > maxSimplificationGroups) {
		return { ok: false, error: `${simplificationGroups} simplification groups exceed the maximum of ${maxSimplificationGroups} (a third of maxVerifications, rounded up, reserving the rest for defect findings); drop the lowest-stakes simplification groups first, each with a reason, and verify the rest` };
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
	// The mirror of deep_review_verify's actual planning (tools.js): the SAME
	// groupsForLane routing must drive both, or the estimate diverges from the
	// runs actually planned and the cap either spuriously rejects valid
	// consolidations or silently lets them through.
	let plannedRuns = 0;
	for (const lane of lanes) {
		const size = settings.lanes[lane.id]?.chunkSize ?? lane.chunkSize;
		const count = groupsForLane(lane, assessments, hasDiff).length;
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
 * whose cited lines sit within 3 of each other, and of the SAME kind — a
 * defect and a simplification touching neighboring lines are never duplicates
 * (they verify under different lanes and must not be merged or dropped for
 * each other), so clustering across kinds would steer the orchestrator into a
 * rejection. Hints only — the orchestrator decides what is a duplicate.
 */
export function overlapHints(rawFindings) {
	const findings = [...rawFindings.entries()].filter(([, finding]) => finding.file && typeof finding.line === "number");
	const kindOf = (finding) => finding.kind ?? "defect";
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
			if (a.file === b.file && kindOf(a) === kindOf(b) && Math.abs(a.line - b.line) <= 3) parent.set(find(idA), find(idB));
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
