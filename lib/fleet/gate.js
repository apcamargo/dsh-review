/**
 * The deep review stop gate.
 *
 * `agent/turn-stopping` fires before a turn closes. While a deep run's pipeline
 * is incomplete, the gate steers the orchestrator back to work, so it cannot
 * declare itself done before the verifiers ran. It always releases eventually:
 * at most two steers, on cancellation, and when a user message claimed the turn
 * (the user has taken over — the pause is per turn, not sticky). After a
 * release with an unfinished pipeline the run is marked `incomplete`, which
 * `/review status` and the `/end-review` prompts carry.
 *
 * The gate also checks report fidelity once: after verification completes, the
 * orchestrator's last message must contain every reported finding. A missing
 * finding steers once; the check is best-effort and documented as such.
 *
 * @module @apcamargo/dsh-review/fleet/gate
 */

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { REVIEW_MESSAGE_SOURCE } from "../source.js";
import { scanCounted } from "./roster.js";

/** Source tag of the gate's steers; excluded from the steering ledger. */
export { REVIEW_MESSAGE_SOURCE as GATE_MESSAGE_SOURCE };

function gateMessage(text) {
	return createUserMessage({ content: [{ type: "text", text }], source: REVIEW_MESSAGE_SOURCE });
}

/** What the gate wants for one stop boundary. */
export function decide(run, turn, signal) {
	if (!signal.aborted && run.pausedTurns.has(`${run.id}:${turn}`)) return { action: "wait" };
	// The scan counts when every reviewer succeeded, or the succeeded fraction
	// reached the configured quorum — the same gate deep_review_verify enforces
	// (scanCounted). One persistently-failing reviewer above quorum leaves the
	// scan "partial" forever, and the gate must not spend its steers looping
	// scan re-calls of the doomed worker: it steers verification instead, and a
	// completed verification over a counted scan releases without the marker.
	const counted = scanCounted(run, run.settings.minReviewerSuccess);
	// The steer budget releases only a still-incomplete pipeline: a completed,
	// faithful review must never carry the incomplete marker (steers spent on a
	// slow start do not make a finished review incomplete). The marker names the
	// gate's own release semantics and no cause it cannot verify — an
	// orchestrator can be responding to every steer while the pipeline stays
	// incomplete, so a failure claim would be provably wrong there.
	if (run.steerCount >= 2 && !(counted && run.verify.state === "complete")) return { action: "release", incomplete: "the deep review pipeline did not complete (the stop gate released after two steers with the pipeline incomplete)" };
	if (run.scan.state === "none") return { action: "steer", reason: "the reviewer fleet has not run. Call `deep_review_scan` now; it returns the raw findings to consolidate." };
	if (run.scan.state === "partial" && !counted) {
		return { action: "steer", reason: "the scan is below quorum (some reviewers are pending or failed). Call `deep_review_scan` again; it finishes only the pending reviewers." };
	}
	if (run.verify.state === "none") {
		return { action: "steer", reason: "the verifiers have not run. Group the scan's findings by root cause and call `deep_review_verify` with `groups` and `dropped` — every raw finding id must be accounted for. When there is nothing to verify (the scan found nothing, or every finding was dropped), call it with `groups: []` and `dropped: []`." };
	}
	if (run.verify.state === "partial") {
		return { action: "steer", reason: "verification is incomplete (some verifier runs are pending or failed). Call `deep_review_verify` again with the same groups; it finishes only the pending runs." };
	}
	// Fidelity: the last assistant message must carry every reported finding.
	if (run.verify.state === "complete" && !run.fidelityChecked) {
		run.fidelityChecked = true;
		const missing = missingReportedFindings(run);
		if (missing.length > 0) {
			return { action: "steer", reason: `the final report is missing verified findings: ${missing.join("; ")}. Copy the Findings section of the deep_review_verify result into your report.` };
		}
	}
	return { action: "release" };
}

/** Best-effort: which reported finding titles are absent from the last assistant message. */
export function missingReportedFindings(run) {
	const reported = run.verify.classified?.reportable ?? [];
	if (reported.length === 0) return [];
	let last;
	try {
		const messages = run.agent?.session?.deriveMessages?.() ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				last = messages[i];
				break;
			}
		}
	} catch {
		return [];
	}
	if (!last) return [];
	const text = (last.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n");
	return reported
		.map((finding) => {
			const title = finding.claims.map((claim) => claim.claim).filter(Boolean)[0];
			if (!title) return undefined;
			return text.includes(title.length > 80 ? title.slice(0, 80) : title) ? undefined : `\`${finding.claims[0]?.file ?? "?"}\` (${finding.groupId})`;
		})
		.filter(Boolean)
		.slice(0, 5);
}

/**
 * Install the gate listeners on one context.
 * @param ctx - context carrying the agent event bus.
 * @param runs - Map of agent id → deep run.
 * @param onEnd - end callback for agent disposal.
 */
export function registerGate(ctx, runs, onEnd) {
	ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
		const run = runs.get(agent.id);
		if (!run || signal.aborted) return;
		let decision;
		try {
			decision = decide(run, turn, signal);
		} catch (error) {
			if (signal.aborted) return;
			throw error;
		}
		if (signal.aborted || runs.get(agent.id) !== run) return;
		if (decision.action === "steer") {
			run.steerCount++;
			agent.steer(gateMessage(`Deep review: ${decision.reason}`));
		} else if (decision.action === "release" && decision.incomplete) {
			run.incomplete = decision.incomplete;
		}
	});

	// A user message claimed in this turn pauses the gate for that turn only.
	ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
		const run = runs.get(agent.id);
		if (!run || message.source?.kind !== "user") return;
		run.pausedTurns.add(`${agent.id}:${turn}`);
	});

	// The user removed or edited a queued message: the steering entry follows.
	ctx.on("agent/inbox/discarded", ({ agent, message }) => {
		const run = runs.get(agent.id);
		if (!run) return;
		run.ledger.discard(message);
	});

	// Dynamic steering: user-typed guidance reaches the fleet's later workers.
	ctx.on("agent/inbox/inserted", ({ agent, message }) => {
		const run = runs.get(agent.id);
		if (!run || message.source?.kind !== "user") return;
		// Worker agents' prompts also arrive as user messages; the strict agent
		// identity check is what keeps them out of the ledger. The top lookup
		// already excludes worker children (they are their own sessions with
		// their own ids), so identity here is belt-and-braces against a same-id
		// different-object event: the event's agent is the same session agent
		// object begin() captured, so the orchestrator's steering never falsely
		// rejects, and the ledger never records a look-alike event.
		if (agent !== run.agent) return;
		run.ledger.replace(message);
		run.ledger.add(message);
	});

	ctx.on("agent/disposed", ({ agent }) => {
		if (runs.has(agent.id)) onEnd(agent.id);
	});
}
