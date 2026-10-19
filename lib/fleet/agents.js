/**
 * Fleet runtime: one runAgent for every reviewer and verifier, the grouped
 * bounded pool, and the best-effort worker guard.
 *
 * This is the only file that touches `ctx.subagents`, so a harness API
 * migration of the one-shot seam stays local to it.
 *
 * @module @apcamargo/dsh-review/fleet/agents
 */

/** Subprocess binaries a static (read-only) lane may run under `bash`. */
const STATIC_BASH_BINARIES = new Set(["ls", "cat", "head", "tail", "wc", "file", "find", "grep", "rg", "diff", "sort", "uniq", "which", "pwd", "echo", "md5", "shasum", "sha256sum", "git"]);
/** `git` subcommands that only read. */
const READ_GIT_SUBCOMMANDS = new Set(["show", "log", "diff", "blame", "ls-files", "rev-parse", "grep", "status", "branch", "merge-base", "cat-file", "describe"]);

/** Whether a `bash` command pipes into a shell whose content is never inspected. */
function pipedShell(command) {
	return /(^|[\s;&|])(sh|bash|zsh|dash|ksh)(\s|$|[^a-z-])/.test(command);
}

/**
 * Whether a whitelisted read `git` subcommand carries a write option. Real-git
 * verified (2.54): `--output=<file>` writes a file for show/log/diff/blame (no
 * short `-o` exists for them; `--output-indicator-*` is text-only), and branch's
 * -d/-D/-m/-M/-c/-C/-f/-t/-u delete, move, copy, force, or reconfigure refs —
 * the same ref-write class the subcommand deny list covers for
 * checkout/reset/stash/rebase. Bare `git branch <name> [<sha>]` creation writes
 * refs too and stays allowed: recoverable, unlike the delete/force/move class.
 */
function gitWriteArgs(command) {
	if (/(^|\s)git\s+branch(\s|$)/.test(command) && /(^|\s)(-[A-Za-z]*[dDmMcCftu]\b|--delete|--move|--copy|--force|--track|--set-upstream-to(=|\s)|--unset-upstream|--edit-description)\b/.test(command)) return true;
	return /(^|\s)git\s+(show|log|diff|blame)(\s|$)/.test(command) && /(^|\s)--output(=|\s|$)/.test(command);
}

/** Whether a `bash` command uses find's or sort's write/execute options. */
function writeOptions(command) {
	// find: -delete writes; -exec/-execdir/-ok/-okdir run arbitrary binaries; -fprint/-fprintf/-fls write files.
	// The hyphen is matched outside the group (a hyphen-leading NON-FIRST group
	// member does not match under this Node's V8 — verified in isolation).
	if (/\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(command)) return true;
	// sort: -o/--output write a file.
	return /(^|[\s;&|])sort(\s|$)/.test(command) && /(^|\s)(-[A-Za-z]*o|--output)\b/.test(command);
}

/** Whether a `bash` command mutates the working tree or reaches the network. */
function mutatingBash(command) {
	// The quoted-word boundary ('/" in the leading class) keeps quoted denied
	// words ('rm, "rm) from evading the check. The `>/` alternative closes the
	// no-space redirect to an absolute path (`git show HEAD >/abs/f` writes the
	// working tree; the space form already matched via `\s*` backtracking), so
	// the no-space form agrees with the shipped space-form denial.
	return /(^|[\s;&|'"])(sudo|rm|mv|chmod|chown|mkfs|dd|tee|npm(\s+(i|install|ci|update|uninstall)|\s+run\s+test)?|pnpm|yarn|pip3?(\s+install)?|brew\s+install|apt|apt-get|curl|wget|nc|ssh|scp|git\s+(checkout|reset|clean|stash|apply|commit|restore|merge|rebase|cherry-pick|push|pull|fetch|am))(\s|$|[^a-z-])/.test(command)
		|| /(^|[\s;&|])>\s*[^/|&]|(^|[\s;&|])>>|(^|[\s;&|])>\/\S/.test(command)
		|| pipedShell(command)
		|| writeOptions(command)
		|| gitWriteArgs(command);
}

/** Whether a `bash` command mutates the tree (executing lanes may create temp files). */
function mutatingExecBash(command) {
	// Package managers are denied only for their install-class subcommands: the
	// trailing boundary must not swallow the whole `npm|pnpm|yarn <word>` class —
	// that would deny the bare test runners the reproducer lane's persona tells
	// it to run (npm test, pnpm test, yarn test). The redirect check agrees with
	// the static profile: a `>`/`>>` to any target is an obvious mutation the
	// executing invariant ("must not obviously mutate the working tree") names,
	// and the space form was already denied there via `\s*` backtracking.
	return /(^|[\s;&|'"])(sudo|rm|mv|chmod|chown|dd|tee|npm\s+(i|install|ci|update|uninstall)|pnpm\s+(i|install|ci|update|uninstall|add|remove)|yarn\s+(add|remove|install)|pip3?\s+install|brew\s+install|apt|apt-get|curl|wget|nc|ssh|scp|git\s+(checkout|reset|clean|stash|apply|commit|restore|merge|rebase|cherry-pick|push|pull|fetch|am))(\s|$|[^a-z-])/.test(command)
		|| /(^|[\s;&|])>\s*[^/|&]|(^|[\s;&|])>>|(^|[\s;&|])>\/\S/.test(command)
		|| pipedShell(command)
		|| writeOptions(command)
		|| gitWriteArgs(command);
}

/**
 * Best-effort: the text of every `$(…)` and backtick substitution span in a
 * command, including spans nested inside others (depth-capped). Substitution
 * content executes like a command, so the guard inspects it too. The span
 * counts are capped (8 collected, 12 with nesting): `truncated` names whether
 * a span was dropped, so the guard denies the command instead of answering it
 * with spans it never inspected.
 */
function substitutionTexts(command) {
	const texts = [];
	// Whether a span was dropped by a cap: the worker guard denies the command
	// outright instead of passing it because its first spans were clean.
	let truncated = false;
	let depth = 0;
	let start = -1;
	for (let i = 0; i < command.length; i++) {
		if (command.startsWith("$(", i)) {
			if (depth === 0) start = i + 2;
			depth++;
			continue;
		}
		if (command[i] === ")" && depth > 0) {
			depth--;
			if (depth === 0) { if (texts.length < 8) texts.push(command.slice(start, i)); else truncated = true; }
			continue;
		}
		if (command[i] === "`") {
			const end = command.indexOf("`", i + 1);
			if (end < 0) break;
			if (texts.length < 8) texts.push(command.slice(i + 1, end));
			else truncated = true;
			i = end;
		}
	}
	// Nested spans inside collected ones (best-effort, one more pass).
	for (const text of [...texts]) {
		for (const nested of substitutionTexts(text).texts) {
			if (texts.includes(nested)) continue;
			if (texts.length < 12) texts.push(nested);
			else truncated = true;
		}
	}
	return { texts, truncated };
}

/**
 * The per-command profile check: a denial string, or undefined. Substitution
 * spans are inspected with the same check by the worker guard.
 */
function profileDenial(command, profile) {
	if (profile === "static") {
		const argv = command.trim().split(/\s+/);
		const binary = (argv[0] ?? "").split("/").pop();
		if (!STATIC_BASH_BINARIES.has(binary)) return `a read-only reviewer may run ${[...STATIC_BASH_BINARIES].join(", ")}, not "${binary}"`;
		if (binary === "git") {
			const sub = argv[1];
			if (!READ_GIT_SUBCOMMANDS.has(sub)) return `a read-only reviewer may not run "git ${sub}"`;
		}
		if (mutatingBash(command)) return "a read-only reviewer's commands may not write to the working tree or reach the network (best-effort guard; the OS sandbox is the real boundary)";
		return undefined;
	}
	if (mutatingExecBash(command)) return "a reviewer's commands may not install dependencies or reach the network, and must not obviously mutate the working tree (best-effort guard; the OS sandbox is the real boundary)";
	return undefined;
}

/**
 * The worker tool guard: best-effort enforcement installed on each worker's own
 * scope right after it starts. The sandbox remains the real boundary; this
 * guard catches the obvious cases and is documented as such. Substitution
 * content ($(…), backticks) executes like a command and is inspected with the
 * same profile check.
 * @param allow - tool names the worker may call.
 * @param profile - `static` (read-only) or `executing` (may run tests).
 */
export function workerGuard(allow, profile) {
	const allowed = new Set(allow);
	const check = (command) => {
		const denial = profileDenial(command, profile === "executing" ? "executing" : "static");
		return denial ? `denied by the deep-review worker guard: ${denial}` : undefined;
	};
	return (execution) => {
		if (!allowed.has(execution.name)) return `denied by the deep-review worker guard: "${execution.name}" is not a read tool this worker may call`;
		if (execution.name !== "bash") return undefined;
		const command = execution.arguments?.command;
		if (typeof command !== "string") return 'denied by the deep-review worker guard: a bash call needs a "command"';
		const denial = check(command);
		if (denial) return denial;
		const { texts, truncated } = substitutionTexts(command);
		// Deny on truncation before the span checks: a cap-dropped span was
		// never inspected, so the command must not pass because its first
		// spans were clean.
		if (truncated) return "denied by the deep-review worker guard: the command has more $(…) or backtick spans than the guard inspects";
		for (const span of texts) {
			const spanDenial = check(span);
			if (spanDenial) return `denied by the deep-review worker guard: the $(…) content — ${spanDenial}`;
		}
		return undefined;
	};
}

/**
 * Install the best-effort worker containment on one child: the declarative
 * allow-list (the replacement for the removed start-time toolFilter) and the
 * per-command guard, both on the child's own scope, resolved through the
 * agents registry — the 0.2.1 activation receipt publishes no localAgent. The
 * restriction and the guard install INDEPENDENTLY: a restrict throw (an allow
 * name the child's tool view cannot restrict — web deployments compose tools
 * per preset) must not also kill the guard, which enforces the same policy per
 * command on its own. Every degradation is a returned note, never silent: a
 * live deployment ran a whole fleet with neither install engaged and nothing
 * but a stdout-only warn (not persisted) to show for it.
 * @param deps - the calling session's context (the fleet fiber's), the
 *   activation's child id, the allow names, the guard profile, and the logger.
 * @returns the degradation notes (empty when fully installed).
 */
export function installWorkerContainment({ ctx, childId, allow, guardProfile, logger }) {
	const notes = [];
	const guard = workerGuard(allow, guardProfile === "executing" ? "executing" : "static");
	const child = ctx.get?.("agents")?.get?.(childId);
	if (child === undefined) {
		notes.push("the agents registry publishes no in-process child to contain (remote providers keep none)");
		logger?.warn?.(new Error(`the deep-review worker containment could not be installed: ${notes.at(-1)}`));
		return notes;
	}
	const tools = child?.ctx?.tools;
	if (typeof tools?.restrict === "function") {
		try {
			// A name the child's view cannot restrict throws out of restrict();
			// intersect with the view's restrictable names first so the
			// allow-list degrades to what it can enforce instead of skipping
			// containment outright.
			const restrictable = tools.view?.(child)?.restrictableNames;
			const names = restrictable instanceof Set ? allow.filter((name) => restrictable.has(name)) : [...allow];
			if (names.length > 0) tools.restrict({ allow: names });
			else notes.push("none of the reviewer tools are restrictable on the child's tool view");
		} catch (error) {
			notes.push(`the tool restriction failed: ${error?.message ?? error}`);
			logger?.warn?.(error);
		}
	} else {
		notes.push("the child's context exposes no tools service to restrict");
		logger?.warn?.(new Error("the deep-review worker tool restriction could not be installed: the child's context exposes no tools service"));
	}
	if (typeof tools?.guard === "function") {
		try {
			tools.guard(guard);
		} catch (error) {
			notes.push(`the command guard failed to install: ${error?.message ?? error}`);
			logger?.warn?.(error);
		}
	} else {
		notes.push("the child's tools service exposes no guard hook");
		logger?.warn?.(new Error("the deep-review worker guard could not be installed: the child's tools service exposes no guard hook"));
	}
	return notes;
}

/**
 * Run one fleet worker: capability checks, a fresh child on the configured
 * provider via the subagent seam's `startActivation` (the one-shot entry since
 * the host's 0.2.1 release removed `ctx.subagents.start`), the persona folded
 * into the prompt, best-effort containment installed on the child's own scope,
 * a timeout, and disposal on every path. `outputSchema` is the requested
 * structured-output schema; a provider that cannot enforce it fails loud
 * before the start. `guardProfile` is the worker's best-effort guard profile —
 * the lane catalog's declared `guard` field, NOT derived from the run label.
 * `options` are per-lane agent options (a verify lane's
 * `lanes.<id>.agentOptions`), merged undefined-filtered over the kind-based
 * global here, where the capabilities.agentOptions fail-loud check covers the
 * FINAL options the provider receives.
 *
 * Persona and tool containment are the fleet's own, not provider features: the
 * 0.2.1 seam removed the per-provider `persona`/`toolFilter` capabilities and
 * start-request fields (persona and tool composition moved to agent presets).
 * The persona is a static string (`prompts.js`), so this seam prefixes it to
 * the worker's prompt, and the tool allow-list is enforced on the child's own
 * scope after publication — `tools.restrict({ allow })` for the declarative
 * filter, plus the per-command guard — both best-effort with warnings, the OS
 * sandbox remaining the real boundary.
 * @returns `{ ok: true, structured, output } | { ok: false, reason, diagnostic? }`, each
 *   with `containment` — undefined when the best-effort containment fully
 *   installed, else the joined degradation notes (the callers surface them in
 *   the scan/verify output).
 */
export async function runAgent({ ctx, settings, kind, label, prompt, persona, outputSchema, parent, signal, logger, guardProfile, options }) {
	const providerName = settings.reviewerProvider;
	const provider = ctx.subagents.getProvider(providerName);
	if (!provider) return { ok: false, reason: `the "${providerName}" subagent provider is not available` };
	const capabilities = provider.capabilities ?? {};
	if (!capabilities.outputSchema) return { ok: false, reason: `the "${providerName}" provider does not support structured output, so a fleet worker could not be composed` };
	if (provider.inheritsParentContext !== false) {
		return { ok: false, reason: `the "${providerName}" provider starts children with the parent's context, which would break verifier independence` };
	}
	// Per-lane options (a verify lane's `lanes.<id>.agentOptions`) merge over the
	// kind-based global. Lane values are undefined-filtered BEFORE the spread
	// (config.js's own convention): an explicitly-undefined lane field must not
	// shadow the global. The merge lands in this seam so the
	// capabilities.agentOptions fail-loud check below covers the FINAL options
	// the provider receives.
	const global = kind === "reviewer" ? settings.reviewerAgentOptions : settings.verifierAgentOptions;
	const defined = Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));
	const agentOptions = nonEmpty({ ...global, ...defined });
	if (agentOptions && !capabilities.agentOptions) {
		return { ok: false, reason: `the "${providerName}" provider does not support agent options, so the configured ${kind} model cannot be applied` };
	}
	// Resolve the read tools against the calling session's tool view; a missing
	// one fails loud instead of starting blind workers. The scope is the calling
	// agent: get(name) with no scope reads the host composition's GLOBAL layer
	// only, and a web deployment registers every model-facing tool behind
	// per-session presets on the agent plane (the web-app bundle disables the
	// base's host tool rows), so the global view reads "bash" as absent and
	// every worker of a passing session fails the check below.
	const allow = [];
	for (const name of settings.reviewerTools) {
		if (!ctx.tools.get(name, parent)) return { ok: false, reason: `the configured reviewer tool "${name}" is not visible to this session` };
		allow.push(name);
	}

	const timeout = AbortSignal.timeout(kind === "reviewer" ? settings.reviewerTimeoutMs : settings.verifierTimeoutMs);
	const composed = AbortSignal.any([signal, timeout]);
	// Best-effort containment notes: every degradation the install below hits,
	// joined into the result's `containment` string (undefined when the worker
	// was fully contained). The callers surface them in the scan/verify output —
	// a live deployment ran a whole fleet with neither install engaged and
	// nothing but a stdout-only warn (not persisted) to show for it.
	const containmentNotes = [];
	const containment = () => (containmentNotes.length > 0 ? containmentNotes.join("; ") : undefined);
	// The persona leads the worker's single text block. The 0.2.1 start request
	// has no persona field; the persona is static (prompts.js), so the prefix
	// keeps the worker's stance without provider support. Verifier prompts no
	// longer repeat it (buildVerifierPrompt dropped its persona head).
	const text = persona ? `${persona}\n\n${prompt}` : prompt;
	let activation;
	// The manager does not watch the published signal for local children — an
	// abort only rolls back an in-flight START — so the timeout and the call
	// budget cancel the worker through disposal (idempotent: the manager
	// memoizes the close). The caller's re-run and the not-ok answer below
	// never depended on the child stopping, only on the composed signal.
	const onAbort = () => {
		activation?.dispose()?.catch?.(() => {});
	};
	composed.addEventListener("abort", onAbort, { once: true });
	try {
		activation = await ctx.subagents.startActivation({
			provider: providerName,
			label,
			request: {
				prompt: [{ type: "text", text }],
				parent,
				outputSchema,
				...(agentOptions ? { agentOptions } : {}),
			},
			signal: composed,
			// Caller delivery: the fleet awaits the result here and nothing may
			// inject a settlement message into the orchestrator's inbox (the old
			// one-shot seam delivered nothing either).
			delivery: "caller",
		});
		// Best-effort containment on the child's own scope (see
		// installWorkerContainment): the install runs inside its own guard so a
		// plugin-internal throw must not fail the run — the note keeps the
		// degradation visible in the tool output.
		try {
			containmentNotes.push(...installWorkerContainment({ ctx, childId: activation.childId, allow, guardProfile, logger }));
		} catch (error) {
			containmentNotes.push(`containment installation failed unexpectedly: ${error?.message ?? error}`);
			logger?.warn?.(error);
		}
		const result = await activation.result;
		if (result.stopReason !== "completed") {
			// The runtime's stop reasons, in a reader's words: the roster entry
			// is where a user looks for why a worker stopped. A bare "error"
			// with no diagnostic and no capture is the runtime's conversion of a
			// worker whose turn completed without the structured_output call
			// (captureLocalResult) — the prose-ending failure the output
			// contract in prompts.js now names the tool for.
			const why = timeout.aborted ? "timed out"
				: signal.aborted ? "was cancelled"
				: result.stopReason === "max-tokens" ? "ran out of output tokens (max-tokens)"
				: result.stopReason === "refusal" ? "was blocked (refusal)"
				: result.stopReason === "error" && !result.diagnostic && !result.structured ? "finished without reporting its structured result"
				: `stopped with "${result.stopReason}"`;
			return { ok: false, reason: `${kind} ${why}${result.diagnostic ? `: ${result.diagnostic}` : ""}`, containment: containment() };
		}
		// The seam cancels the worker itself (the onAbort listener disposes the
		// activation, and the manager's disposal cancels a local child), so this
		// only catches a worker that resolved completed across an abort before
		// the disposal landed: the worker was cancelled mid-run either way, and
		// it re-runs. The composed signal includes the per-run timeout, so a
		// result that races the deadline answers not-ok too — the configured
		// limit stays hard. The wording order matches the catch below.
		if (composed.aborted) return { ok: false, reason: timeout.aborted ? `${kind} timed out` : `${kind} was cancelled`, containment: containment() };
		if (!result.structured) return { ok: false, reason: `${kind} returned no structured result`, containment: containment() };
		return { ok: true, structured: result.structured, output: result.output, containment: containment() };
	} catch (error) {
		const why = timeout.aborted ? "timed out" : signal.aborted ? "was cancelled" : (error?.message ?? String(error));
		return { ok: false, reason: `${kind} failed: ${why}`, containment: containment() };
	} finally {
		// The result is already decided; a disposal failure must not replace it,
		// but it means the child may still be live, so it is surfaced. Idempotent:
		// the onAbort listener may already have disposed the activation.
		try {
			await activation?.dispose();
		} catch (error) {
			logger?.warn?.(error);
		}
	}
}

/** Drop undefined agent options. */
function nonEmpty(options) {
	const defined = Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));
	return Object.keys(defined).length ? defined : undefined;
}

/**
 * Map items over ONE bounded pool: at most `total` callbacks run at once
 * across every group, so both fleet phases hold the same number of
 * simultaneous agents — the scan's reviewers and the verify phase's static
 * and executing lanes all share the `deep.concurrency` pool size. An optional
 * per-group sub-cap (`perGroup`) bounds one group's share inside the shared
 * pool (the reproducer lanes' working-tree bound); a sub-cap only throttles
 * dispatches of its own group and can never starve the pool: with nothing in
 * flight every group has room (each cap is ≥ 1), so the pump always makes
 * progress. Dispatch scans forward past groups at their sub-cap, so a
 * throttled group cannot block an eligible later item; results still land in
 * input order. One item's failure never rejects the pool.
 * @returns the settled values in input order.
 */
export async function mapPoolTotal(items, groupKey, { total, perGroup }, fn) {
	const results = new Array(items.length);
	const inFlight = new Map(); // group key -> running callbacks
	const remaining = new Set(items.map((_, index) => index));
	let active = 0;
	await new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (!settled && active === 0 && remaining.size === 0) {
				settled = true;
				resolve();
			}
		};
		const pump = () => {
			if (settled) return;
			for (const index of [...remaining]) {
				if (active >= total) return;
				const key = groupKey(items[index]) ?? "";
				const cap = perGroup?.[key];
				if (cap !== undefined && (inFlight.get(key) ?? 0) >= cap) continue;
				remaining.delete(index);
				active++;
				inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
				void (async () => {
					try {
						results[index] = await fn(items[index]);
					} catch (error) {
						results[index] = { ok: false, reason: error?.message ?? String(error) };
					}
				})().then(() => {
					active--;
					inFlight.set(key, inFlight.get(key) - 1);
					finish();
					pump();
				});
			}
			finish();
		};
		pump();
	});
	return results;
}
