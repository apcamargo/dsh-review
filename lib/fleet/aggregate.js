/**
 * The moderator: deterministic aggregation of the lane stances into one verdict
 * per consolidated finding. The plugin arbitrates, never the orchestrator and
 * never a lane.
 *
 * Refutation of a defect via the gating lanes needs two independent dimensions to agree:
 * both gating lanes negative, or one negative plus a cited corroboration (the
 * consistency lane proving the change follows the very pattern the claim says
 * it violates). A single negative with an `unclear` or `untestable` partner is
 * `inconclusive`; a mixed positive/negative is `contested`.
 *
 * A simplification group is the exception: the simplifier lane is its single
 * gate — one negative (`behavior-change`/`not-simpler`) refutes, `simpler`
 * confirms as a single-lane audit.
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
 * The provenance filter's dismissal: a citation-verified pre-existing or
 * intentional stance refutes regardless of gate status, rendering with its
 * cited reason. Shared by both moderation branches, so the promised
 * defect/simplification parity of the filter cannot drift.
 * @returns the dismissal reasons, or undefined when the gates decide.
 */
const provDismissReasons = (provenance) =>
	isWork(provenance) && (provenance.outcome === "pre-existing" || provenance.outcome === "intentional")
		? [`${provenance.outcome} (${provenance.citationNote ?? "cited"})`]
		: undefined;

/**
 * One lane's rendered verdict row: `${laneId}: ${status}` — "not run" (no
 * result), "failed"/"unassessed" (the sentinels), else the lane's outcome
 * plus its citation note and, impact lane only, its blast radius. Shared by
 * both moderation branches so the row rendering cannot drift.
 */
const laneRow = (rows, laneId) => {
	const configured = rows[laneId];
	let status;
	if (configured === undefined) status = "not run";
	else if (configured === "failed") status = "failed";
	else if (configured === "unassessed") status = "unassessed";
	else {
		status = configured.outcome;
		if (configured.citationNote) status += ` (${configured.citationNote})`;
		if (laneId === "impact") status += configured.blastRadius ? ` (${configured.blastRadius})` : "";
	}
	return `${laneId}: ${status}`;
};

/** How many cited precedents render before a "+N more" count. */
const CONSISTENCY_PRECEDENT_CAP = 3;

/**
 * The consistency lane's cited locations, capped: one cited location when a
 * single item grounds the stance (a stated convention needs one), the list
 * that shows the recurrence when several do. Rendered beside the note so the
 * report shows what the stance rests on, not just its head noun.
 */
function precedentsBlock(evidence) {
	const cited = (evidence ?? []).filter((item) => item?.file);
	if (cited.length === 0) return "";
	const shown = cited
		.slice(0, CONSISTENCY_PRECEDENT_CAP)
		.map((item) => `\`${item.file}${item.line ? `:${item.line}` : ""}\``)
		.join(", ");
	const more = cited.length > CONSISTENCY_PRECEDENT_CAP ? ` +${cited.length - CONSISTENCY_PRECEDENT_CAP} more` : "";
	return ` (${cited.length === 1 ? "precedent" : "precedents"}: ${shown}${more})`;
}

/**
 * Moderate one simplification group from its lane results (citation gate
 * already applied). The simplifier lane is the single gate for its kind —
 * defects keep the two-independent-dimensions rule, but a simplification is
 * advisory content whose refutation needs only one negative (the asymmetry
 * points the safe way). The provenance filter outranks the gate exactly as it
 * does for defects: a citation-verified pre-existing or intentional stance
 * dismisses the finding regardless of the simplifier's verdict.
 * @returns the full moderated shape (with `kind: "simplification"`).
 */
function moderateSimplificationGroup(group, rows, hasDiff) {
	const simplifier = rows.simplifier;
	const provenance = hasDiff ? rows.provenance : undefined;
	const dismissal = provDismissReasons(provenance);

	let outcome;
	let reasons = [];
	if (dismissal) {
		outcome = "refuted";
		reasons = dismissal;
	} else if (simplifier === undefined || isBroken(simplifier)) {
		outcome = "unverified";
		reasons = ["simplifier lane failed or did not assess this finding"];
	} else if (simplifier.outcome === "behavior-change") {
		outcome = "refuted";
		reasons = [`simplifier: ${simplifier.notes || "the proposal would change behavior"}`];
	} else if (simplifier.outcome === "not-simpler") {
		outcome = "refuted";
		reasons = [`simplifier: ${simplifier.notes || "the proposal does not simplify the code"}`];
	} else if (simplifier.outcome === "simpler") {
		outcome = "confirmed";
	} else {
		outcome = "inconclusive";
	}

	// One lane audited this: say so. The label describes what the lanes DID
	// (like "reproduced (executed)"), never an outcome assertion — a citation
	// gate proves a quote exists, not that behavior is preserved.
	const strength = outcome === "confirmed" ? "single-lane audit: no behavior change found" : undefined;

	// Priority: the reviewers' (the impact lane does not run for
	// simplifications); the lens is told to prefer P3/P2.
	const priority = fallbackPriority(group.reviewerPriorities);

	// Fix: the proposal IS the simplification; the simplifier's audit note
	// replaces the defect fix audit (the fix-auditor does not run here).
	const proposedFix = group.claims.map((claim) => claim.fixes[0]).filter(Boolean)[0];
	let fix;
	let fixNote;
	if (outcome === "confirmed") {
		fix = proposedFix;
		fixNote = `audited by the simplifier lane${simplifier?.citationNote ? ` (${simplifier.citationNote})` : ""}`;
	}

	const laneIds = hasDiff ? ["simplifier", "provenance"] : ["simplifier"];
	const laneRows = laneIds.map((laneId) => laneRow(rows, laneId));

	return {
		groupId: group.groupId,
		kind: "simplification",
		claims: group.claims,
		reviewerClaims: group.reviewerClaims,
		outcome,
		strength,
		priority,
		priorityWas: undefined,
		fix,
		fixNote,
		consistencyNote: undefined,
		laneRows,
		reasons: reasons.filter(Boolean),
		impact: undefined,
	};
}

/**
 * Moderate one group from its lane results (citation gate already applied).
 * The provenance filter outranks gateFailed: a citation-verified
 * pre-existing/intentional stance dismisses the finding even when a gating
 * lane failed or never assessed it.
 * @returns `{ groupId, kind, outcome, strength, priority, priorityWas, fix, fixNote, consistencyNote, laneRows, claims, reasons }`.
 */
export function moderateGroup(group, rows, hasDiff) {
	if (group.kind === "simplification") return moderateSimplificationGroup(group, rows, hasDiff);
	const repro = rows.reproducer;
	const skept = rows.skeptic;
	const consistency = rows.consistency;
	const provenance = hasDiff ? rows.provenance : undefined;
	const impact = rows.impact;
	const fixAudit = rows["fix-auditor"];
	const dismissal = provDismissReasons(provenance);

	const reproPos = isWork(repro) && repro.outcome === "reproduced" && repro.method === "executed";
	const skeptPos = isWork(skept) && skept.outcome === "reachable";
	const reproNeg = isWork(repro) && repro.outcome === "not-reproduced" && repro.method === "executed" && !!repro.exercisedScenario;
	const skeptNeg = isWork(skept) && skept.outcome === "unreachable";
	// A cited "consistent" stance corroborates refutation only (lanes.js): a
	// positive "inconsistent" stance is a strength note, never a set member.
	const consNeg = isWork(consistency) && consistency.outcome === "consistent";

	// A gating lane that never ran (a failed unit never set a result) counts as
	// broken too: a finding the reproducer or skeptic did not assess is unverified.
	const gateFailed = isBroken(repro) || isBroken(skept) || repro === undefined || skept === undefined;
	const positives = (reproPos ? 1 : 0) + (skeptPos ? 1 : 0);
	const negatives = (reproNeg ? 1 : 0) + (skeptNeg ? 1 : 0);

	let outcome;
	let reasons = [];
	if (dismissal) {
		outcome = "refuted";
		reasons = dismissal;
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

	// The consistency lane's cited verdict becomes a note, never a decision;
	// the cited precedents ride along (up to three, then a count) so the
	// recurrence — or the single stated-convention citation — the stance rests
	// on is visible.
	let consistencyNote;
	if (isWork(consistency) && consistency.outcome === "inconsistent") {
		consistencyNote = `departs from a codebase convention${precedentsBlock(consistency.evidence)}${consistency.citationNote ? ` — ${consistency.citationNote}` : ""}`;
	} else if (isWork(consistency) && consistency.outcome === "consistent") {
		consistencyNote = `matches a codebase convention${precedentsBlock(consistency.evidence)}${consistency.citationNote ? ` — ${consistency.citationNote}` : ""}`;
	}

	// Defect findings render only the defect lanes: the simplifier never runs
	// on a defect group, so a "simplifier: not run" row would be noise, and the
	// provenance row is diff-only (as before).
	const laneRows = Object.values(LANES)
		.filter((lane) => lane.id !== "provenance" || hasDiff)
		.filter((lane) => lane.id !== "simplifier")
		.map((lane) => laneRow(rows, lane.id));

	return {
		groupId: group.groupId,
		kind: "defect",
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
 * Apply the final filter, kind-first. Default deep mode reports only confirmed
 * findings; `--aggressive` also reports the unproven ones as low-confidence
 * suspicions. Simplification groups never enter the defect lists: confirmed
 * ones (and, marked by their outcome, unverified/inconclusive ones — rendered
 * as a count line by default and as labeled "unaudited" items under
 * `--aggressive`) go to the `simplifications` bucket; refuted ones are
 * dismissed with their cited reasons. Routing on kind BEFORE outcome is what
 * keeps a confirmed simplification out of the defect Findings list and an
 * unverified simplification out of the defect suspicions under `--aggressive`.
 * @returns `{ reportable, withheld, dismissed, simplifications }`.
 */
export function classify(moderated, aggressive) {
	const reportable = [];
	const withheld = [];
	const dismissed = [];
	const simplifications = [];
	for (const finding of moderated) {
		if (finding.kind === "simplification") {
			if (finding.outcome === "refuted") dismissed.push(finding);
			else if (finding.outcome === "confirmed" || WITHHELD_OUTCOMES.includes(finding.outcome)) simplifications.push(finding);
			else dismissed.push(finding);
		} else if (finding.outcome === "confirmed") reportable.push(finding);
		else if (finding.outcome === "refuted") dismissed.push(finding);
		else if (WITHHELD_OUTCOMES.includes(finding.outcome)) (aggressive ? reportable : withheld).push(finding);
		else dismissed.push(finding);
	}
	return { reportable, withheld, dismissed, simplifications };
}

/** Location string of the first claim of a group. */
function locationOf(finding) {
	const claim = finding.claims[0];
	if (!claim) return "unknown location";
	return `\`${claim.file}${claim.line ? `:${claim.line}` : ""}\``;
}

/** Cut a claim to one report line. */
function titleOf(finding) {
	const claim = finding.claims.map((item) => item.claim).filter(Boolean)[0] ?? finding.reviewerClaims[0] ?? (finding.kind === "simplification" ? "unspecified simplification" : "unspecified defect");
	return claim.length > 160 ? `${claim.slice(0, 157)}...` : claim;
}

const suspicionOf = (finding) => `${finding.outcome} — the lanes did not settle it`;

/**
 * The empty-state/coverage disclosure for a simplification audit that did not
 * run: names what happened and, where reviewers were lost, which ids. Every
 * line keeps the "- (not evaluated" / "- (partially evaluated" prefix the
 * orchestrator prompts describe, and every non-pinned message points at
 * re-running the review — a completed verification is never re-rendered, so
 * no message may promise a later audit.
 */
function simplificationAuditLine(audit) {
	switch (audit.state) {
		case "not-configured":
			return "- (not evaluated — the simplification lens is not in deep.lenses; add it to enable this audit)";
		case "cut-by-cap":
			return "- (not evaluated — the simplification lens was cut by the reviewer cap (deep.maxReviewers); raise the cap to enable this audit)";
		case "pending":
			return (audit.ids ?? []).length > 1
				? `- (not evaluated — simplification reviewers ${audit.ids.join(", ")} were still pending when verification ran; the audit had not run. Re-run the review to include it)`
				: "- (not evaluated — the simplification reviewer was still pending when verification ran; the audit had not run. Re-run the review to include it)";
		case "failed": {
			// "failed" names the audit (zero simplification reviewers succeeded,
			// at least one genuinely failed), so a mixed roster must not blame a
			// pending reviewer for a failure it never had: name each group by its
			// real state, borrowing the pending branch's own phrasing.
			const pending = audit.pendingIds ?? [];
			const failedIds = (audit.ids ?? []).filter((id) => !pending.includes(id));
			const failedPart = failedIds.length > 1
				? `the simplification reviewers failed (${failedIds.join(", ")})`
				: `the simplification reviewer failed (${failedIds[0] ?? "?"})`;
			if (pending.length === 0) return `- (not evaluated — ${failedPart}; the audit did not run. Re-run the review to retry it)`;
			const pendingPart = pending.length > 1 ? `${pending.join(", ")} were still pending` : `${pending[0]} was still pending`;
			return `- (not evaluated — ${failedPart} and ${pendingPart} when verification ran; the audit did not run. Re-run the review to retry it)`;
		}
		case "partial":
			return `- (partially evaluated — ${(audit.total ?? 0) - (audit.succeeded ?? 0)} of ${audit.total ?? 0} simplification reviewers did not succeed (${(audit.ids ?? []).join(", ")}); their scopes were not audited. Re-run the review to retry it)`;
		/* v8 ignore next 2 -- the state machine is closed; ran renders "- (none)" */
		default:
			return "- (not evaluated — the simplification audit did not run)";
	}
}

/**
 * Render the complete Findings markdown: reported findings, the simplification
 * section, withheld one-liners, dismissed one-liners, and the per-finding lane
 * verdict table. The orchestrator copies this into its report; it cannot
 * promote, demote or rewrite findings.
 *
 * The simplification section is ALWAYS rendered (even as "- (none)") so the
 * orchestrator's verbatim copy satisfies the rubric's required-section rule in
 * every report — including reports with no simplification findings, whose
 * markdown gains exactly the two empty-section lines.
 *
 * `simplificationAudit` is the audit's runtime state (tools.js derives it once,
 * from the scan roster that produced the consolidation). Omitted ⇒ ran, so
 * every existing caller is unaffected.
 *
 * `pending` and `containmentWarning` carry the call's own state into the text
 * the orchestrator actually reads: the structured `pendingRuns`/`budgetSpent`
 * fields never reach it (the render is the output), so a budget-cut verify
 * call must name its unfinished runs and the re-call advice here, and a
 * containment degradation must surface instead of dying in a stdout-only warn.
 */
export function renderFindings({ reportable, withheld, dismissed, simplifications, aggressive, simplificationAudit, tree, coverage, steering, dropped, pending, containmentWarning }) {
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
	out.push("", "## Simplification Opportunities (Non-Blocking)");
	const items = simplifications ?? [];
	const confirmed = items.filter((finding) => finding.outcome === "confirmed");
	const unaudited = items.filter((finding) => finding.outcome !== "confirmed");
	const simplAudit = simplificationAudit ?? { state: "ran" };
	const auditRan = simplAudit.state === "ran";
	// The intro asserts the audit only when that is provably true: a fully
	// successful audit with every item confirmed. Every other state renders
	// the neutral line — the empty-state disclosure, the unaudited count
	// line, and the per-item "(single-lane audit: …)" labels carry the
	// specifics, and a report sentence must never assert an audit that did
	// not run.
	out.push(auditRan && confirmed.length > 0 && unaudited.length === 0
		? "Behavior-preserving cleanups the simplifier lane audited. Non-blocking: informational only — these items alone must not change the verdict, they are not fix items, and none should be applied without verifying behavior is preserved (tests)."
		: "Behavior-preserving cleanup opportunities. Non-blocking: informational only — these items alone must not change the verdict, they are not fix items, and none should be applied without verifying behavior is preserved (tests).");
	if (items.length === 0) {
		// "- (none)" is accurate only when the audit actually ran (nothing
		// found, or every proposal refuted — those render in Dismissed). The
		// runtime audit state discloses every other case: the lens pinned
		// out of deep.lenses, cut by the reviewer cap, or its reviewer
		// failed or still pending above quorum.
		out.push(auditRan ? "- (none)" : simplificationAuditLine(simplAudit));
	} else {
		// Every confirmed item renders — no render cap: the fidelity gate
		// (gate.js) requires the orchestrator's verbatim copy to contain every
		// confirmed title, so any truncation would manufacture a steer no copy
		// can satisfy. The flood bound is the consolidation kind cap
		// (validateVerificationInput allows at most ceil(maxVerifications / 3)
		// simplification groups — 10 at the default), and the section follows
		// the defect Findings, so it cannot bury them.
		for (const finding of confirmed) {
			const proposal = finding.fix ? ` Proposed: ${finding.fix}` : "";
			const audit = [finding.strength, finding.fixNote].filter(Boolean).join("; ");
			// Claims are reviewer text and commonly end with terminal
			// punctuation: never double a title's own period.
			const title = titleOf(finding);
			const sep = /[.!?…]$/.test(title) ? "" : ".";
			out.push(`- ${locationOf(finding)} — ${title}${sep}${proposal} (${audit || "audited"})`);
		}
		if (unaudited.length > 0) {
			// Under --aggressive the unproven ones render as labeled items (the
			// defect suspicions' counterpart, never reusing its phrasing);
			// without the flag a single count line keeps the section honest
			// without turning unverified cleanups into a suggestion list.
			if (aggressive) {
				for (const finding of unaudited) {
					out.push(`- ${locationOf(finding)} — ${titleOf(finding)} [unaudited — do not apply without verifying behavior with tests] (${finding.outcome})`);
				}
			} else {
				out.push(`- ${unaudited.length} raised simplification${unaudited.length === 1 ? "" : "s"} ${unaudited.length === 1 ? "was" : "were"} not audited (the simplifier lane failed, did not assess ${unaudited.length === 1 ? "it" : "them"}, or was unclear) and ${unaudited.length === 1 ? "is" : "are"} omitted.`);
			}
		}
		// Sharded coverage: when some simplification reviewers did not
		// succeed, the rendered items cover only the succeeded shards — say
		// so, the way the coverage line bounds defect coverage.
		if (!auditRan) out.push(simplificationAuditLine(simplAudit));
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
			const kind = finding.kind === "simplification" ? " (simplification)" : "";
			out.push(`- ${titleOf(finding)}${kind} at ${locationOf(finding)} — ${finding.outcome}: ${finding.reasons.join("; ") || "the lanes could not confirm it"}`);
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
	if (pending?.units > 0) {
		const budget = pending.budgetMs ? ` (the ${Math.round(pending.budgetMs / 1000)}s call budget was spent mid-verification)` : "";
		out.push("", `> ⚠️ ${pending.units} verifier run(s) did not finish${budget}. This verification is partial: call deep_review_verify again with the same groups and dropped findings to finish the pending runs.`);
	}
	if (containmentWarning) out.push("", `> ⚠️ ${containmentWarning}`);
	if (steering) out.push("", `> ${steering}`);
	return out.join("\n");
}
