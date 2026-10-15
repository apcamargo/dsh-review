/**
 * The moderator: deterministic aggregation of the lane stances into one verdict
 * per consolidated finding. The plugin arbitrates, never the orchestrator and
 * never a lane.
 *
 * Refutation via the gating lanes needs two independent dimensions to agree:
 * both gating lanes negative, or one negative plus a cited corroboration (the
 * consistency lane proving the change follows the very pattern the claim says
 * it violates). A single negative with an `unclear` or `untestable` partner is
 * `inconclusive`; a mixed positive/negative is `contested`.
 *
 * The provenance lane is a filter, not a corroboration: a citation-verified
 * `pre-existing`/`intentional` stance dismisses the finding regardless of gate
 * status (a broken or never-assessed gating lane included), and the dismissal
 * always renders with its cited reason in the Dismissed section. The citation
 * gate verifies the stance against the current tree (no git blame), so it
 * proves the cited code exists, not the pre-change state.
 *
 * A gating lane that failed leaves the finding `unverified` unless the
 * provenance filter dismissed it — never silently reported or dropped.
 *
 * @module @apcamargo/dsh-review/fleet/aggregate
 */

import { LANES } from "./lanes.js";
import { PRIORITY_ENUM } from "./schemas.js";

export const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

/** Highest reviewer priority of a group (lowest rank), or P2 when none. */
function fallbackPriority(reviewerPriorities) {
	let best;
	for (const priority of reviewerPriorities) {
		if (PRIORITY_RANK[priority] === undefined) continue;
		if (best === undefined || PRIORITY_RANK[priority] < PRIORITY_RANK[best]) best = priority;
	}
	return best ?? "P2";
}

const isWork = (result) => result !== undefined && result !== "failed" && result !== "unassessed";
const isBroken = (result) => result === "failed" || result === "unassessed";

/**
 * Moderate one group from its lane results (citation gate already applied).
 * The provenance filter outranks gateFailed: a citation-verified
 * pre-existing/intentional stance dismisses the finding even when a gating
 * lane failed or never assessed it.
 * @returns `{ groupId, outcome, strength, priority, priorityWas, fix, fixNote, consistencyNote, laneRows, claims, reasons }`.
 */
export function moderateGroup(group, rows, hasDiff) {
	const repro = rows.reproducer;
	const skept = rows.skeptic;
	const consistency = rows.consistency;
	const provenance = hasDiff ? rows.provenance : undefined;
	const impact = rows.impact;
	const fixAudit = rows["fix-auditor"];

	const reproPos = isWork(repro) && repro.outcome === "reproduced" && repro.method === "executed";
	const skeptPos = isWork(skept) && skept.outcome === "reachable";
	const reproNeg = isWork(repro) && repro.outcome === "not-reproduced" && repro.method === "executed" && !!repro.exercisedScenario;
	const skeptNeg = isWork(skept) && skept.outcome === "unreachable";
	// A cited "consistent" stance corroborates refutation only (lanes.js): a
	// positive "inconsistent" stance is a strength note, never a set member.
	const consNeg = isWork(consistency) && consistency.outcome === "consistent";
	const provDismiss = isWork(provenance) && (provenance.outcome === "pre-existing" || provenance.outcome === "intentional");

	// A gating lane that never ran (a failed unit never set a result) counts as
	// broken too: a finding the reproducer or skeptic did not assess is unverified.
	const gateFailed = isBroken(repro) || isBroken(skept) || repro === undefined || skept === undefined;
	const positives = (reproPos ? 1 : 0) + (skeptPos ? 1 : 0);
	const negatives = (reproNeg ? 1 : 0) + (skeptNeg ? 1 : 0);

	let outcome;
	let reasons = [];
	if (provDismiss) {
		outcome = "refuted";
		reasons = [`${provenance.outcome} (${provenance.citationNote ?? "cited"})`];
	} else if (gateFailed) {
		outcome = "unverified";
		// A never-ran lane (a failed verifier unit leaves the row undefined)
		// counts as broken too — name it, or the reason renders with an empty
		// lane list.
		const broken = [(repro === undefined || isBroken(repro)) ? "reproducer" : null, (skept === undefined || isBroken(skept)) ? "skeptic" : null].filter(Boolean);
		reasons = [`${broken.join(" and ")} lane${broken.length === 1 ? "" : "s"} failed or did not assess this finding`];
	} else if (reproNeg && skeptNeg) {
		outcome = "refuted";
		// Notes are normalized to "" post-cap, so `||` (not `??`) reaches the
		// fallback text when a lane left its notes empty.
		reasons = [`reproducer: ${repro.notes || "not reproduced"}`, `skeptic: ${skept.notes || "unreachable"}`];
	} else if (negatives === 1 && positives === 0 && consNeg) {
		outcome = "refuted";
		reasons = [`${reproNeg ? "reproducer" : "skeptic"} negative; consistency: ${consistency.notes || "matches the codebase"}`];
	} else if (positives > 0 && negatives > 0) {
		outcome = "contested";
	} else if (positives > 0) {
		outcome = "confirmed";
	} else {
		outcome = "inconclusive";
	}

	let strength;
	if (reproPos && skeptPos) strength = "reproduced and traced";
	else if (reproPos) strength = "reproduced (executed)";
	else if (skeptPos) strength = "traced (reachable)";

	// Priority: the impact lane's own severity wins; the reviewers' highest is
	// the fallback. `negligible` caps at P3.
	const impactPriority = isWork(impact) && PRIORITY_ENUM.includes(impact.priority) ? impact.priority : undefined;
	const reviewerPriority = fallbackPriority(group.reviewerPriorities);
	let priority = impactPriority ?? reviewerPriority;
	if (isWork(impact) && impact.outcome === "negligible") priority = "P3";
	const priorityWas = impactPriority && impactPriority !== reviewerPriority ? reviewerPriority : undefined;

	// Fix: the fix-auditor's verdict decides what the report shows.
	let fix;
	let fixNote;
	const proposedFix = group.claims.map((claim) => claim.fixes[0]).filter(Boolean)[0];
	if (isWork(fixAudit)) {
		if (fixAudit.fixVerdict === "sound") {
			fix = proposedFix;
			fixNote = "audited sound";
		} else if (fixAudit.fixVerdict === "flawed") {
			if (fixAudit.revisedSuggestion?.trim()) {
				fix = fixAudit.revisedSuggestion.trim();
				fixNote = `auditor revised the proposed fix${fixAudit.problems?.length ? `; problems: ${fixAudit.problems.join("; ")}` : ""}`;
			} else {
				fixNote = `fix needs design${fixAudit.problems?.length ? `; problems: ${fixAudit.problems.join("; ")}` : ""}`;
			}
		} else {
			fixNote = "no fix proposed";
		}
	} else if (isBroken(fixAudit)) {
		fix = proposedFix;
		fixNote = "fix unaudited (the fix-auditor lane failed)";
	} else if (proposedFix) {
		fix = proposedFix;
		fixNote = "not audited (fix-auditor lane not run)";
	}

	// The consistency lane's cited verdict becomes a note, never a decision.
	let consistencyNote;
	if (isWork(consistency) && consistency.outcome === "inconsistent") {
		const precedent = consistency.evidence?.[0];
		consistencyNote = `departs from the codebase pattern${precedent ? ` (precedent: \`${precedent.file}${precedent.line ? `:${precedent.line}` : ""}\`)` : ""}${consistency.citationNote ? ` — ${consistency.citationNote}` : ""}`;
	} else if (isWork(consistency) && consistency.outcome === "consistent") {
		const precedent = consistency.evidence?.[0];
		consistencyNote = `matches the codebase pattern${precedent ? ` (\`${precedent.file}${precedent.line ? `:${precedent.line}` : ""}\`)` : ""}${consistency.citationNote ? ` — ${consistency.citationNote}` : ""}`;
	}

	const laneRows = Object.values(LANES)
		.filter((lane) => lane.id !== "provenance" || hasDiff)
		.map((lane) => {
			const configured = rows[lane.id];
			let status;
			if (configured === undefined) status = "not run";
			else if (configured === "failed") status = "failed";
			else if (configured === "unassessed") status = "unassessed";
			else {
				status = configured.outcome;
				if (configured.citationNote) status += ` (${configured.citationNote})`;
				if (lane.id === "impact") status += configured.blastRadius ? ` (${configured.blastRadius})` : "";
			}
			return `${lane.id}: ${status}`;
		});

	return {
		groupId: group.groupId,
		claims: group.claims,
		reviewerClaims: group.reviewerClaims,
		outcome,
		strength,
		priority,
		priorityWas,
		fix,
		fixNote,
		consistencyNote,
		laneRows,
		reasons: reasons.filter(Boolean),
		impact: isWork(impact) ? { priority: impact.priority, blastRadius: impact.blastRadius, notes: impact.notes } : undefined,
	};
}

/** Moderate every group. */
export function moderate({ assessments, laneResults, hasDiff }) {
	return assessments.map((group) => moderateGroup(group, laneResults.get(group.groupId) ?? {}, hasDiff));
}

const WITHHELD_OUTCOMES = ["contested", "inconclusive", "unverified"];

/**
 * Apply the final filter. Default deep mode reports only confirmed findings;
 * `--aggressive` also reports the unproven ones as low-confidence suspicions.
 * @returns `{ reportable, withheld, dismissed }`.
 */
export function classify(moderated, aggressive) {
	const reportable = [];
	const withheld = [];
	const dismissed = [];
	for (const finding of moderated) {
		if (finding.outcome === "confirmed") reportable.push(finding);
		else if (finding.outcome === "refuted") dismissed.push(finding);
		else if (WITHHELD_OUTCOMES.includes(finding.outcome)) (aggressive ? reportable : withheld).push(finding);
		else dismissed.push(finding);
	}
	return { reportable, withheld, dismissed };
}

/** Location string of the first claim of a group. */
function locationOf(finding) {
	const claim = finding.claims[0];
	if (!claim) return "unknown location";
	return `\`${claim.file}${claim.line ? `:${claim.line}` : ""}\``;
}

/** Cut a claim to one report line. */
function titleOf(finding) {
	const claim = finding.claims.map((item) => item.claim).filter(Boolean)[0] ?? finding.reviewerClaims[0] ?? "unspecified defect";
	return claim.length > 160 ? `${claim.slice(0, 157)}...` : claim;
}

const suspicionOf = (finding) => `${finding.outcome} — the lanes did not settle it`;

/**
 * Render the complete Findings markdown: reported findings, withheld
 * one-liners, dismissed one-liners, and the per-finding lane verdict table.
 * The orchestrator copies this into its report; it cannot promote, demote or
 * rewrite findings.
 */
export function renderFindings({ reportable, withheld, dismissed, tree, coverage, steering, dropped }) {
	const out = [];
	out.push("## Findings (verified by independent adversarial lanes)");
	if (reportable.length === 0) out.push("No findings survived verification. The lanes found nothing they could confirm.");
	for (const finding of reportable) {
		// classify puts only confirmed or withheld outcomes into reportable;
		// withheld outcomes render as low-confidence suspicions.
		const suspicion = WITHHELD_OUTCOMES.includes(finding.outcome);
		const label = suspicion ? `[${finding.priority}] [suspicion: ${suspicionOf(finding)}]` : `[${finding.priority}] [${finding.strength ?? finding.outcome}]`;
		out.push("", `### ${label} ${titleOf(finding)}`);
		out.push(`- Location: ${locationOf(finding)}`);
		if (finding.priorityWas) out.push(`- Priority assessed by the impact lane; the reviewers said ${finding.priorityWas}.`);
		if (finding.impact?.blastRadius) out.push(`- Impact: ${finding.impact.blastRadius}${finding.impact.notes ? ` — ${finding.impact.notes}` : ""}`);
		if (finding.fix) out.push(`- Suggested fix: ${finding.fix}`);
		if (finding.fixNote) out.push(`- Fix audit: ${finding.fixNote}.`);
		if (finding.consistencyNote) out.push(`- Consistency: ${finding.consistencyNote}.`);
		if (suspicion) out.push("- What would settle it: re-run the review, or judge from the lane verdicts below.");
		out.push(`- Lane verdicts: ${finding.laneRows.join(" · ")}`);
	}
	if (withheld.length > 0) {
		out.push("", "## Withheld (raised but unverified)");
		out.push("These were raised by the scan and not confirmed by the lanes; judge them yourself if they matter to you.");
		for (const finding of withheld) {
			out.push(`- [${finding.priority}] ${titleOf(finding)} at ${locationOf(finding)} — ${finding.outcome}${finding.reasons.length ? `: ${finding.reasons.join("; ")}` : ""}`);
		}
	}
	if (dismissed.length > 0) {
		out.push("", "## Dismissed by the lanes");
		for (const finding of dismissed) {
			out.push(`- ${titleOf(finding)} at ${locationOf(finding)} — ${finding.outcome}: ${finding.reasons.join("; ") || "the lanes could not confirm it"}`);
		}
	}
	if (dropped?.length > 0) {
		out.push("", "## Dropped during consolidation");
		for (const item of dropped) {
			out.push(`- \`${item.id}\` — ${item.reason}`);
		}
	}
	if (tree?.checked && tree.changed.length > 0) {
		out.push("", `> ⚠️ The working tree changed during review (possibly by you): ${tree.changed.slice(0, 10).join(", ")}${tree.changed.length > 10 ? ` and ${tree.changed.length - 10} more` : ""}. Findings may cite stale lines.`);
	}
	if (coverage) out.push("", `> Coverage: ${coverage}`);
	if (steering) out.push("", `> ${steering}`);
	return out.join("\n");
}
