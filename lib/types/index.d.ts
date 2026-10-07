/**
 * Public type surface of `@apcamargo/dsh-review`.
 *
 * The runtime is plain ESM JavaScript; these declarations describe the plugin
 * entry, command grammar, and state helpers for type-only consumers.
 * @module @apcamargo/dsh-review
 */
import type { Context } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		/** The review turns this plugin queues; the harness has no shared plugin source kind. */
		"apcamargo-dsh-review": { readonly kind: "apcamargo-dsh-review" };
	}
}

/** Cordis plugin name. */
export declare const name = "review";
/** Required services: the command registry, process execution, and durable plugin state. */
export declare const inject: readonly ["commands", "subprocess", "storageDomain"];
/**
 * Open the review state domain and register the `/review` and `/end-review`
 * commands. Unloading cancels the commands still running, waits for them to
 * settle, then closes the domain.
 */
export declare function apply(ctx: Context): Promise<void>;

/** Resolved review target kinds. */
export type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string; mergeBase?: string | undefined }
	| { type: "commit"; sha: string; title?: string | undefined }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; title: string; mergeBase?: string | undefined }
	| { type: "folder"; paths: string[] }
	| { type: "custom"; focus: string };

/** One session's durable review state record. */
export interface ReviewSessionRecord {
	/** Whether a review session is currently active. */
	active: boolean;
	/** Review target kind: `uncommitted`, `baseBranch`, `commit`, `pullRequest`, `folder`, or `custom`. */
	targetKind?: string | undefined;
	/** Human-readable review target description. */
	target?: string | undefined;
	/** ISO timestamp when the review started. */
	startedAt?: string | undefined;
	/** Shared custom review instructions. */
	customInstructions?: string | undefined;
}
