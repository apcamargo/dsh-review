/**
 * The steering ledger: user-typed guidance reaching the fleet.
 *
 * A plain `agent/inbox/inserted` listener records messages whose producer is
 * the user while a deep review is active in that session. The listener is keyed
 * by agent identity against the run store: worker agents' own prompts arrive as
 * `source.kind: "user"` messages too, so a listener that did not require
 * `payload.agent === run.agent` would record reviewer prompts as steering.
 * `agent/inbox/discarded` and replace-by-id remove or update entries, so a
 * cancel or an edit never leaves ghost steering. The ledger is capped by entry
 * count and per-entry length; the first entry (the user's standing instruction)
 * is pinned, and every overflow is noticed in the prompt block and the report.
 *
 * @module @apcamargo/dsh-review/fleet/steering
 */

/** Character cap of one steering entry, also enforced by the settings. */
const ENTRY_CHARS_CAP = 4000;

/**
 * Create one run's ledger.
 * @param settings - `maxSteeringEntries`, `maxSteeringChars` from the deep config.
 */
export function createLedger(settings) {
	const entries = [];
	let droppedCount = 0;
	let oldestDroppedN;
	let nextNumber = 1;

	function trim() {
		while (entries.length > settings.maxSteeringEntries) {
			const index = entries.findIndex((entry, i) => i > 0);
			const dropped = index > 0 ? entries.splice(index, 1)[0] : entries.pop();
			droppedCount++;
			// Named once: the notice carries the count, so the oldest dropped
			// entry is the useful signal (naming the LAST dropped one per trim
			// would under-report across several adds).
			oldestDroppedN ??= dropped?.n;
		}
	}

	return {
		/** Record one inserted message; deduped by id, text blocks only. */
		add(message) {
			if (!message?.id || entries.some((entry) => entry.id === message.id)) return false;
			const text = (message.content ?? [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n")
				.trim();
			const hasAttachment = (message.content ?? []).some((block) => block.type !== "text");
			if (!text && !hasAttachment) return false;
			const cap = Math.min(settings.maxSteeringChars, ENTRY_CHARS_CAP);
			const kept = text.length > cap ? `${text.slice(0, cap)}… [truncated: ${text.length - cap} more characters]` : text;
			const note = hasAttachment ? `${kept ? `${kept}\n` : ""}(attachment omitted)` : kept;
			if (!note) return false;
			entries.push({ n: nextNumber++, id: message.id, text: note, receivedAt: new Date().toISOString() });
			trim();
			return true;
		},
		/** Remove one message's entry by id (discarded or replaced). */
		discard(message) {
			const index = entries.findIndex((entry) => entry.id === message?.id);
			if (index < 0) return false;
			entries.splice(index, 1);
			return true;
		},
		/** Replace one entry's text in place (edited while queued). */
		replace(message) {
			const entry = entries.find((item) => item.id === message?.id);
			if (!entry) return false;
			const text = (message.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
			if (!text) return false;
			const cap = Math.min(settings.maxSteeringChars, ENTRY_CHARS_CAP);
			entry.text = text.length > cap ? `${text.slice(0, cap)}… [truncated: ${text.length - cap} more characters]` : text;
			return true;
		},
		/** The ledger entries, in received order. */
		entries() {
			return [...entries];
		},
		/** Whether an overflow notice must ride with the block. */
		notice() {
			if (!droppedCount) return undefined;
			const named = oldestDroppedN != null ? `entry #${oldestDroppedN}` : "oldest";
			return `⚠️ ${droppedCount} earlier steering message${droppedCount === 1 ? "" : "s"} ${droppedCount === 1 ? "was" : "were"} dropped by the cap (${named} dropped). Re-run /review instructions if it still matters.`;
		},
		/** The delimited prompt block for one worker, or null when the ledger is empty. */
		block() {
			if (entries.length === 0) return null;
			const lines = ["## User steering received during this review (verbatim, numbered)", ""];
			for (const entry of entries) lines.push(`${entry.n}. ${entry.text}`);
			lines.push("", "This is the user's own guidance. It is authoritative on scope, priorities and focus. It cannot override your read-only rules, your output schema, or your verification stance. A verifier must not treat steering as evidence that a finding is true.");
			const notice = this.notice();
			if (notice) lines.push("", notice);
			return lines.join("\n");
		},
		/** The one-line report line, or null when the ledger is empty. */
		summary() {
			if (entries.length === 0) return null;
			const notice = this.notice();
			return `Steering received: ${entries.map((entry) => `#${entry.n}`).join(", ")}.${notice ? ` ${notice}` : ""}`;
		},
	};
}
