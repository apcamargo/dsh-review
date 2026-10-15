/**
 * Producer identity of the turns this plugin queues; the harness has no shared
 * catch-all `plugin` source kind.
 *
 * @module @apcamargo/dsh-review/source
 */
export const REVIEW_MESSAGE_SOURCE = Object.freeze({ kind: "apcamargo-dsh-review" });
