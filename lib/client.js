window.__ModuleLoader__.load({
	id: "@apcamargo/dsh-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region client/review-client.js
		/**
		 * Client half of the review plugin.
		 *
		 * The harness deliberately keeps the composer quiet about admitted
		 * commands: a handler error only renders as the command flow node
		 * (`dsh-client-ui-commands` returns `success` to the composer for any
		 * admitted command without attachments). That node is also the ONLY
		 * error surface, and it disappears entirely while a session is still
		 * blank — the conversation view returns `null` until the first
		 * `turn/start`, so a failed `/review` in a fresh session shows nothing
		 * at all.
		 *
		 * This half restores visibility without touching the harness:
		 *
		 * 1. A `command/executed` listener routes review command errors to the
		 *    composer's notice channel, which renders in every phase including
		 *    the blank hero state — the failure is acknowledged immediately at
		 *    the input.
		 * 2. A `conversation.chat.commandview` keyed slot replaces the generic
		 *    command card for `review` with a card whose error state is loud:
		 *    an always-expanded, full-text failure card instead of one
		 *    ellipsized line.
		 *
		 * @module @apcamargo/dsh-review/client
		 */

		/** Review commands whose settled errors this half surfaces. */
		const REVIEW_COMMANDS = new Set(["review", "end-review"]);

		/** Card copy, hardcoded: the plugin ships English-only today. */
		const COPY = {
			failedTitle: "Review failed",
			running: "Preparing review…",
			done: "Review started",
			doneSuffix: " — findings will appear in this session"
		};

		/** Card styling; injected once per document, mirroring the built-in CSS-module pattern. */
		const CSS = `
.dshr-row{align-items:center;gap:6px;min-width:0;display:flex}
.dshr-dot{background:var(--dsw-alias-border-l2);border-radius:50%;flex:none;height:6px;width:6px}
.dshr-title{color:var(--dsw-alias-label-primary);font-weight:500;flex:none}
.dshr-summary{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshr-failure{--dsw-elevation-stroke-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);border-radius:var(--dsw-radius-md,8px);overflow:hidden}
.dshr-failureHead{align-items:center;gap:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);padding:8px 12px;display:flex}
.dshr-failureTitle{color:var(--dsw-alias-state-error-primary);font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase}
.dshr-failureCommand{color:var(--dsw-alias-label-tertiary);font-family:var(--dsh-font-family,monospace);font-size:12px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshr-failureText{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word}
.dshr-failureHint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:0 12px 10px}
`;
		const CSS_TAG_ID = "@apcamargo/dsh-review/lib/client.css";
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@apcamargo/dsh-review";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** One `command.name [args]` label for card headers and the notice prefix. */
		function commandLabel(command) {
			const name = command?.name ?? "review";
			const args = typeof command?.args === "string" && command.args.trim().length > 0 ? ` ${command.args.trim()}` : "";
			return `/${name}${args}`;
		}

		/**
		 * The review command flow card; replaces the generic command card for
		 * every `review` node, so it renders all three outcomes.
		 * @param props - slot owner props: `{ node }` carrying the command view
		 *   data (`{ name, args, outcome: { kind, text? } | null }`).
		 * @returns the card element.
		 */
		function ReviewCommandCard({ node }) {
			const outcome = node?.outcome ?? null;
			const text = typeof outcome?.text === "string" ? outcome.text : "";
			if (outcome !== null && outcome.kind === "error") {
				return (0, react_jsx_runtime.jsxs)("div", {
					className: "dshr-failure",
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "dshr-failureHead",
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: "dshr-failureTitle", children: COPY.failedTitle }),
								(0, react_jsx_runtime.jsx)("span", { className: "dshr-failureCommand", children: commandLabel(node) })
							]
						}),
						(0, react_jsx_runtime.jsx)("pre", { className: "dshr-failureText", children: text.length > 0 ? text : "The review command failed." }),
						(0, react_jsx_runtime.jsx)("div", {
							className: "dshr-failureHint",
							children: "Nothing was started. Fix the cause and run the command again; past failures are listed in the harness logs."
						})
					]
				});
			}
			const summary = outcome === null
				? COPY.running
				: text.length > 0 ? text : COPY.done;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshr-row",
				children: [
					(0, react_jsx_runtime.jsx)("span", { className: "dshr-dot" }),
					(0, react_jsx_runtime.jsx)("span", { className: "dshr-title", children: commandLabel(node) }),
					(0, react_jsx_runtime.jsx)("span", { className: "dshr-summary", children: outcome === null ? summary : `${summary}${COPY.doneSuffix}` })
				]
			});
		}

		/**
		 * Route one settled review command error to the composer's notice
		 * channel, the only surface that renders while the session is still
		 * blank (hero phase). Mirrors the internal `noticeFor` path exactly.
		 * @param sessions - the client `sessions` service.
		 * @param sessionId - session the command ran in.
		 * @param text - error text to surface.
		 * @returns whether a notice was raised.
		 */
		function surfaceErrorNotice(sessions, sessionId, text) {
			const scope = typeof sessions?.scope === "function" ? sessions.scope(sessionId) : void 0;
			if (scope === void 0) return false;
			const conversation = scope.get("conversation");
			if (conversation === void 0) return false;
			conversation.input.for(scope).notify("error", text);
			return true;
		}

		/**
		 * Mount the client half.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			injectStyles();
			// Immediate feedback: fires the moment the host settles a review
			// command, in every shell phase — including the blank hero state
			// where the conversation (and its command cards) is not mounted.
			ctx.effect(() => ctx.on("command/executed", (sessionId, name, result) => {
				if (!REVIEW_COMMANDS.has(name)) return;
				if (result?.kind !== "error") return;
				const text = typeof result.text === "string" && result.text.length > 0 ? result.text : `/${name} failed.`;
				const sessions = ctx.get("sessions");
				if (sessions === void 0) return;
				surfaceErrorNotice(sessions, sessionId, text);
			}), "review-client: command/executed listener");
			// Durable feedback: replace the generic card for review command
			// nodes so a settled error renders as a loud, always-expanded card
			// wherever the conversation flow is visible. `slots` is guaranteed
			// by the module-level `inject` declaration: a cordis context throws
			// on `ctx.slots` for a plugin that did not declare the service, so
			// the optional-chaining form never saved us — the entry fiber just
			// failed and the whole web boot refused to open.
			ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
				name: "conversation.chat.commandview",
				key: "review"
			}, ReviewCommandCard));
		}

		exports.ReviewCommandCard = ReviewCommandCard;
		exports.apply = apply;
		// Required client services. Declaring `slots` is what keeps the entry
		// fiber pending until the ui-renderer provides the slot registry; with
		// `[]` the entry activated before (and without) the service and died on
		// the first `ctx.slots` property access, failing the whole web boot.
		exports.inject = ["slots"];
		exports.surfaceErrorNotice = surfaceErrorNotice;
		//#endregion
		return module.exports;
	}
});
