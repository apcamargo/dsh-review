/**
 * DeepSeek Harness plugin: `/review` and `/end-review` code-review commands
 * over the human-command registry.
 *
 * Loaded through a profile patch layer:
 *
 *   - id: review
 *     name: "@apcamargo/dsh-review"
 *
 * @module @apcamargo/dsh-review
 */

import { registerCommands } from "./commands.js";
import { openReviewDomain } from "./state.js";

/** Cordis plugin name. */
const name = "review";

/** Required services: the command registry, process execution, and durable plugin state. */
const inject = ["commands", "subprocess", "storageDomain"];

/**
 * Open the review state domain and register the commands. Unloading cancels
 * the commands still running, waits for them to settle, and only then closes
 * the domain, so no command writes to a closed domain.
 * @param ctx - host context carrying the injected services.
 * @returns resolution after the domain is open and the commands registered.
 */
async function apply(ctx) {
	const domain = await openReviewDomain(ctx);
	ctx.effect(function* () {
		const lifetime = new AbortController();
		const inFlight = new Set();
		// Registered before the commands: Cordis starts disposers in reverse order,
		// so the commands unregister first and no new command starts while draining.
		yield async () => {
			lifetime.abort();
			await Promise.allSettled([...inFlight]);
			await domain.close();
		};
		// Nested effect: the framework tracks its disposers while this effect runs.
		registerCommands(ctx, domain, { signal: lifetime.signal, inFlight });
	}, "review lifecycle");
}

export { apply, inject, name };
