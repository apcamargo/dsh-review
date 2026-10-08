# dsh-review

A DeepSeek Harness plugin that adds a code review workflow to `/review` and `/end-review`.

It reviews uncommitted changes, changes against a base branch, a single commit, a GitHub pull request (checked out locally through `gh`), or a folder as a snapshot. Findings get a priority from `[P0]` to `[P3]` and a confidence level, and non-blocking Side Effects & Breaking Changes are kept separate from the fix items.

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

## Quick reference

```bash
/review                           # review uncommitted changes (the default)
/review uncommitted               # explicit equivalent of /review
/review branch [<name>]           # base branch by name, or main/master when omitted
/review commit abc123
/review pr 123
/review pr https://github.com/owner/repo/pull/123
/review folder src docs           # snapshot review, not a diff
/review check the error handling  # any other text becomes the review focus
/review instructions "prefer fail-fast error handling"
/review instructions "clear"      # quoted form stores the literal word
/review instructions clear        # bare form removes them
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
| `/review folder <paths...>` | `paths` (required, one or more) — whitespace-separated folders and/or files, e.g. `src docs`. | Reviews the paths as a snapshot (not a diff): the reviewer reads them directly. Works outside a git repository. |
| `/review <focus text>` | `focus text` (required) — free-form review focus, e.g. `check the error handling`. Mode keywords (`uncommitted`, `branch`, `commit`, `folder`, `pr`, `instructions`, and a lone `status`) are matched first; everything else is the focus. | The text becomes the review focus: the reviewer reads it and decides what to inspect. Works outside a git repository. |
| `/review instructions <text>` | `text` (required) — the instructions to store, e.g. `"prefer fail-fast error handling"`. The bare word `clear` (case-insensitive) removes them instead; quote it (`"clear"`) to store the literal word. | Stores shared custom review instructions that are appended to every review in this session until removed. |
| `/review status` | none — `status` is only recognized as the sole argument; with more words it becomes a custom review focus. | Shows the current review session state: whether a review is active, its target, and the stored custom instructions. |
| `--extra "<instruction>"` | flag — value required when used. | Adds one extra instruction to any mode, on top of any stored session instructions; composes before or after the mode. |
| `--aggressive` | flag — no value (`--aggressive=true` is tolerated). | Hunts for issues instead of verifying: skepticism by default, every candidate reported with its confidence label, and each finding still grounded in the real diff and code; composes with any mode. |

### `/end-review [summarize\|fix\|done]`

Finishes the active review in this session.

| Mode | Description |
| --- | --- |
| `summarize` — the default; bare `/end-review` uses it | Queues a structured handoff: scope, verdict, findings, and an ordered fix queue. |
| `fix` | Queues a follow-up turn that implements the findings in priority order. |
| `done` | Just clears the session back to ordinary coding work. |
| `status` | Shows the review state without finishing it. |

Findings show up as an ordinary turn, so you can talk to the reviewer while it works.

### Failures

Git and `gh` failures are reported, never treated as an empty result. A command that cannot start, is cancelled, times out, truncates its output, or exits with an unexpected code ends the command with an error naming it. A missing mode argument (`/review commit`, `/review pr`, `/review folder`) answers with that mode's usage line. Unloading the plugin cancels reviews that are still gathering context.

## Model Experience

**What the model sees.** `/review` queues one user turn: the review rubric, the mode-specific focus, and any stored instructions, `--extra` text, `--aggressive` appendix, and project `REVIEW_GUIDELINES.md`. The turn is attributed to the `apcamargo-dsh-review` source. `/end-review summarize` and `/end-review fix` each queue one more turn. Command results and `/review status` stay outside model history.

**Token effect.** Each review adds the rubric (a few thousand tokens) plus the focus once. Nothing is added per later turn.

**KV cache effect.** The review turns only append to the conversation. The system prompt and the tool catalog never change, so starting or ending a review does not invalidate the cached prefix.

## Known limitations

- There is no review mode. The active review is a flag kept by the plugin; the agent never reads it, and nothing restricts its tools. The rubric asks the reviewer not to write a fix, but only the prompt enforces that.
- The state is stored per session id. A forked or resumed session starts with no active review. A review left active in a session that is no longer used stays active until `/end-review done`.
- Records of deleted sessions are not cleaned up.
- Review turns are queued as a follow-up, so a `/review` issued while the agent is busy runs after the current turn.

## Development

```bash
npm install
npm test
```

The tests run three ways: command grammar, prompts, and state over mock services, git helpers against a real repository, and the full command flow against a real repository. Harness services are reached through the injected `ctx`, so the package never binds to a specific host install.

## License

MIT
