/**
 * Durable per-session review state over the harness storage domain layer
 * (`ctx.storage.domain`): schema-validated KV records in the `review` domain,
 * keyed by session id, persisted under `$DSH_HOME/storages`.
 *
 * Harness session logs refuse unknown event types unless the harness build
 * knows them, so a third-party plugin must not append custom session events.
 * Storage-domain records are plugin-owned and independent of session logs.
 *
 * @module @apcamargo/dsh-review/state
 */

import { z } from "zod";

/** One session's durable review state. */
const ReviewSessionRecordSchema = z.object({
	/** Whether a review session is currently active. */
	active: z.boolean(),
	/** Review target kind: `uncommitted`, `baseBranch`, `commit`, `pullRequest`, or `folder`. */
	targetKind: z.string().optional(),
	/** Human-readable review target description. */
	target: z.string().optional(),
	/** ISO timestamp when the review started. */
	startedAt: z.string().optional(),
	/** Shared custom review instructions applied to every review in this session. */
	customInstructions: z.string().optional(),
});

/**
 * The `review` domain declaration: one `sessions` table keyed by session id.
 * Declared literally (the exact shape `domainTable`/`defineDomain` produce);
 * the storage-domain facility validates the spec and every stored record at
 * the durable read boundary.
 */
const REVIEW_DOMAIN_SPEC = {
	name: "review",
	version: 1,
	tables: {
		sessions: { valueSchema: ReviewSessionRecordSchema },
	},
};

/** The value used before a session's first write. */
const EMPTY_RECORD = Object.freeze({ active: false });

/**
 * Open the review domain. The caller owns the handle and closes it on
 * teardown (typically as its own effect disposer).
 * @param ctx - context carrying the `storageDomain` facility.
 * @returns the opened domain handle.
 */
async function openReviewDomain(ctx) {
	return ctx.storageDomain.open(REVIEW_DOMAIN_SPEC);
}

/**
 * Read one session's record, or the empty default before its first write.
 * @param domain - opened review domain.
 * @param sessionId - session id the record belongs to.
 */
function getSessionRecord(domain, sessionId) {
	return domain.table("sessions").get(sessionId) ?? EMPTY_RECORD;
}

/** Trimmed custom instructions for one session, or undefined. */
function getCustomInstructions(domain, sessionId) {
	const instructions = getSessionRecord(domain, sessionId).customInstructions?.trim();
	return instructions || undefined;
}

/**
 * Atomic read-modify-write of one session's record on the domain's write
 * chain: `transform` sees the record current at its queue slot, so concurrent
 * commands for one session never interleave — every merge starts from the
 * freshest committed state. A record never written materializes first
 * (`update` rejects with the stable `missing-key` code), then the same
 * transform re-runs on the chain, so it re-derives its fields from whatever
 * committed state it sees.
 */
async function updateSessionRecord(domain, sessionId, transform) {
	const table = domain.table("sessions");
	try {
		return await table.update(sessionId, transform);
	} catch (error) {
		if (error?.code !== "missing-key") throw error;
		await table.put(sessionId, { ...EMPTY_RECORD });
		return table.update(sessionId, transform);
	}
}

/**
 * Record an active review for one session, keeping custom instructions.
 * @returns resolution after durability.
 */
function setActiveReview(domain, sessionId, target) {
	return updateSessionRecord(domain, sessionId, (current) => ({
		...current,
		active: true,
		targetKind: target.type,
		target: target.description,
		startedAt: new Date().toISOString(),
	}));
}

/**
 * Mark one session's review finished: drop the finished review's run state
 * (targetKind/target/startedAt) so the durable record agrees with the derived
 * "no review active" status, keeping session-scoped custom instructions.
 * @returns resolution after durability.
 */
function clearActiveReview(domain, sessionId) {
	return updateSessionRecord(domain, sessionId, (current) => ({
		active: false,
		customInstructions: current.customInstructions,
	}));
}

/**
 * Set (or clear) one session's shared custom review instructions.
 * @returns resolution after durability.
 */
function setCustomInstructions(domain, sessionId, instructions) {
	const trimmed = instructions?.trim() || undefined;
	return updateSessionRecord(domain, sessionId, (current) => ({
		...current,
		customInstructions: trimmed,
	}));
}

export {
	REVIEW_DOMAIN_SPEC,
	openReviewDomain,
	getSessionRecord,
	getCustomInstructions,
	setActiveReview,
	clearActiveReview,
	setCustomInstructions,
};
