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
 * settle, then closes the domain. Only `config.deep` is read; the runtime
 * exports `Config` for the harness's schema validation.
 */
export declare function apply(ctx: Context, config?: { deep?: DeepConfig | undefined } | undefined): Promise<void>;

/** The plugin's config schema (schemastery), validated by cordis at start. */
export declare const Config: unknown;

/** Resolved review target kinds. */
export type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string; mergeBase?: string | undefined }
	| { type: "commit"; sha: string; title?: string | undefined }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; title: string; mergeBase?: string | undefined }
	| { type: "path"; paths: string[] }
	| { type: "custom"; focus: string };

/** Deep-review settings; every field is deployment config under `deep`. */
export interface DeepConfig {
	/** The `ctx.subagents` provider the fleet runs on (default `spawn`). */
	reviewerProvider?: string | undefined;
	/** Agent options for the reviewers, over the orchestrator's. */
	reviewerAgentOptions?: DeepAgentOptions | undefined;
	/** Agent options for every verifier lane, over the orchestrator's. */
	verifierAgentOptions?: DeepAgentOptions | undefined;
	/** Reviewer lenses to run; `simplification` is on by default and `performance` is opt-in. An explicitly configured list keeps its pinned set. */
	lenses?: string[] | undefined;
	/** Tools the workers may use; checked against the orchestrator's tools. */
	reviewerTools?: string[] | undefined;
	maxReviewers?: number | undefined;
	shardThresholdLines?: number | undefined;
	/** Fleet workers running at once — the scan's reviewers and the verify phase's verifier lanes share this one pool size; at most 2 reproducer lanes run concurrently inside the verify pool. At review start the effective value (this setting or the per-run `--concurrency` flag) is capped to the harness's live active-subagent capacity, read at that moment. */
	concurrency?: number | undefined;
	reviewerTimeoutMs?: number | undefined;
	verifierTimeoutMs?: number | undefined;
	callBudgetMs?: number | undefined;
	maxFindingsPerReviewer?: number | undefined;
	maxVerifications?: number | undefined;
	maxVerifierRuns?: number | undefined;
	minReviewerSuccess?: number | undefined;
	verifierRetries?: number | undefined;
	/** Per-lane settings keyed by lane id. */
	lanes?: Record<string, { enabled?: boolean | undefined; chunkSize?: number | undefined; agentOptions?: DeepAgentOptions | undefined }> | undefined;
	maxSteeringEntries?: number | undefined;
	maxSteeringChars?: number | undefined;
}

/** One worker's provider/model route overrides. */
export interface DeepAgentOptions {
	provider?: string | undefined;
	model?: string | undefined;
	reasoningEffort?: string | undefined;
	maxTokens?: number | undefined;
}

/** One session's durable review state record. */
export interface ReviewSessionRecord {
	/** Whether a review session is currently active. */
	active: boolean;
	/** Review target kind: `uncommitted`, `baseBranch`, `commit`, `pullRequest`, `path`, or `custom`. */
	targetKind?: string | undefined;
	/** Human-readable review target description. */
	target?: string | undefined;
	/** ISO timestamp when the review started. */
	startedAt?: string | undefined;
	/** Shared custom review instructions. */
	customInstructions?: string | undefined;
	/** Whether the active review is a `--deep` fleet review. */
	deep?: boolean | undefined;
}
