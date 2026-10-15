/**
 * Shared harness mocks for the `@apcamargo/dsh-review` tests.
 *
 * @module test/fixtures/cordis-mock
 */

/**
 * Cordis child-fiber mock: `ctx.inject` exists so the review plugin's fleet
 * child fiber can mount in harnesses that never provide the fleet services —
 * the mock only returns a settle-at-once fiber, and these harnesses never
 * await it (the fleet services are absent, so a deep start answers the
 * missing-services error).
 * @param ctx - the harness-shaped host context.
 */
export function injectable(ctx) {
	ctx.inject = (deps, callback) => ({ async await() { await callback?.(ctx); } });
	return ctx;
}
