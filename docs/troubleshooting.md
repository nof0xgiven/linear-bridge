# Troubleshooting

## Invalid Signature

- Ensure Linear webhook secret matches `linear.webhookSecret`.
- Verify your webhook URL points to `/webhook`.

## No Trigger Matches

- Confirm `linear.triggers` in `config.yaml`.
- Ensure label names and hashtags match exact values.
- For `update` events, label triggers only fire when the label was newly added in that update (not just present on the issue).

## Worktree Creation Fails

- Check that `localPath` is a valid git repository.
- Ensure you have permissions to create `${localPath}-worktrees`.
- If `worktree.postCreateScript` is set, confirm the script exists and is executable.
- A non-zero exit from the post-create script aborts the run and cleans up the worktree.

## Review / GitHub Says "No Worktree Found"

The `review` and `github` workflows require an existing worktree (typically created by the `code` workflow).

- Apply `code` first to create the worktree and run the agent.
- Then apply `review` (or `github`) to run the follow-up workflow.

## Sandbox Agent Errors

- Ensure `sandbox-agent` is installed and reachable.
- Run `linear-bridge agent test` to verify connectivity.

## Guide Agent Errors

- Ensure `GUIDE_USERNAME` and `GUIDE_PASSWORD` are set (or custom env vars per workspace).
- Confirm `guide.docsPath` is writable.
- Ensure `guide.docsBaseUrl` is set if you want a public link in the Linear comment.
- Verify `localhost:3000` is running and reachable from the agent.
- If your docs build fails with YAML parsing, confirm frontmatter values are double-quoted.
- If screenshots are too tall, ensure the guide prompt instructs viewport-only screenshots (no full-page capture).

## GitHub Webhook Cleanup

Symptoms and fixes:

- `404 {"status":"disabled"}`:
  - Ensure `github.enabled=true` and `github.cleanup.enabled=true`.
- `401 Invalid signature`:
  - The webhook secret configured in GitHub does not match `github.webhookSecret`.
  - If you changed `.env`, restart your process so the new environment variables are loaded.
- `ignored` with `repo_not_configured`:
  - Add a `github.repos[]` entry matching `repository.full_name` (format: `owner/name`).
- `ignored` with `branch_not_mapped`:
  - Ensure `worktree.branchTemplate` includes `{ISSUE_ID}` and your branch name matches it (default: `fix/{ISSUE_ID}`).

Notes:

- GitHub sends a `ping` event when you create or edit a webhook. This service ignores non-`pull_request` events, so `ping` deliveries are expected to be ignored.
