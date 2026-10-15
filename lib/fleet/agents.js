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
 * Run one fleet worker: capability checks, a fresh child on the configured
 * provider, the guard installed on the child's own scope, a timeout, and
 * disposal on every path. `outputSchema` is the requested structured-output
 * schema; a provider that cannot enforce it fails loud before the start.
 * `guardProfile` is the worker's best-effort guard profile — the lane catalog's
 * declared `guard` field, NOT derived from the run label. `options` are per-lane
 * agent options (a verify lane's `lanes.<id>.agentOptions`), merged
 * undefined-filtered over the kind-based global here, where the
 * capabilities.agentOptions fail-loud check covers the FINAL options the
 * provider receives.
 * @returns `{ ok: true, structured, output } | { ok: false, reason, diagnostic? }`.
 */
export async function runAgent({ ctx, settings, kind, label, prompt, persona, outputSchema, parent, signal, logger, guardProfile, options }) {
	const providerName = settings.reviewerProvider;
	const provider = ctx.subagents.getProvider(providerName);
	if (!provider) return { ok: false, reason: `the "${providerName}" subagent provider is not available` };
	const capabilities = provider.capabilities ?? {};
	for (const [capability, why] of [
		["persona", "personas"],
		["toolFilter", "tool filters"],
		["outputSchema", "structured output"],
	]) {
		if (!capabilities[capability]) return { ok: false, reason: `the "${providerName}" provider does not support ${why}, so a fleet worker could not be composed` };
	}
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
	let run;
	try {
		run = await ctx.subagents.start(providerName, {
			label,
			prompt: [{ type: "text", text: prompt }],
			parent,
			signal: composed,
			persona,
			toolFilter: { allow: [...allow] },
			outputSchema,
			...(agentOptions ? { agentOptions } : {}),
		});
		// Best-effort read-only enforcement on the child's own scope: a guard
		// installed after publication, before the child's first tool call can
		// matter. Installation failures and a missing guard hook are warnings,
		// never results.
		try {
			const guard = workerGuard(allow, guardProfile === "executing" ? "executing" : "static");
			const hook = run.localAgent?.ctx?.tools?.guard;
			// The warn names a cause this seam can verify: localAgent is undefined
			// for remote providers (acp, codex, claude-code, dsh-sdk publish no
			// in-process child to guard), while an in-process child without a hook
			// is the tools service's absence.
			if (typeof hook !== "function") logger?.warn?.(new Error(run.localAgent === undefined
				? "the deep-review worker guard could not be installed: the provider publishes no in-process child to guard"
				: "the deep-review worker guard could not be installed: the child's tools service exposes no guard hook"));
			else hook(guard);
		} catch (error) {
			logger?.warn?.(error);
		}
		const result = await run.result;
		if (result.stopReason !== "completed") {
			const why = timeout.aborted ? "timed out" : signal.aborted ? "was cancelled" : `stopped with "${result.stopReason}"`;
			return { ok: false, reason: `${kind} ${why}${result.diagnostic ? `: ${result.diagnostic}` : ""}` };
		}
		// A cooperative provider cancels the published run when the composed signal
		// fires, so this only catches a provider that resolved completed across an
		// abort: the worker was cancelled mid-run either way, and it re-runs. The
		// composed signal includes the per-run timeout, so a provider that ignores
		// it and resolves completed across the deadline answers not-ok too — the
		// configured limit stays hard. The wording order matches the catch below.
		if (composed.aborted) return { ok: false, reason: timeout.aborted ? `${kind} timed out` : `${kind} was cancelled` };
		if (!result.structured) return { ok: false, reason: `${kind} returned no structured result` };
		return { ok: true, structured: result.structured, output: result.output };
	} catch (error) {
		const why = timeout.aborted ? "timed out" : signal.aborted ? "was cancelled" : (error?.message ?? String(error));
		return { ok: false, reason: `${kind} failed: ${why}` };
	} finally {
		// The result is already decided; a disposal failure must not replace it,
		// but it means the child may still be live, so it is surfaced.
		try {
			await run?.dispose();
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
 * Map items over a bounded pool, grouped by `groupKey`: groups (executing vs
 * static lanes) never wait on each other, and each group runs at its own
 * concurrency. One item's failure never rejects the pool.
 * @returns the settled values in input order.
 */
export async function mapPoolGrouped(items, groupKey, limits, fn) {
	const groups = new Map();
	items.forEach((item, index) => {
		const key = groupKey(item) ?? "";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(index);
	});
	const results = new Array(items.length);
	await Promise.all(
		[...groups.entries()].map(([key, indexes]) =>
			drain(indexes, limits[key] ?? limits.default, async (index) => {
				try {
					results[index] = await fn(items[index]);
				} catch (error) {
					results[index] = { ok: false, reason: error?.message ?? String(error) };
				}
			}),
		),
	);
	return results;
}

/** Run a fixed number of workers over an index list. */
async function drain(indexes, limit, fn) {
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, indexes.length)) }, async () => {
		while (cursor < indexes.length) {
			await fn(indexes[cursor++]);
		}
	});
	await Promise.all(workers);
}
