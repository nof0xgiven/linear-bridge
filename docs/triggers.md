# Triggers

Triggers determine when the automation runs.

## Label Triggers

Label triggers apply to Issue events. Use `on` to control which event actions apply.

Example:

- `type: label`
- `value: discovery`
- `action: context`
- `on: [create, update]`

Notes:

- For `update` events, label triggers only fire when the label was **added** in that update (based on `updatedFrom.labelIds` in the webhook payload). This avoids retriggering on every subsequent edit while the label remains on the issue.
- Common coding labels:
  - `code`: Run the coding workflow with the default agent.
  - `claude`: Run the coding workflow forcing agent `claude`.
  - `codex`: Run the coding workflow forcing agent `codex`.

## Hashtag Triggers

Hashtag triggers apply to Comment create events.

Hashtags are supported but de-emphasized; labels are recommended.

Example:

- `type: hashtag`
- `value: #et`
- `action: context`

## Mention Triggers

Mention triggers apply to Comment create events and match when the comment starts with the configured mention token (case-insensitive).

Example:

- `type: mention`
- `value: @claude`
- `action: reply`
- `agent: claude`
- `on: [create]`

## Agent Override

Any trigger can optionally set `agent` to force which Sandbox Agent runs:

- `agent: claude`
- `agent: codex`
- `agent: opencode`
- `agent: amp`

Notes:

- Mention triggers (`action: reply`) require `agent`.
- Label/hashtag triggers default to `sandbox.default.agent` unless `agent` is specified.

## Actions

- `full`: Run context builder, create worktree, run agent.
- `quick`: Create worktree, run agent (no context builder).
- `context`: Run context builder only and post context comment.
- `review`: Run the review agent against the worktree diff (read-only) and post a code review comment.
- `guide`: Run the user guide agent (no worktree).
- `plan`: Run RepoPrompt builder (`rp-cli ... builder --type plan`) and post the plan as a comment.
- `reply`: Run the Sandbox Agent and post a Q&A-style reply as a comment.
- `github`: Commit/push/PR via `gh` and post the PR URL as a comment.
