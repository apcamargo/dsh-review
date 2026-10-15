/**
 * The verifier lane catalog. Every lane is an independent adversarial critic:
 * a fresh child agent that attacks one validation dimension of the consolidated
 * findings, blind to the orchestrator's reasoning and to every other lane.
 *
 * Roles in aggregation:
 * - `gating`: its stance decides confirmed/refuted/contested. The reproducer
 *   and the skeptic gate every finding and cannot be disabled.
 * - `corroborating`: a cited stance joins the negative set (corroborating
 *   refutation); it can never decide a report alone.
 * - `advisory`: sets the final priority or the fix; never decides the outcome.
 * - `filter`: removes pre-existing or intentional findings from diff targets.
 *
 * @module @apcamargo/dsh-review/fleet/lanes
 */

export const LANES = Object.freeze({
	reproducer: Object.freeze({
		id: "reproducer",
		role: "gating",
		mandatory: true,
		chunkSize: 4,
		guard: "executing",
		cited: false,
		chunkable: () => true,
		persona: "You are an adversarial QA reproducer. For each report you judge exactly one thing: can the claimed failure be demonstrated? Prefer executing: run the existing tests that touch the claimed path, and use throwaway scripts under `mktemp -d` to exercise the claimed scenario. Never edit the working tree, never install dependencies, never touch the network. A demonstration you did not run is `untestable`, never `reproduced` or `not-reproduced`. Record the commands you ran and what you observed in `reproduction`, and the evidence that would change your verdict in `whatWouldChangeMyMind`.",
	}),
	skeptic: Object.freeze({
		id: "skeptic",
		role: "gating",
		mandatory: true,
		chunkSize: 8,
		guard: "static",
		cited: true,
		chunkable: () => true,
		persona: "You are an adversarial architect skeptic. For each report you judge exactly one thing: is the claimed failing state actually reachable in the real call paths, or is it guarded, impossible, or assumed? Trace the actual callers and guards in the code; cite the exact file and line you read. Your job is to break the claim, not to confirm it: if the report's scenario cannot happen, `unreachable` with the guard that prevents it. When you cannot settle it either way, `unclear`. Never argue from plausibility: a stance without a concrete citation is `unclear`.",
	}),
	consistency: Object.freeze({
		id: "consistency",
		role: "corroborating",
		mandatory: false,
		chunkSize: 6,
		guard: "static",
		cited: true,
		chunkable: () => true,
		persona: "You are an adversarial consistency auditor. For each report you judge exactly one thing: does the rest of the codebase support or contradict the claim? Search the whole codebase for precedents: how do sibling modules, parallel implementations, and the established patterns around the changed code handle what the claim says is mishandled? `inconsistent` when the change departs from a concrete precedent (cite the precedent file and line); `consistent` when the codebase shows the changed code follows the very pattern the claim says it violates; `unclear` when you find no precedent either way. Your verdict never decides a report alone — it corroborates the reproducer and the skeptic. Never argue from style: only a concrete precedent at a file and line counts.",
	}),
	provenance: Object.freeze({
		id: "provenance",
		role: "filter",
		mandatory: false,
		chunkSize: 15,
		guard: "static",
		cited: true,
		chunkable: () => true,
		persona: "You are an adversarial provenance auditor. For each report you judge exactly one thing: was the issue introduced by the change under review, or does it pre-exist, or is it intentional? Use the diff and `git log`/`git blame` on the cited lines; cite the diff hunk or the pre-change line. `pre-existing` needs the same defect visible before the change; `intentional` needs a comment, a convention, or an explicit decision in the code. Anything else is `unclear`.",
	}),
	impact: Object.freeze({
		id: "impact",
		role: "advisory",
		mandatory: false,
		chunkSize: 10,
		guard: "static",
		cited: false,
		chunkable: () => true,
		persona: "You are an adversarial severity assessor. For each report you judge exactly one thing: how bad is it, judged from the report alone and the code around the cited location? Give your own priority (P0 drop-everything universal; P1 urgent; P2 normal; P3 low) and the blast radius (local, module, system, user-data). Do not anchor on any severity the report implies: judge it yourself. `negligible` when no realistic scenario makes it matter.",
	}),
	"fix-auditor": Object.freeze({
		id: "fix-auditor",
		role: "advisory",
		mandatory: false,
		chunkSize: 6,
		guard: "static",
		cited: false,
		chunkable: () => true,
		persona: "You are an adversarial fix auditor. For each report you judge exactly one thing: is the proposed fix proper and robust? Check four ways: does it address the root cause (not a symptom); would it regress anything (callers, invariants, error paths); does it match how the codebase handles the same problem elsewhere; and does it follow fail-fast error handling (no silent catch/fallback recovery unless the layer is a real boundary)? `flawed` with `problems` naming each way it fails; `revisedSuggestion` only when you can propose something strictly better. `absent` when no fix is proposed.",
	}),
});

/** Lanes that run for a diff target; the provenance lane is diff-only. The
 * mandatory lanes are forced on by resolveDeepConfig (config.js), which throws
 * when a mandatory lane is disabled, so a resolved settings object can never
 * turn one off here. */
export function applicableLanes(settings, hasDiff) {
	const out = [];
	for (const lane of Object.values(LANES)) {
		const configured = settings.lanes[lane.id];
		const enabled = configured?.enabled !== false;
		if (lane.id === "provenance" && !hasDiff) continue;
		if (!enabled) continue;
		out.push(lane);
	}
	return out;
}
