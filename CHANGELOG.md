# Changelog

## Unreleased

- `/review commit`, `/review pr` and `/review folder` without an argument now answer with a usage line. They used to fail with a `TypeError`.
- Git and `gh` calls fail fast. Truncated output, signal exits and unexpected exit codes are errors, and `/review pr` no longer checks out a branch when `git status` cannot be read. A missing `git` is reported as such, not as "Not a git repository".
- `/review pr` validates the reference before running `gh` or `git`, ignores untracked files when it checks for pending changes, and reports unexpected `gh pr view` output as an error. A failed checkout shows the end of the `gh` diagnostic, where the cause is.
- Git runs with repository-local environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …) removed and with prompts and pagers disabled.
- Unloading the plugin cancels commands that are still running and waits for them before closing the review state.
- An unreadable `REVIEW_GUIDELINES.md` now fails the review instead of being skipped silently.
- Review turns carry their own message source, `apcamargo-dsh-review`, instead of posing as user input.
- Added plugin list metadata (`locale/en.json`), completed the type declarations, and declared the `dsh-storage-domain` and `dsh-subprocess` peer dependencies.

## 0.1.0

- Initial release: `/review` and `/end-review`.
