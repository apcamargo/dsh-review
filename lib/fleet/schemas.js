/**
 * Structured-output JSON Schemas for the fleet's workers, within the harness's
 * enforced subset (type, properties, required, additionalProperties, items,
 * enum). Every free-text field is length-capped in the descriptions, and the
 * plugin re-caps at normalization time.
 *
 * @module @apcamargo/dsh-review/fleet/schemas
 */

export const PRIORITY_ENUM = Object.freeze(["P0", "P1", "P2", "P3"]);
export const CONFIDENCE_ENUM = Object.freeze(["high", "medium", "low"]);

/** One evidence item a reviewer or verifier cites. */
const EVIDENCE_ITEM = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: {
		file: { type: "string", description: "Repository path, capped at 300 characters." },
		line: { type: "integer", description: "1-based line, when the evidence is line-specific." },
		quote: { type: "string", description: "The exact code or text quoted, capped at 300 characters." },
	},
	required: ["file"],
});

/** What one reviewer returns. */
export const REVIEWER_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: {
		findings: {
			type: "array",
			description: "Every qualifying issue found under this lens. Empty when there are none.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					priority: { type: "string", enum: [...PRIORITY_ENUM], description: "[P0] drop everything, [P1] urgent, [P2] normal, [P3] low." },
					confidence: { type: "string", enum: [...CONFIDENCE_ENUM], description: "How settled the claim is. Suspicions are low." },
					category: { type: "string", description: "Short tag, capped at 40 characters." },
					title: { type: "string", description: "One line, capped at 200 characters." },
					file: { type: "string", description: "Repository path, capped at 300 characters." },
					line: { type: "integer", description: "1-based line in that file." },
					claim: { type: "string", description: "What is wrong and why, capped at 1000 characters." },
					scenario: { type: "string", description: "The realistic scenario where it breaks, capped at 1000 characters." },
					evidence: { type: "array", items: { ...EVIDENCE_ITEM }, description: "Code you actually read that supports the claim." },
					suggestedFix: { type: "string", description: "Concrete fix direction, capped at 1000 characters. Omit when unknown." },
				},
				required: ["priority", "confidence", "title", "file", "claim", "scenario", "evidence"],
			},
		},
		sideEffects: { type: "array", items: { type: "string", description: "One applicable bold Side Effects item, capped at 300 characters." } },
	},
	required: ["findings", "sideEffects"],
});

/** The per-lane outcome vocabularies. */
export const LANE_OUTCOMES = Object.freeze({
	reproducer: Object.freeze(["reproduced", "not-reproduced", "untestable"]),
	skeptic: Object.freeze(["reachable", "unreachable", "unclear"]),
	consistency: Object.freeze(["consistent", "inconsistent", "unclear"]),
	provenance: Object.freeze(["introduced", "pre-existing", "intentional", "unclear"]),
	impact: Object.freeze(["material", "negligible"]),
	"fix-auditor": Object.freeze(["sound", "flawed", "absent"]),
});

/** What one verifier lane returns for its chunk of reports. */
export function verifierSchema(laneId) {
	const outcome = LANE_OUTCOMES[laneId] ?? ["unclear"];
	const properties = {
		ref: { type: "string", description: "The report's `ref`, exactly as given." },
		outcome: { type: "string", enum: [...outcome], description: `This lane's verdict for the report: ${outcome.join(", ")}.` },
		notes: { type: "string", description: "What you found, capped at 1500 characters." },
		whatWouldChangeMyMind: { type: "string", description: "The evidence that would settle this stance, capped at 500 characters." },
		evidence: { type: "array", items: { ...EVIDENCE_ITEM }, description: "Code you actually read that supports the stance." },
	};
	if (laneId === "reproducer") {
		properties.method = { type: "string", enum: ["executed", "none"], description: "executed: you ran commands or tests that demonstrated or failed to demonstrate the failure." };
		properties.exercisedScenario = { type: "string", description: "What you exercised, capped at 500 characters." };
		properties.reproduction = { type: "string", description: "Commands run and what was observed, capped at 2000 characters." };
	}
	if (laneId === "impact") {
		properties.priority = { type: "string", enum: [...PRIORITY_ENUM], description: "Your own severity, judged from the report alone." };
		properties.blastRadius = { type: "string", enum: ["local", "module", "system", "user-data"], description: "How wide the damage is." };
	}
	if (laneId === "fix-auditor") {
		properties.fixVerdict = { type: "string", enum: ["sound", "flawed", "absent"], description: "sound: addresses the root cause; flawed: regressions or wrong pattern; absent: no fix proposed." };
		properties.problems = { type: "array", items: { type: "string", description: "One problem with the fix, capped at 500 characters." } };
		properties.revisedSuggestion = { type: "string", description: "A better fix, capped at 1000 characters, when flawed." };
	}
	const required = ["ref", "outcome", "notes", "evidence"];
	if (laneId === "reproducer") required.push("method");
	if (laneId === "impact") required.push("priority", "blastRadius");
	if (laneId === "fix-auditor") required.push("fixVerdict");
	return Object.freeze({
		type: "object",
		additionalProperties: false,
		properties: { results: { type: "array", items: { type: "object", additionalProperties: false, properties, required } } },
		required: ["results"],
	});
}
