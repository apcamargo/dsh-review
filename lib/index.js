/**
 * DeepSeek Harness plugin: `/review` and `/end-review` code-review commands
 * over the human-command registry.
 *
 * Loaded through a profile patch layer:
 *
 *   - id: review
 *     name: "@apcamargo/dsh-review"
 *
 * The deep-review fleet (`--deep`) needs the `tools` and `subagents` services;
 * it is mounted by a `ctx.inject` child fiber, so it exists only while those
 * services do and regular reviews never depend on them.
 *
 * @module @apcamargo/dsh-review
 */

import { registerCommands } from "./commands.js";
import { openReviewDomain } from "./state.js";
import { Config } from "./config.js";

/** Cordis plugin name. */
const name = "review";

/** Required services: the command registry, process execution, and durable plugin state. */
const inject = ["commands", "subprocess", "storageDomain"];

/**
 * Open the review state domain and register the commands. Unloading cancels
 * the commands still running, waits for them to settle, and only then closes
 * the domain, so no command writes to a closed domain. The fleet fiber's own
 * teardown aborts the deep runs as soon as the child fiber unloads (the aborts
 * are its first statements, so they reach the runs within a microtask); the
 * drain and the scope disposal may interleave with the domain close, because
 * cordis disposes a fiber's top-level disposables in parallel — safe, since
 * the deep tools never write the storage domain. `Config` is exported for the
 * harness: cordis validates the plugin config against it at start (the
 * dsh-storage-domain convention).
 * @param ctx - host context carrying the injected services.
 * @param config - plugin config; only `deep` is read.
 * @returns resolution after the domain is open and the commands registered.
 */
async function apply(ctx, config = {}) {
	const domain = await openReviewDomain(ctx);
	const runs = new Map();
	ctx.effect(function* () {
		const lifetime = new AbortController();
		const inFlight = new Set();
		let fleet;
		// Registered before the commands: Cordis calls top-level disposers in
		// reverse-registration order and disposes them in parallel — the command
		// unregister disposer is sync, so the commands unregister before any
		// drain and no new command starts while draining.
		yield async () => {
			lifetime.abort();
			await Promise.allSettled([...inFlight]);
			await domain.close();
		};
		// The fleet capability exists only while the tools and subagents services
		// do; its own teardown aborts the deep runs and disposes their scopes.
		ctx.inject(["tools", "subagents"], async (fleetCtx) => {
			const { createFleet } = await import("./fleet/index.js");
			const local = await createFleet(fleetCtx, { config, inFlight, runs });
			fleet = local;
			fleetCtx.effect(() => () => {
				if (fleet === local) fleet = undefined;
			}, "review fleet lifetime");
		});
		// Nested effect: the framework tracks the yielded command disposers under
		// this effect (ctx.inject below is a fleet-fiber top-level child,
		// disposed by the fleet fiber's own unload).
		registerCommands(ctx, domain, { signal: lifetime.signal, inFlight, fleet: () => fleet });
	}, "review lifecycle");
}

export { apply, inject, name, Config };
