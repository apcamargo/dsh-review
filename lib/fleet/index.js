/**
 * The deep-review fleet: lifecycle, the per-agent scope that carries the two
 * tools, the run store, and the gate listeners.
 *
 * The fleet capability exists only while the `tools` and `subagents` services
 * do: it is mounted by a `ctx.inject` child fiber in the plugin entry, and its
 * teardown (abort the run controllers, drain the in-flight tools, dispose the
 * scopes) is one `ctx.effect`. The aborts are the teardown's first statements,
 * so the deep runs are aborted as soon as the child fiber unloads; the drain
 * and the scope disposal may interleave with the plugin's own drain and
 * domain.close, because cordis disposes a fiber's top-level disposables in
 * parallel (the child fiber's disposal is a plugin-fiber top-level disposable,
 * not a nested one) — safe, since the deep tools never write the storage
 * domain. The drain-then-close discipline for commands lives inside the
 * plugin's outer disposer, where the steps are serially awaited.
 *
 * @module @apcamargo/dsh-review/fleet
 */

import { resolveDeepConfig, DEFAULTS } from "../config.js";
import { registerDeepTools } from "./tools.js";
import { createLedger } from "./steering.js";
import { registerGate } from "./gate.js";

/**
 * Read the harness's live activation capacity (`maxActiveSubagents` on the
 * `subagents` service config, default 8) — the bound on live children per
 * activation tree, i.e. the maximum fleet workers that can run at once. The
 * field is TypeScript-private on `SubagentRuntime` but a runtime constructor
 * property holding schemastery volatile references (`get()` answers the
 * current value, which the user may have raised or lowered in the harness
 * settings); the read is defensive, so any shape change answers undefined and
 * the fleet skips capping rather than falling back to a hardcoded maximum —
 * workers past the real capacity then fail with the seam's own
 * `subagent limit reached` and are listed per the existing failure contract.
 * @param subagents - the injected `subagents` service, or nothing.
 * @returns the current capacity, or undefined when it cannot be read.
 */
function readHarnessActivationCapacity(subagents) {
	try {
		const ref = subagents?.config?.maxActiveSubagents;
		const value = typeof ref?.get === "function" ? ref.get() : undefined;
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Create the fleet.
 * @param ctx - the fleet fiber's context (carries `tools` and `subagents`).
 * @param deps - `{ config, inFlight }`: the plugin config, and the shared
 *   in-flight set unload drains.
 * @returns `{ begin, end, runs }`.
 */
export async function createFleet(ctx, deps) {
	const { createScope } = await import("@deepseek-ai/dsh-scope");
	const runs = deps.runs;

	// One teardown for everything the fleet mints. Cordis calls top-level
	// disposers in reverse-registration order and disposes them in PARALLEL —
	// a child fiber from ctx.inject is a parent-fiber top-level disposable
	// disposed by the fleet fiber's own unload too, so this explicit dispose is
	// call-once belt-and-braces (dsh-scope memoizes scope.dispose; the
	// tools.register undo is idempotent). The generator form: the body runs at
	// registration; the yielded disposer at teardown.
	const scopes = new Set();
	ctx.effect(function* () {
		yield async () => {
			for (const run of runs.values()) {
				run.controller.abort();
				// The aborts are the disposer's first statements, so a disposer body
				// edit that adds an await above them still cannot leave a run live.
				// Child-first: each run's scoped tools unregister before its scope dies.
				for (const disposer of [...(run.toolDisposers ?? [])].reverse()) {
					try {
						await disposer();
					} catch { /* disposal failure is a warning */ }
				}
			}
			await Promise.allSettled([...deps.inFlight]);
			for (const scope of scopes) {
				try {
					await scope.dispose();
				} catch { /* teardown failure is a warning */ }
			}
			scopes.clear();
			runs.clear();
		};
	}, "review fleet teardown");

	registerGate(ctx, runs, (agentId) => end(agentId));

	/**
	 * Begin one agent's deep run: resolve the settings, create the per-agent
	 * scope, and register the two tools in it. Only this session sees them.
	 * First-come-wins: a concurrent `/review --deep` for the same session
	 * errors here instead of overwriting the live run (which would orphan its
	 * scope and tool definitions until plugin unload).
	 */
	async function begin(agent, { target, modePrompt, targetLabel, aggressive, promptOptions, timeoutMs, concurrency }) {
		// The per-run `--timeout` override merges here, where the settings resolve
		// once for the run: both worker limits take the flag's value, and the
		// call budget scales to at least (1 + retries) × each limit — an explicit
		// per-run request, so it applies even over an explicitly-configured
		// budget (the start message names the effective values, never silent).
		// resolveDeepConfig's own floors and clamps stay the backstop; a live
		// review's settings are deep-frozen, so the flag never changes a run
		// that already began.
		let raw = deps.config?.deep;
		if (timeoutMs !== undefined) {
			raw = { ...raw, reviewerTimeoutMs: timeoutMs, verifierTimeoutMs: timeoutMs };
			const budgetFloor = Math.max(
				(1 + (raw.reviewerRetries ?? DEFAULTS.reviewerRetries)) * timeoutMs,
				(1 + (raw.verifierRetries ?? DEFAULTS.verifierRetries)) * timeoutMs,
			);
			raw.callBudgetMs = Math.max(raw.callBudgetMs ?? DEFAULTS.callBudgetMs, budgetFloor);
		}
		// The per-run `--concurrency` override merges the same way: the pool size
		// for both fleet phases, over the configured `deep.concurrency`, for this
		// run only. (Cloned before mutation — `raw` may alias the config.)
		if (concurrency !== undefined) raw = { ...raw, concurrency };
		// The harness cap, read live from the harness at every begin (the value
		// is volatile: the user may change it between reviews). Applied to the
		// effective pool size from either source — a value past the activation
		// capacity makes workers fail with `subagent limit reached`, so it is
		// capped here and named in the start message (`startNotice`), never
		// silently. An unreadable capacity skips the cap: no hardcoded fallback.
		const capacity = readHarnessActivationCapacity(ctx.subagents);
		let startNotice;
		if (capacity !== undefined) {
			const requested = raw.concurrency ?? DEFAULTS.concurrency;
			if (requested > capacity) {
				raw = { ...raw, concurrency: capacity };
				startNotice = `Requested fleet concurrency ${requested} (${concurrency !== undefined ? "--concurrency" : "deep.concurrency"}) exceeds the harness's active-subagent limit (${capacity}); the fleet runs at most ${capacity} workers at once.`;
			}
		}
		const settings = resolveDeepConfig(raw);
		if (runs.has(agent.id)) throw new Error("A deep review is already running in this session. Finish it with /end-review first.");
		const run = {
			id: agent.id,
			agent,
			target,
			modePrompt,
			targetLabel,
			aggressive: aggressive === true,
			promptOptions: promptOptions ?? {},
			settings,
			// Set when the begin-time harness cap reduced the requested fleet
			// concurrency; the start message renders it (never silent).
			startNotice,
			cwd: agent?.session?.header?.cwd ?? process.cwd(),
			seed: agent.id,
			controller: new AbortController(),
			scan: { state: "none" },
			verify: { state: "none" },
			rawFindings: new Map(),
			sideEffects: [],
			laneResults: new Map(),
			ledger: createLedger(settings),
			incomplete: undefined,
			steerCount: 0,
			pausedTurns: new Set(),
			fidelityChecked: false,
			toolWork: new Set(),
		};
		const scope = createScope(ctx, agent);
		// Track tools for this run and for the shared unload drain. The per-run set
		// is what end() waits for: the shared set contains the calling /end-review
		// handler itself, so awaiting it would deadlock.
		const trackTool = (operation) => {
			deps.inFlight.add(operation);
			run.toolWork.add(operation);
			const forget = () => {
				deps.inFlight.delete(operation);
				run.toolWork.delete(operation);
			};
			operation.then(forget, forget);
			return operation;
		};
		// A mid-begin throw (a tools.register rejection) would otherwise leave the
		// scope in neither scopes nor runs: the poisoned deep_review_scan entry
		// stays in the shared tools layer and every retry /review --deep for the
		// session throws the duplicate diagnostic until plugin restart. Disposing
		// the scope runs its register undos (idempotent, call-once), then the
		// error propagates — the same cleanup-then-rethrow discipline the deep
		// start's durable-write rollback keeps (createScope stays outside the
		// try: its only throw — a begin-during-unload race — leaves nothing to
		// dispose).
		try {
			run.toolDisposers = registerDeepTools(scope.ctx, { ctx, runs, settings, logger: ctx.logger }, { track: trackTool });
			run.scope = scope;
		} catch (error) {
			try { await scope.dispose(); } catch { /* disposal failure is a warning */ }
			throw error;
		}
		scopes.add(scope);
		runs.set(agent.id, run);
		return run;
	}

	/**
	 * End one agent's deep run: abort the run controller, wait for its in-flight
	 * tools, and dispose the tools and the scope child-first.
	 */
	async function end(agentId) {
		const run = runs.get(agentId);
		if (!run) return;
		runs.delete(agentId);
		run.controller.abort();
		await Promise.allSettled([...run.toolWork]);
		scopes.delete(run.scope);
		const disposers = run.toolDisposers ?? [];
		for (const disposer of [...disposers].reverse()) { try { await disposer(); } catch { /* disposal failures of a scope tool are warnings */ } }
		try { await run.scope?.dispose(); } catch { /* teardown failure is a warning */ }
	}

	return { begin, end, runs };
}
