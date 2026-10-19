/**
 * Plugin configuration. Everything lives under `deep`: regular reviews have no
 * options, and `apply(ctx)` without a config behaves exactly as it always did.
 *
 * @module @apcamargo/dsh-review/config
 */

import Schema from "@deepseek-ai/schemastery";
import { CROSS_LENSES, LOCAL_LENSES } from "./fleet/roster.js";

/** Node clamps every timer above 2^31-1 ms to 1 ms, so a larger deadline would fire at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Reviewer lenses a deep review may run. `performance` is opt-in; `simplification`
 * is on by default (its findings verify under the simplifier lane). */
export const LENS_IDS = Object.freeze(["correctness", "failure-paths", "security", "contracts", "consistency", "propagation", "simplification", "performance"]);
/** Verifier lanes. The reproducer and the skeptic gate every defect finding and
 * cannot be disabled; the simplifier gates simplification findings and cannot be
 * disabled either. */
export const LANE_IDS = Object.freeze(["reproducer", "skeptic", "consistency", "provenance", "impact", "fix-auditor", "simplifier"]);
export const MANDATORY_LANES = Object.freeze(["reproducer", "skeptic", "simplifier"]);

/**
 * In-flight bound for executing (reproducer) verify lanes INSIDE the shared
 * verify pool (`deep.concurrency` bounds the pool itself). Not configurable:
 * reproducers run the project's tests in the shared working tree, and more
 * than this many concurrent test runs collide with each other (ports, caches,
 * installs) — the bound the old standalone executing pool carried, kept as a
 * scheduling sub-cap now that the verify phase shares one pool with the scan.
 */
export const EXECUTING_CONCURRENCY_CAP = 2;

/** Defaults, also used when the plugin is applied without a config. */
export const DEFAULTS = Object.freeze({
	reviewerProvider: "spawn",
	reviewerAgentOptions: Object.freeze({}),
	verifierAgentOptions: Object.freeze({}),
	lenses: Object.freeze(["correctness", "failure-paths", "security", "contracts", "consistency", "propagation", "simplification"]),
	reviewerTools: Object.freeze(["bash", "read", "grep", "glob"]),
	// 15 is the smallest cap that keeps three shards per file-local lens once the
	// simplification lens joins them (floor((15 - 3) / 4) = 3): the defect lenses
	// keep their pre-simplification review depth on large diffs, at the cost of
	// three more reviewer runs there.
	maxReviewers: 15,
	shardThresholdLines: 1500,
	concurrency: 3,
	reviewerTimeoutMs: 1_200_000,
	verifierTimeoutMs: 600_000,
	callBudgetMs: 2_400_000,
	maxFindingsPerReviewer: 15,
	maxVerifications: 30,
	maxVerifierRuns: 40,
	minReviewerSuccess: 0.5,
	verifierRetries: 1,
	reviewerRetries: 1,
	lanes: Object.freeze({}),
	maxSteeringEntries: 8,
	maxSteeringChars: 1500,
});

const agentOptions = (description) =>
	Schema.object({
		provider: Schema.string().description("LLM provider route."),
		model: Schema.string().description("Model id interpreted by that provider."),
		reasoningEffort: Schema.string().description("Adapter-owned reasoning effort."),
		maxTokens: Schema.natural().min(1).description("Output-token cap per request."),
	}).description(description);

const laneConfig = Schema.object({
	enabled: Schema.boolean().description("Run this lane. The reproducer, the skeptic and the simplifier cannot be disabled."),
	chunkSize: Schema.natural().min(1).description("Findings per verifier run for this lane."),
	agentOptions: agentOptions("Agent options for this lane, over verifierAgentOptions."),
});

export const Config = Schema.object({
	deep: Schema.object({
		reviewerProvider: Schema.string().default(DEFAULTS.reviewerProvider).description("The ctx.subagents provider the fleet runs on. It must support structured output and must start children without the parent's context. Personas and tool containment need no provider support: the fleet prefixes the static persona to the worker's prompt and restricts the child's tools on its own scope."),
		reviewerAgentOptions: agentOptions("Agent options for the reviewers, over the orchestrator's.").default({}),
		verifierAgentOptions: agentOptions("Agent options for every verifier lane, over the orchestrator's. A model unlike the reviewers' makes the verification more independent.").default({}),
		lenses: Schema.array(Schema.string()).default([...DEFAULTS.lenses]).description(`Reviewer lenses to run: ${LENS_IDS.join(", ")}.`),
		reviewerTools: Schema.array(Schema.string()).default([...DEFAULTS.reviewerTools]).description("Tools the workers may use. They are checked against the orchestrator's tools, and a missing one fails the call."),
		maxReviewers: Schema.natural().min(1).default(DEFAULTS.maxReviewers).description("Reviewer runs in one scan. The default 15 keeps three shards per file-local lens (the four default local lenses plus three cross-cutting lenses fill the cap exactly on large diffs), so the defect lenses keep their pre-simplification review depth."),
		shardThresholdLines: Schema.natural().min(1).default(DEFAULTS.shardThresholdLines).description("Changed lines above which the file-local lenses split the change into shards."),
		concurrency: Schema.natural().min(1).default(DEFAULTS.concurrency).description("Fleet workers running at once — the scan's reviewers and the verify phase's verifier lanes share this one pool size, so both steps hold the same number of simultaneous agents. Inside the verify pool, at most " + EXECUTING_CONCURRENCY_CAP + " reproducer lanes run concurrently (they run tests in the shared working tree)."),
		reviewerTimeoutMs: Schema.natural().min(1000).max(MAX_TIMER_MS).default(DEFAULTS.reviewerTimeoutMs).description(`Time limit for one reviewer run. Clamped to ${MAX_TIMER_MS} ms (Node timer overflow fires at 1 ms above it). The per-run --timeout flag overrides this for one review.`),
		verifierTimeoutMs: Schema.natural().min(1000).max(MAX_TIMER_MS).default(DEFAULTS.verifierTimeoutMs).description(`Time limit for one verifier run. Clamped to ${MAX_TIMER_MS} ms (Node timer overflow fires at 1 ms above it). The per-run --timeout flag overrides this for one review.`),
		callBudgetMs: Schema.natural().min(1000).max(MAX_TIMER_MS).default(DEFAULTS.callBudgetMs).description(`Wall-clock budget of one deep_review_scan or deep_review_verify call. When it is spent the call starts no new workers and returns what is pending. When unset, it scales to at least (1 + retries) x the worker timeouts so a timed-out worker's in-call retry fits; an explicitly-configured budget stays a cap. Clamped to ${MAX_TIMER_MS} ms (Node timer overflow fires at 1 ms above it).`),
		maxFindingsPerReviewer: Schema.natural().min(1).default(DEFAULTS.maxFindingsPerReviewer).description("Findings kept from one reviewer."),
		maxVerifications: Schema.natural().min(1).default(DEFAULTS.maxVerifications).description("Consolidated findings one verify call accepts."),
		maxVerifierRuns: Schema.natural().min(1).default(DEFAULTS.maxVerifierRuns).description("Verifier runs in one verification."),
		minReviewerSuccess: Schema.number().min(0).max(1).default(DEFAULTS.minReviewerSuccess).description("Fraction of reviewers that must succeed for the scan to count: below it verification stays blocked; above it a degraded scan counts, with failed reviewers' scopes uncovered (reported in the coverage)."),
		verifierRetries: Schema.natural().default(DEFAULTS.verifierRetries).description("Retries of a failed verifier run."),
		reviewerRetries: Schema.natural().default(DEFAULTS.reviewerRetries).description("Retries of a failed reviewer run: one worker whose only LLM attempt dies mid-stream (a connection reset) is re-spawned once before its entry is declared failed."),
		lanes: Schema.dict(laneConfig).default({}).description(`Per-lane settings, keyed by lane: ${LANE_IDS.join(", ")}.`),
		maxSteeringEntries: Schema.natural().min(1).default(DEFAULTS.maxSteeringEntries).description("User messages kept as steering for the workers. The first one is always kept."),
		maxSteeringChars: Schema.natural().min(1).default(DEFAULTS.maxSteeringChars).description("Characters kept of one steering message."),
	}).default({}),
});

/** The four agent option keys the runtime spreads into the subagent start. */
const AGENT_OPTION_KEYS = Object.freeze(["provider", "model", "reasoningEffort", "maxTokens"]);

/**
 * Re-check one agent options object's shape: only the four known keys, strings
 * for the routes, a positive integer for maxTokens. Undefined values are unset
 * (the runtime's merge filters them); every other malformed value would reach
 * the subagent start request as silent garbage.
 * @throws when the value is not an object, names an unknown key, or carries a
 *   malformed option.
 */
function validateAgentOptionsShape(value, field) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`review: ${field} must be an object (got ${JSON.stringify(value)})`);
	for (const [key, option] of Object.entries(value)) {
		if (!AGENT_OPTION_KEYS.includes(key)) throw new Error(`review: ${field} has unknown key "${key}"; expected one of ${AGENT_OPTION_KEYS.join(", ")}`);
		if (key === "maxTokens") {
			if (option !== undefined && (typeof option !== "number" || !Number.isInteger(option) || option < 1)) throw new Error(`review: ${field}.maxTokens must be an integer >= 1 (got ${JSON.stringify(option)})`);
		} else if (option !== undefined && typeof option !== "string") throw new Error(`review: ${field}.${key} must be a string (got ${JSON.stringify(option)})`);
	}
}

/**
 * Recursively freeze a plain value, children first, then the value itself, so
 * a frozen settings object carries no unfrozen interior. Arrays freeze too.
 */
function deepFreeze(value) {
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value)) deepFreeze(value[key]);
		Object.freeze(value);
	}
	return value;
}

/**
 * Merge a raw `deep` config over the defaults and validate everything the
 * schema cannot (or that must hold even when the schema is not wired): the
 * numeric cost caps (a `maxReviewers: 0` would otherwise yield a silent empty
 * scan, `maxSteeringEntries: 0` would pop the pinned first steering entry),
 * the array-ness of lenses/tools, lens and lane names, the lanes that must
 * stay on, the lane entry shapes (a non-object lane value and a non-boolean
 * `enabled` would pass validation and be silently enabled at runtime — a user
 * disabling the mandatory lane gets it run), the lane chunk sizes (a
 * negative/zero/fractional value would hang
 * the verify planning's chunk loop in an infinite synchronous loop, and a
 * non-number would silently collapse to an empty chunk — the lane never
 * assessing any group), and the agent options shapes (a malformed shape would
 * reach the subagent start as silent garbage), plus the lanes container (a
 * null container throws a raw TypeError from the entries loop, and a number or
 * empty array makes the entries loop no-op so every lane configuration is
 * silently ignored) and the provider name (a non-string or empty name flows to
 * getProvider, whose undefined answer would surface as a misleading scan
 * quorum error instead of a config error — the wired schema cannot catch an
 * empty string either).
 * @param raw - the `deep` section of the plugin config, or nothing.
 * @returns the complete, validated settings, deep-frozen over a clone of the
 *   merge — so the returned object is the sole owner of its frozen state and
 *   freezing it never side-effects the caller's raw config.
 * @throws when a field is malformed, a cap is below its floor, a lens or lane
 *   is unknown, a duplicate lens is named, a mandatory lane is disabled, the
 *   lanes container or the provider name is malformed, or an agent options
 *   shape is malformed.
 */
export function resolveDeepConfig(raw) {
	const defined = Object.fromEntries(Object.entries(raw ?? {}).filter(([, value]) => value !== undefined));
	const merged = { ...DEFAULTS, ...defined };
	for (const [field, floor] of [
		["maxReviewers", 1],
		["shardThresholdLines", 1],
		["concurrency", 1],
		["maxFindingsPerReviewer", 1],
		["maxVerifications", 1],
		["maxVerifierRuns", 1],
		["verifierRetries", 0],
		["reviewerRetries", 0],
		["maxSteeringEntries", 1],
		["maxSteeringChars", 1],
		// The three timer fields: a negative/zero/fractional value would throw
		// RangeError from AbortSignal.timeout at every deep tool call, or abort
		// within ~1 ms — an abort the scan can never recover from.
		["reviewerTimeoutMs", 1000],
		["verifierTimeoutMs", 1000],
		["callBudgetMs", 1000],
	]) {
		if (typeof merged[field] !== "number" || !Number.isInteger(merged[field]) || merged[field] < floor) {
			throw new Error(`review: deep.${field} must be an integer >= ${floor} (got ${JSON.stringify(merged[field])})`);
		}
	}
	if (typeof merged.minReviewerSuccess !== "number" || !Number.isFinite(merged.minReviewerSuccess) || merged.minReviewerSuccess < 0 || merged.minReviewerSuccess > 1) {
		throw new Error(`review: deep.minReviewerSuccess must be a number between 0 and 1 (got ${JSON.stringify(merged.minReviewerSuccess)})`);
	}
	// The provider name flows to ctx.subagents.getProvider, whose undefined
	// answer would fail every worker and surface as a misleading scan quorum
	// error ("retry them" can never succeed for a config error). Schema.string()
	// validates an empty name even when the schema is wired, so the non-empty
	// check closes a class the schema cannot.
	if (typeof merged.reviewerProvider !== "string" || merged.reviewerProvider === "") {
		throw new Error(`review: deep.reviewerProvider must be a non-empty string (got ${JSON.stringify(merged.reviewerProvider)})`);
	}
	for (const field of ["lenses", "reviewerTools"]) {
		if (!Array.isArray(merged[field])) throw new Error(`review: deep.${field} must be an array (got ${JSON.stringify(merged[field])})`);
		for (const element of merged[field]) {
			if (typeof element !== "string") throw new Error(`review: deep.${field} must be an array of strings (got ${JSON.stringify(element)})`);
		}
	}
	for (const lens of merged.lenses) {
		if (!LENS_IDS.includes(lens)) throw new Error(`review: unknown lens "${lens}"; expected one of ${LENS_IDS.join(", ")}`);
		// planRoster silently drops a lens that is in neither lens class (its
		// roster filter matches nothing), so a valid-but-unclassifiable lens name
		// would disable that lens for every review while the coverage line
		// misreports it as "cut by the reviewer cap". Fail loud here instead.
		if (!LOCAL_LENSES.includes(lens) && !CROSS_LENSES.includes(lens)) throw new Error(`review: lens "${lens}" has no roster class (file-local or cross-cutting); it would never run`);
	}
	// A duplicated lens would run the lens's reviewers twice (planRoster
	// duplicates the entries): wasted cost, duplicate findings — rejected, not
	// silently deduped, matching the fail-loud-on-silent-garbage convention.
	if (new Set(merged.lenses).size !== merged.lenses.length) throw new Error("review: deep.lenses names a duplicate lens; remove the duplicate");
	if (merged.lenses.length === 0) throw new Error("review: deep.lenses must name at least one lens");
	if (merged.reviewerTools.length === 0) throw new Error("review: deep.reviewerTools must name at least one tool");
	// A null container throws a raw TypeError from the entries loop, and a
	// number or empty array makes the loop no-op so every lane configuration
	// (a user's chunk sizes, disabled advisory lanes) is silently ignored.
	if (typeof merged.lanes !== "object" || merged.lanes === null || Array.isArray(merged.lanes)) {
		throw new Error(`review: deep.lanes must be an object (got ${JSON.stringify(merged.lanes)})`);
	}
	for (const [lane, settings] of Object.entries(merged.lanes)) {
		if (!LANE_IDS.includes(lane)) throw new Error(`review: unknown lane "${lane}"; expected one of ${LANE_IDS.join(", ")}`);
		// A non-object lane value (reproducer: "off") and a non-boolean enabled
		// (reproducer: { enabled: "no" }) would pass validation and be silently
		// ENABLED at runtime (applicableLanes reads enabled !== false): a user
		// disabling the mandatory lane gets it run. Null is a malformed value in
		// the same dangerous direction (there is no null-unset convention for
		// enabled, unlike chunkSize's `??`). Rejected, not silently ignored,
		// matching the fail-loud-on-silent-garbage convention.
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error(`review: deep.lanes.${lane} must be an object (got ${JSON.stringify(settings)})`);
		if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error(`review: deep.lanes.${lane}.enabled must be a boolean (got ${JSON.stringify(settings.enabled)})`);
		// A negative/zero/fractional chunkSize would hang planLaneRuns's chunk
		// loop forever (no abort signal can interrupt sync planning), and a
		// non-number would silently collapse to one empty chunk — the lane never
		// assessing any group. Null/undefined are unset, exactly as the runtime's
		// `?? lane.chunkSize` treats them.
		if (settings.chunkSize != null && (typeof settings.chunkSize !== "number" || !Number.isInteger(settings.chunkSize) || settings.chunkSize < 1)) throw new Error(`review: deep.lanes.${lane}.chunkSize must be an integer >= 1 (got ${JSON.stringify(settings.chunkSize)})`);
		// The runtime merges these over verifierAgentOptions and starts the
		// provider with the result, so a malformed shape cannot ride to the start.
		if (settings.agentOptions != null) validateAgentOptionsShape(settings.agentOptions, `deep.lanes.${lane}.agentOptions`);
		if (MANDATORY_LANES.includes(lane) && settings.enabled === false) throw new Error(`review: the ${lane} lane cannot be disabled`);
	}
	validateAgentOptionsShape(merged.reviewerAgentOptions, "deep.reviewerAgentOptions");
	validateAgentOptionsShape(merged.verifierAgentOptions, "deep.verifierAgentOptions");
	for (const key of ["reviewerTimeoutMs", "verifierTimeoutMs", "callBudgetMs"]) merged[key] = Math.min(merged[key], MAX_TIMER_MS);
	// The derived budget floor: with the default timeout (1200 s) equal to the
	// old default budget, a full-timeout worker's in-call retry was dead by
	// construction — the retry starts after the timeout and is aborted at once
	// by the budget, and wave-2+ workers are budget-cut before their own
	// timeout even fires. When the budget is NOT explicitly configured, it
	// scales to at least (1 + retries) × each worker limit (attempt 1 + the
	// in-call retry, max over both kinds — one budget serves both calls). An
	// explicitly-configured budget stays a cap: silently raising a user's
	// explicit cost cap would violate it (recoverable by a re-call with a fresh
	// budget). Derived AFTER the timer clamps, and clamped itself — the floor
	// above MAX_TIMER_MS would re-create the overflow it guards against.
	{
		const budgetFloor = Math.max(
			(1 + merged.reviewerRetries) * merged.reviewerTimeoutMs,
			(1 + merged.verifierRetries) * merged.verifierTimeoutMs,
		);
		if (defined.callBudgetMs === undefined) {
			merged.callBudgetMs = Math.min(MAX_TIMER_MS, Math.max(merged.callBudgetMs, budgetFloor));
		}
	}
	// Clone before freezing: freezing `merged` directly would freeze the raw
	// config's own lanes/agentOptions interiors too, side-effecting the caller's
	// config object. The clone carries fresh interiors, so the returned settings
	// are the single owner of their frozen state.
	return deepFreeze(structuredClone(merged));
}
