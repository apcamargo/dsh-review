/**
 * Client-half test for `@apcamargo/dsh-review`: loads `lib/client.js` the way
 * the harness client module system does (a `window.__ModuleLoader__` factory
 * with a seeded `require`), then exercises the two behaviors the bundle adds —
 * the composer notice on settled review-command errors, and the keyed
 * `conversation.chat.commandview` card replacing the generic command card.
 *
 * No DOM and no React renderer: `react/jsx-runtime` is stubbed with plain
 * element factories and the card is asserted over its element tree.
 *
 * @module @apcamargo/dsh-review/client-ui
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "lib", "client.js");

/** Minimal `react/jsx-runtime` stub: elements are plain records. */
function jsx(type, props, ...children) {
	return { type, props: { ...props, ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } };
}
const jsxRuntime = { jsx, jsxs: jsx, Fragment: "Fragment" };

/** Collect every string in a stubbed element tree. */
function strings(node, into = []) {
	if (node === null || node === void 0 || typeof node === "boolean") return into;
	if (typeof node === "string" || typeof node === "number") {
		into.push(String(node));
		return into;
	}
	if (Array.isArray(node)) {
		for (const child of node) strings(child, into);
		return into;
	}
	if (typeof node === "object" && node.props !== void 0) {
		strings(node.props.children, into);
		return into;
	}
	return into;
}

/** Load the bundle exactly as the harness client module system would. */
function loadBundle(extraGlobals = {}) {
	let captured;
	const window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
	vm.runInNewContext(readFileSync(bundlePath, "utf8"), { window, ...extraGlobals }, { filename: "lib/client.js" });
	assert.ok(captured, "bundle must register through window.__ModuleLoader__.load");
	assert.equal(captured.id, "@apcamargo/dsh-review");
	const exports = captured.factory((spec) => {
		assert.equal(spec, "react/jsx-runtime", "the bundle may only require the jsx-runtime platform seed");
		return jsxRuntime;
	});
	assert.equal(typeof exports.apply, "function");
	// Cross-realm arrays are never deepStrictEqual, so compare structurally.
	// `slots` MUST be declared: a cordis context throws `cannot get property
	// "slots" without inject` for an undeclared access, which fails the whole
	// web boot (the plugin once shipped `[]` here and DSH would not open).
	assert.equal(Array.isArray(exports.inject), true);
	assert.deepEqual([...exports.inject], ["slots"]);
	return exports;
}

/** Client plugin context mock recording listeners, effects, and slot registrations. */
function makeCtx({ services = {} } = {}) {
	const listeners = new Map();
	const slotThunks = [];
	const registrations = [];
	const effects = [];
	const ctx = {
		effects,
		listeners,
		slotThunks,
		registrations,
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		effect(callback, label) {
			effects.push(label);
			return callback();
		},
		get(name) {
			return services[name];
		},
		slots: {
			inject(name, thunk) {
				slotThunks.push([name, thunk]);
			},
			register(options, component) {
				registrations.push([options, component]);
				return () => {};
			}
		}
	};
	return ctx;
}

/** Sessions + conversation mock capturing composer notices. */
function makeSessions() {
	const notices = [];
	const sessions = {
		notices,
		scope(sessionId) {
			if (sessionId === void 0) return void 0;
			return {
				get(name) {
					return name === "conversation" ? {
						input: {
							for() {
								return { notify(level, text) { notices.push({ level, text }); } };
							}
						}
					} : void 0;
				}
			};
		}
	};
	return sessions;
}

// The bundle loads and materializes against the platform seed surface.
const bundle = loadBundle();

// apply() wires the listener through an effect and registers the keyed card.
const ctx = makeCtx({ services: { sessions: makeSessions() } });
bundle.apply(ctx);
assert.deepEqual(ctx.effects, ["review-client: command/executed listener"]);
assert.equal(typeof ctx.listeners.get("command/executed"), "function");
assert.equal(ctx.slotThunks.length, 1);
assert.equal(ctx.slotThunks[0][0], "conversation.chat.commandview");
ctx.slotThunks[0][1]();
assert.equal(ctx.registrations.length, 1);
const [cardOptions, cardComponent] = ctx.registrations[0];
assert.equal(cardOptions.name, "conversation.chat.commandview");
assert.equal(cardOptions.key, "review");
assert.equal(cardComponent, bundle.ReviewCommandCard);

// A settled review-command error raises a composer error notice immediately.
const sessions = makeSessions();
const scopedCtx = makeCtx({ services: { sessions } });
bundle.apply(scopedCtx);
const listener = scopedCtx.listeners.get("command/executed");
listener("session-1", "review", { kind: "error", text: "Not a git repository — the uncommitted review needs one." });
listener("session-1", "end-review", { kind: "error", text: "end-review failed" });
assert.deepEqual(sessions.notices, [
	{ level: "error", text: "Not a git repository — the uncommitted review needs one." },
	{ level: "error", text: "end-review failed" }
]);

// Successes, other commands, and missing services stay silent and never throw.
listener("session-1", "review", { kind: "success" });
listener("session-1", "plan", { kind: "error", text: "plan failed" });
listener(void 0, "review", { kind: "error", text: "no session" });
assert.equal(sessions.notices.length, 2);

const bareCtx = makeCtx({});
bundle.apply(bareCtx);
assert.doesNotThrow(() => bareCtx.listeners.get("command/executed")("session-1", "review", { kind: "error", text: "boom" }));

// Direct seam: the notice routing answers whether it surfaced.
assert.equal(bundle.surfaceErrorNotice(makeSessions(), "session-1", "boom"), true);
assert.equal(bundle.surfaceErrorNotice(undefined, "session-1", "boom"), false);
assert.equal(bundle.surfaceErrorNotice({ scope: () => void 0 }, "session-1", "boom"), false);
assert.equal(bundle.surfaceErrorNotice({ scope: () => ({ get: () => void 0 }) }, "session-1", "boom"), false);

// The card renders a loud, always-expanded failure for settled errors.
const failure = cardComponent({ node: { name: "review", args: " --deep", outcome: { kind: "error", text: "Not a git repository — checked /tmp/no-repo." } } });
const failureText = strings(failure).join("\n");
assert.match(failureText, /Review failed/);
assert.match(failureText, /\/review --deep/);
assert.match(failureText, /Not a git repository — checked \/tmp\/no-repo\./);

// Success and running outcomes render the quiet row, not the failure card.
const success = cardComponent({ node: { name: "review", args: "", outcome: { kind: "success", text: "Review started: current changes." } } });
const successText = strings(success).join("\n");
assert.match(successText, /\/review/);
assert.match(successText, /Review started: current changes\./);
assert.doesNotMatch(successText, /Review failed/);

const running = cardComponent({ node: { name: "review", args: "", outcome: null } });
assert.match(strings(running).join("\n"), /Preparing review…/);

// Bare inputs never throw: a null outcome with no text still renders a row.
assert.doesNotThrow(() => cardComponent({ node: { name: "review", outcome: { kind: "success" } } }));
assert.doesNotThrow(() => cardComponent({ node: null }));

// Style injection: once per document (in the bundle's own realm), and a
// second apply does not duplicate the tag.
const appended = [];
const fakeDocument = {
	head: { appendChild: (tag) => appended.push(tag) },
	querySelector: () => appended.length > 0 ? {} : null,
	createElement: () => ({ dataset: {} })
};
try {
	const styleBundle = loadBundle({ document: fakeDocument });
	styleBundle.apply(makeCtx({}));
	styleBundle.apply(makeCtx({}));
	assert.equal(appended.length, 1);
	assert.match(appended[0].textContent ?? "", /dshr-failure/);
} finally {
	delete globalThis.document;
}

console.log("client-ui: all assertions passed");
