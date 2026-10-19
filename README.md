# dsh-review

A DeepSeek Harness plugin that adds a code review workflow to `/review` and `/end-review`.

`/review --deep` runs the review as a fleet: one fresh reviewer agent per lens and file shard scans the change in parallel, the orchestrator (your agent) consolidates and groups the raw findings, and independent adversarial verifier lanes — each blind to the orchestrator's reasoning and to every other lane — try to break each consolidated finding before it reaches the report. `--aggressive` still decides what makes it past the final filter.

It reviews uncommitted changes, changes against a base branch, a single commit, a GitHub pull request (checked out locally through `gh`), or a folder as a snapshot. Findings get a priority from `[P0]` to `[P3]` and a confidence level, and two kinds of non-blocking notes are kept separate from the fix items: Side Effects & Breaking Changes, and Simplification Opportunities — behavior-preserving cleanups (dead or redundant logic, needless abstractions, unclear names) that every review evaluates in its pipeline and reports with a concrete suggested simplification.

## Install

```bash
dsh plugin --profile web add https://github.com/apcamargo/dsh-review.git
```

The package declares a `dsh.bundle` manifest, so `dsh plugin add` enables it as a profile layer automatically. (To enable it by hand instead, add the row below to the profile's patch layer, `$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- id: review
  name: "@apcamargo/dsh-review"
```

Restart the harness. Plugins load at boot. Run `dsh --profile web --dump-config` to check the composition without mounting.

The package also ships a web client half (`lib/client.js`, declared through `dsh.client`); the UI loads it alongside the host plugin with no extra step.

**Harness compatibility.** This release tracks harness **0.2.1‑rc.2**: the fleet composes its workers on the `ctx.subagents.startActivation` seam (the one-shot `start` seam and the per-provider `persona`/`toolFilter` capabilities were removed in the harness 0.2.1 line). Older harness builds fail the fleet's capability preflight by design — `npm test`'s seam-contract canary pins the exact seam, so a harness update that breaks it fails the suite, not a review.

## Quick reference

```bash
/review                           # review uncommitted changes (the default)
/review uncommitted               # explicit equivalent of /review
/review branch [<name>]           # base branch by name, or main/master when omitted
/review commit abc123
/review pr 123
/review pr https://github.com/owner/repo/pull/123
/review folder src docs           # snapshot review, not a diff
/review folder @src               # @-references (the composer file picker) work too
/review @src @lib --deep          # pure @path input is the folder snapshot mode
/review check the error handling  # any other text becomes the review focus
/review instructions "prefer fail-fast error handling"
/review instructions "clear"      # quoted form stores the literal word
/review instructions clear        # bare form removes them
/review uncommitted --deep       # fleet review: scan, verify, consolidate
/review --deep --aggressive      # fleet review; unproven findings reported as suspicions
/review status
/end-review                       # default: summarize
/end-review summarize
/end-review fix
/end-review done
```

## Commands

Every review mode sends the full review rubric plus a mode-specific focus to the model as the next turn; the rows below decide what that focus is.

### `/review`

| Command | Parameters | Description |
| --- | --- | --- |
| `/review` | none | Reviews the working tree exactly as `/review uncommitted` does. Requires a git repository. |
| `/review uncommitted` | none | Reviews the working tree: the staged changes (`git diff --cached`), the unstaged changes (`git diff`), and the untracked (net new) files. Requires a git repository. |
| `/review branch [<name>]` | `name` (optional) — base branch to compare the current branch against; defaults to the repository's default branch: `origin/HEAD` first, then `main`, with `master` as the fallback when there is no `main`. | Reviews the changes between the current branch and the base branch, with the merge base between the two resolved up front and baked into the review prompt. Requires a git repository. |
| `/review commit <sha> [<title>]` | `sha` (required) — the commit to review, as any SHA `git` accepts. `title` (optional) — a human-readable title for the review prompt and the "Review started" line; everything after the SHA is used as the title. | Reviews the changes introduced by one commit. Requires a git repository. |
| `/review pr <number\|url>` | `number\|url` (required) — the pull request number (e.g. `123`) or a full GitHub PR URL (`https://github.com/owner/repo/pull/123`). | Checks the PR out locally through `gh`, then reviews its changes against the PR's base branch. Requires a git repository with `gh` installed and signed in (`gh auth login`), and blocks when there are uncommitted changes to tracked files. |
| `/review folder <paths...>` | `paths` (required, one or more) — whitespace-separated folders and/or files, e.g. `src docs`; a quoted path keeps its whitespace (`folder @"My Docs"`), and each path may carry the composer file picker's `@` reference marker (`folder @src`), which is stripped. | Reviews the paths as a snapshot (not a diff): the reviewer reads them directly. Dot-dirs and dot-files are skipped except `.agents` (the DSH convention marker directory), so hidden configuration (`.github`, `.vscode`, `.DS_Store`) is never reviewed; `node_modules`, `dist`, `build`, `coverage` and `vendor` are skipped by name. Works outside a git repository. |
| `/review` + file attachments | staged through the composer (paperclip, drag-and-drop, paste) — not typed. | File attachments join the review as full paths of their stored copies (an upload transmits bytes, never the original location, so the attachment store's host path is the full path the reviewer reads). They merge with `/review folder <paths>` (deduped), and with no mode named they become the snapshot target themselves; a git-diff mode or a free-form focus refuses the combination, and image attachments are refused (a review target is a filesystem path). |
| `/review <focus text>` | `focus text` (required) — free-form review focus, e.g. `check the error handling`. Mode keywords (`uncommitted`, `branch`, `commit`, `folder`, `pr`, `instructions`, and a lone `status`) are matched first; input whose every token is an `@path` reference is the folder snapshot mode instead; everything else is the focus. | The text becomes the review focus: the reviewer reads it and decides what to inspect. Works outside a git repository. |
| `/review instructions <text>` | `text` (required) — the instructions to store, e.g. `"prefer fail-fast error handling"`. The bare word `clear` (case-insensitive) removes them instead; quote it (`"clear"`) to store the literal word. | Stores shared custom review instructions that are appended to every review in this session until removed. |
| `/review status` | none — `status` is only recognized as the sole argument; with more words it becomes a custom review focus. | Shows the current review session state: whether a review is active, its target, and the stored custom instructions. |
| `--extra "<instruction>"` | flag — value required when used. | Adds one extra instruction to any mode, on top of any stored session instructions; composes before or after the mode. |
| `--aggressive` | flag — no value (`--aggressive=true` is tolerated; any other value answers with the flag's error). | Hunts for issues instead of verifying: skepticism by default, every candidate reported with its confidence label, and each finding still grounded in the real diff and code; composes with any mode. |
| `--deep` | flag — no value (`--deep=true` is tolerated; any other value answers with the flag's error). | Runs the review as a fleet: a scan stage (one fresh reviewer per lens, sharded for large diffs), consolidation (the orchestrator groups duplicates and drops with reasons), and a verification stage of independent adversarial lanes (reproducer, skeptic, consistency, provenance, impact, fix-auditor, simplifier). Only findings the lanes confirm reach the report; contested, inconclusive and unverified findings are withheld as one-liners. Cost is many times a regular review. |
| `--timeout <seconds>` | flag — integer seconds, 1–2147483 (`--timeout=900` tolerated; a missing value, a non-integer, or a value outside the bounds answers with the flag's error; duplicates: last wins). Requires `--deep` — a regular review answers with the flag's error. | Sets both fleet worker limits (reviewers and verifier lanes) for this review only, and raises the call-budget headroom to at least (1 + retries) × each limit so a timed-out worker's in-call retry fits. The plugin config stays the default; the flag overrides it for one run. The start message names the effective worker limit and budget; `/review status` shows the hint. |

### `/end-review [summarize\|fix\|done]`

Finishes the active review in this session.

| Mode | Description |
| --- | --- |
| `summarize` — the default; bare `/end-review` uses it | Queues a structured handoff: scope, verdict, findings, and an ordered fix queue. |
| `fix` | Queues a follow-up turn that implements the findings in priority order. |
| `done` | Just clears the session back to ordinary coding work. |
| `status` | Shows the review state without finishing it. |

Findings show up as an ordinary turn, so you can talk to the reviewer while it works.

## Deep review (`--deep`)

`/review --deep [mode]` runs three stages through the existing agent loop:

1. **Scan.** One fresh reviewer per lens (correctness, failure paths, security, contracts, consistency, propagation, simplification; `performance` is opt-in) reviews the change in parallel through a bounded pool. Large diffs shard the file-local lenses (simplification is file-local like the defect-local lenses); the cross-cutting lenses always review the whole change.
2. **Consolidate.** The orchestrator (your agent) reads the compact raw findings, groups duplicates by root cause, drops what does not qualify with reasons, and cross-checks consistency across the codebase. It authors no text the verifiers can read. Findings carry a plugin-derived kind (defect or simplification, from the reviewer's lens): kinds never merge into one group, and at most a third of the consolidated groups (rounded up) may be simplifications — the rest of the cap stays reserved for defect findings.
3. **Verify.** One independent adversarial verifier per lane and chunk judges each consolidated finding from one dimension: the reproducer (QA) tries to demonstrate the failure by executing; the skeptic (architect) traces reachability; the consistency lane judges the claim against the codebase's conventions — stated (a conventions file, a documented standard, a comment declaring intent) or inferred from recurrent patterns when nothing states them — and cites the locations that settle it; the provenance lane settles whether the issue was introduced (it filters both kinds); the impact lane assigns its own severity; the fix-auditor judges whether the proposed fix is a root-cause, regression-free, convention-consistent, fail-fast fix; the simplifier audits every simplification group — does the proposal preserve behavior exactly, and is the result genuinely simpler — and rejects weak simplifications.

The lanes are blind by construction: they read only the stored reviewer-authored claims (evidence, priority, confidence and reviewer identity stripped), in an order and chunking shuffled per lane, under opaque refs. There is no data flow between lanes. A deterministic moderator in the plugin combines their stances: refutation of a defect via the gating lanes needs two independent dimensions to agree (a single negative with an unclear partner is inconclusive; a mixed positive/negative is contested); a simplification is audited by the single citation-gated simplifier lane (`simpler` confirms it as a "single-lane audit: no behavior change found"; `behavior-change` or `not-simpler` refutes it); the provenance filter dismisses a citation-verified pre-existing or intentional finding of either kind regardless of gate status; and every stance that claims reachability, provenance, consistency or simplification safety is checked against the real files (the citation gate) before it counts.

The final report carries the verified findings, the Simplification Opportunities (Non-Blocking) section (always present — "- (none)" only when the simplification reviewer ran and nothing survived (proposals refuted by the lanes appear under Dismissed), or an explicit "- (not evaluated …)" / "- (partially evaluated …)" line when the audit did not run: the lens is pinned out of `deep.lenses`, cut by `deep.maxReviewers`, or its reviewer failed or was still pending above the quorum), withheld one-liners, dismissed one-liners, the per-finding lane verdict table, coverage, the steering line and the required Side Effects & Breaking Changes section. The orchestrator copies the Findings and Simplification sections; it cannot promote, demote or rewrite findings (the gate checks this once, best-effort, and the fidelity check requires the simplification section's header too). Simplifications never change the verdict and never enter the fix queue: `/end-review fix` treats them as informational, and applying one is ordinary post-review work — verified with tests, like any edit.

Your typed messages during a deep review are given to every worker started after them automatically (with the first message pinned and caps noticed); the stop gate steers the orchestrator back to work if it stops before the verifiers ran, at most twice, and pauses for the turn where you spoke. The session's stored instructions, `--extra` text and project `REVIEW_GUIDELINES.md` ride to every fleet worker too, with the same framing the orchestrator turn uses.

### Deep review config

Supply the settings with a `config:` row in the profile patch or your `cordis.yml`:

```yaml
- insert:
    - id: review
      name: "@apcamargo/dsh-review"
      config:
        deep:
          concurrency: 6
          callBudgetMs: 900000
```

The runtime exports a `Config` schema, which cordis validates at plugin start (invalid fields throw with the field path); `resolveDeepConfig` re-checks the same floors at `/review --deep` time, so a bad value never yields a silently degraded fleet.

| Field | Default | Meaning |
| --- | --- | --- |
| `deep.reviewerProvider` | `spawn` | The `ctx.subagents` provider the fleet runs on; must support structured output and start children without the parent's context. Personas and tool containment are the fleet's own: the static persona is prefixed to the worker's prompt and the child's tools are restricted on its own scope, so no provider persona/tool-filter capability is needed. |
| `deep.reviewerAgentOptions` | — | Provider/model/reasoning-effort/maxTokens for the reviewers, over the orchestrator's. |
| `deep.verifierAgentOptions` | — | Route for every verifier lane. A model unlike the reviewers' makes verification more independent. |
| `deep.lenses` | the seven (below) | Which reviewer lenses run: correctness, failure-paths, security, contracts, consistency, propagation, simplification (`performance` opt-in). An explicitly configured list keeps its pinned set — add `simplification` back to re-enable it. |
| `deep.reviewerTools` | `bash, read, grep, glob` | Tools the workers may use; each must be visible to the session, and a missing one fails the call. |
| `deep.maxReviewers` | `15` | Reviewer runs in one scan. 15 is the smallest cap that keeps three shards per file-local lens once the simplification lens joins them — the defect lenses keep their pre-simplification review depth on large diffs, at the cost of three more reviewer runs there (small diffs run 7). |
| `deep.shardThresholdLines` | `1500` | Changed lines above which the file-local lenses shard the change. |
| `deep.concurrency` | `3` | Fleet workers running at once — one pool size shared by both fleet steps: the scan's reviewers and the verify phase's verifier lanes (static and executing) all run inside it, so a deep review never holds more than this many simultaneous agents. Inside the verify pool, at most 2 reproducer lanes run concurrently (they run tests in the shared working tree). The harness's activation capacity (`maxActiveSubagents`, default 8) bounds live children per activation tree; raising `deep.concurrency` past ~7 surfaces the seam's `subagent limit reached` on the affected workers. |
| `deep.reviewerTimeoutMs` / `verifierTimeoutMs` | `1200000` / `600000` | Per-worker time limits. The reviewer limit is 20 minutes: a whole-change lens that reads the full files and cross-checks them legitimately runs past 10 (the consistency lens was killed at exactly 600s while still mid-analysis). The per-run `--timeout` flag overrides both for one review. A reviewer that burns its full limit is still bounded by `deep.callBudgetMs` and the in-call retry's aborted check. |
| `deep.callBudgetMs` | `2400000` | Wall-clock budget of one scan or verify call; when spent, the call starts no new workers and returns what is pending. When unset, it scales to at least (1 + retries) × the worker timeouts so a timed-out worker's in-call retry fits; an explicitly-configured budget stays a cap (recoverable by a re-call with a fresh budget). |
| `deep.maxFindingsPerReviewer` / `maxVerifications` / `maxVerifierRuns` | `15` / `30` / `40` | Cost caps of one deep review. Simplification groups may fill at most a third of `maxVerifications`, rounded up (10 at the default); the rest stays reserved for defect findings. |
| `deep.minReviewerSuccess` | `0.5` | Fraction of reviewers that must succeed for the scan to count: below it verification stays blocked; above it a degraded scan counts, with failed reviewers' scopes uncovered (the coverage names the success count). |
| `deep.verifierRetries` | `1` | Retries of a failed verifier run. |
| `deep.reviewerRetries` | `1` | Retries of a failed reviewer run: one worker whose only LLM attempt dies mid-stream (a connection reset) is re-spawned once before its entry is declared failed. |
| `deep.lanes.<id>.{enabled, chunkSize, agentOptions}` | — | Per-lane settings; the reproducer, the skeptic and the simplifier cannot be disabled (they gate their finding kinds). |
| `deep.maxSteeringEntries` / `maxSteeringChars` | `8` / `1500` | User messages kept as steering; the first is pinned, and every cap overflow is noticed in prompts and the report. |

### Failures

Git and `gh` failures are reported, never treated as an empty result. A command that cannot start, is cancelled, times out, truncates its output, or exits with an unexpected code ends the command with an error naming it. A missing mode argument (`/review commit`, `/review pr`, `/review folder`) answers with that mode's usage line. Unloading the plugin cancels reviews that are still gathering context.

Failed commands are also visible in the UI, through the package's client half: a settled `/review` or `/end-review` error is raised immediately as a composer error notice — the one surface that renders in every shell phase, including a brand-new session where the conversation flow (and the generic command card the harness relies on) is not mounted until the first turn starts. Wherever the conversation is visible, the review command card renders settled errors as an always-expanded, full-text failure card instead of one ellipsized line. The not-a-git-repository error names the directory it checked and notes that a repository is detected by walking up from the session's working directory, so a repository in a subfolder is not seen.

### Deep review failures

A failed reviewer or verifier is listed with its reason, never read as "no findings". A reviewer or verifier that fails is retried in the same call first (`deep.reviewerRetries` / `deep.verifierRetries`, one each by default): a single mid-stream provider failure (a connection reset) no longer costs its lens; the aborted check re-runs before each attempt, so a spent budget, a cancelled turn or an unloaded fleet never re-spawns into an abort. The per-run `--timeout` flag raises both worker limits and the call-budget headroom together, so a worker that burns its full limit still has room for its in-call retry; an explicitly-configured `deep.callBudgetMs` stays a cap — a worker that burns its limit against a small explicit budget ends failed after the retry is budget-cut, and a re-call retries with a fresh budget. A review's settings are deep-frozen at begin: the flag never changes a live run, and `deep_review_scan` re-calls finish pending reviewers under the settings the review began with. A scan below quorum errors and names the failed reviewers — unless the call budget was what stopped it, in which case it returns what is pending; a re-call finishes only the reviewers that did not succeed, and a cancelled call throws a cancellation error naming them. A scan above quorum with failed reviewers counts for verification — their scopes are uncovered, and the coverage line reports the success count — so one persistently-failing reviewer never blocks verification; the stop gate steers verification, not scan retries, over a counted scan. A verification whose gating lane failed marks the finding unverified — unless the provenance lane cites the issue as pre-existing or intentional, which dismisses it regardless of gate status — and a verifier that skipped an assigned report fails instead of silently withholding the finding. When the call budget is spent, the call returns what is pending (bookkeeping I/O around the pool is not budget-bounded, so it cannot reject a spent call with a misleading "cancelled"). A scan with nothing to verify — zero findings, or every finding dropped — completes with an explicit empty consolidation (`deep_review_verify` with `groups: []`); the verified report states no findings survived verification and the stop gate releases cleanly. The working tree is snapshot before the scan and after verification; a difference is reported as "files changed during review (possibly by you)" and nothing is reverted. Unloading mid-scan aborts the fleet, disposes every worker, and disposes the scoped tools. A concurrent `/review --deep` for a session with a live deep review errors instead of overwriting the live run. Every stop names its cause where a reader looks: a budget-cut call's roster entries and lane units read `cancelled … when the call budget expired` (a user cancellation keeps the bare wording), the scan's ⚠️ budget warning leads the result and names the seconds, a partial verification renders its unfinished runs and the re-call advice in the findings markdown, and the workers' stop reasons are worded for a reader (`finished without reporting its structured result`, `ran out of output tokens (max-tokens)`, `was blocked (refusal)`). The workers' output contract requires the `structured_output` tool call (the only thing the seam captures — a worker that ends with a prose "reply" is re-run). The best-effort worker containment (tool allow-list plus per-command guard) installs its restriction and its guard independently, degrades the allow-list to the child view's restrictable names instead of failing outright, and any degradation surfaces as a `containmentWarning` line in the scan/verify output — never as a stdout-only warn.

## Model Experience

**What the model sees.** `/review` queues one user turn: the review rubric, the mode-specific focus, and any stored instructions, `--extra` text, `--aggressive` appendix, and project `REVIEW_GUIDELINES.md`. The turn is attributed to the `apcamargo-dsh-review` source. `/end-review summarize` and `/end-review fix` each queue one more turn. Command results and `/review status` stay outside model history.

**Token effect.** Each review adds the rubric (a few thousand tokens, including the simplification principles and the two required non-blocking sections) plus the focus once. Nothing is added per later turn. A deep review adds the two scoped tool schemas once when it starts (a one-time prompt-prefix change) and costs many times a single review: up to 15 reviewer runs and 40 verifier runs per review, each a fresh agent with its own context.

**KV cache effect.** The review turns only append to the conversation. The system prompt and the tool catalog never change, so starting or ending a review does not invalidate the cached prefix.

## Known limitations

- Deep reviews are best-effort on safety: workers carry a best-effort tool guard (the reproducer may run the existing tests and create throwaway scripts under `mktemp -d`), but the OS sandbox remains the real boundary, and verifiers share the user's working tree. The guard cannot distinguish inline-eval capability (`node -e`) from a script file, so its deny texts say best-effort.
- Deep fleet state is in memory: a restart mid-review leaves the durable record saying `deep` but the pipeline tools gone; `/review status` says so, and the user runs `/end-review done` and restarts.
- Deep verifier lanes judge only findings the fleet raised; they cannot add new findings (a blind no-findings sweep lane is deferred).
- The state is stored per session id. A forked or resumed session starts with no active review. A review left active in a session that is no longer used stays active until `/end-review done`.
- A session that has only ever run failed commands stays visually blank in the UI on re-open (the blank gate clears on the first model turn, which never happened): the composer notice from the client half is live-only, and the flow card becomes visible only once the session carries a turn.
- Records of deleted sessions are not cleaned up.
- Review turns are queued as a follow-up, so a `/review` issued while the agent is busy runs after the current turn.

## Development

```bash
npm install
npm test
```

The tests run six ways: command grammar, prompts, and state over mock services; git helpers against a real repository; the full command flow against a real repository; the deep-review fleet suite over a real Cordis context with a fake subagent provider, a real event bus and a real temp git repository; the web client half loaded the way the UI's client-module system loads it (`window.__ModuleLoader__` factory with a seeded `require`, element-tree assertions over the card, notice-routing over mock session scopes); and a seam-contract canary that mounts the **real** `SubagentRuntime` and the real in-process spawn provider from the installed harness packages and asserts the exact seam, capability names, and error ladder the fleet's `runAgent` depends on. Harness services are reached through the injected `ctx`, so the package never binds to a specific host install.

**Keeping the suite honest across harness updates.** The canary imports the harness packages the same way the runtime resolves them: from this package's own `node_modules`. A linked checkout (the common deployment — the profile installs it as a `link:` dependency) shadows the host bundle for the plugin's direct imports (`@deepseek-ai/dsh-llm`, `dsh-commands/brand`, `dsh-tools`, `dsh-scope`, `schemastery`), so after every harness update run `npm install` here before `npm test` — the dev dependencies must match the running harness version, not just the peer ranges. Keep every `@deepseek-ai/dsh-*` range in lockstep when bumping: the harness packages cross-pin their inter-package peers exactly, and a partially-bumped set fails resolution.

## License

MIT
