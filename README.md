# dsh-review

A DeepSeek Harness plugin that adds a code review workflow to `/review` and `/end-review`.

`/review --deep` runs the review as a fleet: one fresh reviewer per lens and file shard scans the change in parallel, then independent adversarial verifier lanes, each blind to the orchestrator and to every other lane, try to break every finding before it reaches the report. With `--aggressive`, unproven findings are reported as suspicions instead of being withheld.

It reviews uncommitted changes, changes against a base branch, a single commit, a GitHub pull request (checked out locally through `gh`), or a set of paths as a snapshot. Findings get a priority from `[P0]` to `[P3]` and a confidence level. Two kinds of non-blocking notes are kept separate from the fix items: Side Effects & Breaking Changes, and Simplification Opportunities, behavior-preserving cleanups reported with a concrete suggested change.

## Install

```bash
dsh plugin --profile web add https://github.com/apcamargo/dsh-review.git
```

The package declares a `dsh.bundle` manifest, so `dsh plugin add` enables it as a profile layer automatically. To enable it by hand instead, add the row below to the profile's patch layer, `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: review
  name: "@apcamargo/dsh-review"
```

Restart the harness; plugins load at boot. `dsh --profile web --dump-config` shows the composition.

This release tracks harness 0.2.1-rc.2. Older builds fail the fleet's capability preflight by design.

## Quick reference

```bash
/review                           # review uncommitted changes (the default)
/review branch [<name>]           # base branch by name, or main/master when omitted
/review commit abc123
/review pr 123                    # or a full GitHub PR URL
/review path src docs             # snapshot review, not a diff; @-references work too
/review check the error handling  # any other text becomes the review focus
/review instructions "prefer fail-fast error handling"   # stored for the session; `clear` removes them
/review --deep                    # fleet review: scan, verify, consolidate
/review --deep --aggressive       # fleet review; unproven findings reported as suspicions
/review status
/end-review                       # default: summarize
/end-review fix
/end-review done
```

## Commands

Diff modes require a git repository.

| Command | Description |
| --- | --- |
| `/review` or `/review uncommitted` | Reviews the working tree: staged, unstaged, and untracked files. |
| `/review branch [<name>]` | Reviews the changes against a base branch: the named one, or the repository's default. |
| `/review commit <sha> [<title>]` | Reviews one commit; text after the SHA becomes the review title. |
| `/review pr <number\|url>` | Checks the PR out locally through `gh` and reviews it against its base branch. Needs `gh` installed and signed in, and blocks on uncommitted changes to tracked files. |
| `/review path <paths...>` | Reviews the paths as a snapshot, not a diff. Skips hidden files (except `.agents`) and `node_modules`, `dist`, `build`, `coverage`, `vendor`. |
| `/review <focus text>` | Any other text becomes the review focus; the reviewer decides what to inspect. |
| `/review instructions <text>` | Stores custom instructions appended to every review this session. The bare word `clear` removes them; quote it to store the literal word. |
| `/review status` | Shows whether a review is active, its target, and the stored instructions. |

Composer file attachments become snapshot targets: they merge with `/review path`, and are refused in diff modes, with free-form focus text, and as images.

| Flag | Description |
| --- | --- |
| `--extra "<instruction>"` | Adds one instruction to any mode, on top of stored session instructions. |
| `--aggressive` | Reports candidates instead of withholding them: every finding keeps a confidence label and stays grounded in the real diff. Composes with any mode. |
| `--deep` | Runs the fleet review, described below. |
| `--timeout <seconds>` | With `--deep`, sets both fleet worker time limits for this run. |
| `--concurrency <workers>` | With `--deep`, sets the fleet pool size for this run; capped to the harness's active-subagent capacity. |

### `/end-review [summarize|fix|done]`

- `summarize` (the default) queues a structured handoff: scope, verdict, findings, and an ordered fix queue.
- `fix` queues a follow-up turn that implements the findings in priority order.
- `done` clears the session back to ordinary coding work.
- `status` shows the review state without finishing it.

Findings show up as an ordinary turn, so you can talk to the reviewer while it works.

## Deep review (`--deep`)

Deep review costs many times a regular review and takes much longer. `/review --deep [mode]` runs three stages through the existing agent loop:

1. **Scan.** One fresh reviewer per lens (correctness, failure paths, security, contracts, consistency, propagation, simplification; `performance` opt-in) reviews the change in parallel; large diffs shard the file-local lenses.
2. **Consolidate.** The orchestrator groups duplicate findings by root cause and drops what does not qualify.
3. **Verify.** Independent adversarial verifier lanes (reproducer, skeptic, consistency, provenance, impact, fix-auditor, simplifier) judge each finding from one dimension. The lanes read only the stored claims, stripped of reviewer identity and shuffled per lane, so no lane can see another's reasoning.

Only findings the lanes confirm reach the report; contested, inconclusive and unverified ones are withheld as one-liners, and the provenance lane dismisses findings that predate the change or are intentional. The orchestrator copies the verified findings into the report and cannot rewrite them; it also adds a per-finding lane verdict table, coverage, and the Side Effects & Breaking Changes and Simplification Opportunities sections. Simplifications never change the verdict and never enter the fix queue: `/end-review fix` treats them as informational.

Your typed messages during a deep review reach every worker started after them, and the session's stored instructions, `--extra` text and project `REVIEW_GUIDELINES.md` ride to every fleet worker.

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

Config is validated when the plugin starts and re-checked at `/review --deep` time, so a bad value fails loudly.

| Field | Default | Meaning |
| --- | --- | --- |
| `deep.reviewerProvider` | `spawn` | The `ctx.subagents` provider the fleet runs on. |
| `deep.reviewerAgentOptions` / `verifierAgentOptions` | none | Model and route for reviewers and verifier lanes; a verifier model unlike the reviewers' makes verification more independent. |
| `deep.lenses` | all seven | Which reviewer lenses run. |
| `deep.reviewerTools` | `bash, read, grep, glob` | Tools the workers may use. |
| `deep.maxReviewers` | `15` | Reviewer runs in one scan. |
| `deep.shardThresholdLines` | `1500` | Changed lines above which the file-local lenses shard. |
| `deep.concurrency` | `3` | Fleet workers running at once, shared by scan and verify; capped to the harness's active-subagent capacity. |
| `deep.reviewerTimeoutMs` / `verifierTimeoutMs` | `1200000` / `600000` | Per-worker time limits; the `--timeout` flag overrides both for one review. |
| `deep.callBudgetMs` | `2400000` | Wall-clock budget of one scan or verify call; an explicit value is a hard cap. |
| `deep.maxFindingsPerReviewer` / `maxVerifications` / `maxVerifierRuns` | `15` / `30` / `40` | Cost caps of one deep review. |
| `deep.minReviewerSuccess` | `0.5` | Fraction of reviewers that must succeed for the scan to count. |
| `deep.reviewerRetries` / `verifierRetries` | `1` | Retries of a failed worker run. |
| `deep.lanes.<id>.{enabled, chunkSize, agentOptions}` | none | Per-lane settings; the reproducer, skeptic and simplifier cannot be disabled. |
| `deep.maxSteeringEntries` / `maxSteeringChars` | `8` / `1500` | User messages kept as steering. |
