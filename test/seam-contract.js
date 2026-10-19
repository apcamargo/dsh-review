/**
 * Seam-contract canary: the deep fleet composes every worker on the harness
 * subagent seam (`ctx.subagents.startActivation`, fleet/agents.js) and its
 * capability preflight assumes the shape the bundled spawn provider publishes.
 * Those assumptions broke once already — the harness 0.2.1 release removed the
 * one-shot `start` seam and the `persona`/`toolFilter` capabilities while the
 * suite's fake provider still advertised them — so this suite mounts the REAL
 * `SubagentRuntime` and the REAL in-process spawn provider from the installed
 * harness packages and asserts the exact contract the fleet depends on: the
 * seam method names, the provider capability set, `inheritsParentContext`, and
 * the error ladder the fleet's fallbacks map to. It also asserts the live
 * activation-capacity read path the fleet's `--concurrency` cap depends on
 * (`SubagentRuntime.config`'s volatile `maxActiveSubagents` reference): a
 * TypeScript-private constructor property, so a harness rename would silently
 * disable the cap. A harness update that renames any of this fails here,
 * before a reviewer ever starts blank.
 *
 * @module @apcamargo/dsh-review/test/seam-contract
 */

import assert from "node:assert/strict";

/** Load the harness packages; absent ones skip the suite with a loud line. */
async function loadHarness() {
	const required = async (specifier) => {
		try {
			return await import(specifier);
		} catch (error) {
			if (error?.code === "ERR_MODULE_NOT_FOUND") return undefined;
			throw error;
		}
	};
	const [subagent, spawn] = await Promise.all([
		required("@deepseek-ai/dsh-subagent"),
		required("@deepseek-ai/dsh-subagent-spawn-in-process"),
	]);
	if (!subagent || !spawn) {
		console.log("seam contract: SKIPPED (harness packages not installed — run npm install)");
		process.exit(0);
	}
	return { subagent, spawn };
}

const { subagent, spawn } = await loadHarness();
const { Context } = await import("@deepseek-ai/cordis");
const { SubagentRuntime } = subagent;

// --- The seam the fleet calls ----------------------------------------------
// The first tripwire: 0.2.0-rc.2 shipped `start(name, request)` and no
// `startActivation`, so this assertion alone fails on the next seam rename.
assert.equal(typeof SubagentRuntime?.prototype?.startActivation, "function", "SubagentRuntime.prototype.startActivation is missing — the subagent seam changed");
assert.equal(typeof SubagentRuntime?.prototype?.getProvider, "function", "SubagentRuntime.prototype.getProvider is missing — the subagent seam changed");

// --- Mount the real service and the real default provider -------------------
// `workingDirectory` is the runtime's static inject (child cwd resolution);
// the canary never starts a child, so a stub satisfies the activation gate.
const ctx = new Context();
ctx.provide("workingDirectory", {});
await ctx.plugin(SubagentRuntime, { maxDepth: 2, maxActiveSubagents: 6 });
spawn.apply(ctx, { providerName: "spawn" });

// --- The live capacity read the fleet's --concurrency cap depends on ---------
// The fleet reads the harness's activation capacity off the service instance
// (`config.maxActiveSubagents.get()` — TypeScript-private, runtime-present).
// The mounted config below sets 6 — deliberately NOT the schema default 8 —
// so the reference must answer the CONFIGURED value: a ref that ignored the
// mount and answered the default would otherwise pass while the production
// cap read the wrong number. A rename of the `config` property, the field,
// or the volatile protocol disables the cap silently in production — fail
// here instead.
assert.equal(
	ctx.subagents?.config?.maxActiveSubagents?.get?.(),
	6,
	"SubagentRuntime no longer exposes a readable live maxActiveSubagents reference — fleet/index.js's readHarnessActivationCapacity cannot cap --concurrency",
);

// The fleet's preflight contract against the REAL default provider
// (`deep.reviewerProvider` default "spawn"): structured output must be
// advertised, children must not inherit the parent's context, and the
// capability NAMES are what agents.js reads with `?? {}` fallbacks — a rename
// here must fail loudly, not silently weaken the preflight.
const spawnProvider = ctx.subagents.getProvider("spawn");
assert.ok(spawnProvider, `the "spawn" provider is not registered by dsh-subagent-spawn-in-process`);
assert.deepEqual(
	{ ...spawnProvider.capabilities },
	{ agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
	`the spawn provider's capability set changed: ${JSON.stringify(spawnProvider.capabilities)} — re-check fleet/agents.js's preflight`,
);
assert.equal(spawnProvider.inheritsParentContext, false, "the spawn provider started inheriting the parent's context — verifier independence would break");

// --- The error ladder, with the plugin's exact spec shape -------------------
// The request shape mirrors runAgent's startActivation call field for field;
// every rung below throws before any resource is reserved (no manager, no
// agents service in this harness), so the assertions are side-effect free.
const parent = { id: "session-seam-canary-0001" };
const specFor = (provider, request = {}) => ({
	provider,
	label: "seam-canary",
	request: {
		prompt: [{ type: "text", text: "seam contract canary" }],
		parent,
		...request,
	},
	signal: undefined,
	delivery: "caller",
});

// Rung 1: unknown provider name → NO_PROVIDER (the fleet answers "provider is
// not available" from its own getProvider check; the seam agrees).
await assert.rejects(
	ctx.subagents.startActivation(specFor("missing-provider")),
	(error) => error.code === "NO_PROVIDER",
	"an unknown provider no longer answers NO_PROVIDER",
);

// Rung 2: a provider missing a capability the fleet requests →
// UNSUPPORTED_CAPABILITY naming the capability, raised before manager
// resolution. This is the harness-side twin of the fleet's own preflight.
ctx.subagents.registerProvider({
	name: "seam-canary-capped",
	capabilities: { agentOptions: true },
	inheritsParentContext: false,
	prepareContinuable: () => Promise.resolve({}),
});
await assert.rejects(
	ctx.subagents.startActivation(specFor("seam-canary-capped", { outputSchema: { type: "object", properties: {}, required: [] } })),
	(error) => error.code === "UNSUPPORTED_CAPABILITY" && error.message.includes("outputSchema"),
	"the seam no longer refuses a missing outputSchema capability before manager resolution",
);

// Rung 3 (terminal proof): the plugin's full spec shape — prompt content
// parts, parent, outputSchema, agentOptions, delivery "caller" — passes the
// REAL capability gate and reaches manager resolution. The agents service is
// deliberately absent, so CONTINUATION_UNAVAILABLE is the expected end of the
// ladder: anything else means the request fields no longer mean what the
// fleet sends.
await assert.rejects(
	ctx.subagents.startActivation(specFor("spawn", {
		outputSchema: {
			type: "object",
			properties: { findings: { type: "array" }, sideEffects: { type: "array" } },
			required: ["findings", "sideEffects"],
			additionalProperties: false,
		},
		agentOptions: { model: "seam-canary-model" },
	})),
	(error) => error.code === "CONTINUATION_UNAVAILABLE",
	"the fleet's exact startActivation spec no longer passes the seam's capability validation — a request field or capability was renamed",
);

console.log("seam contract: all assertions passed");
