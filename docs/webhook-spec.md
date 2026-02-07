# Webhook Specification

The service expects Linear webhooks for:

- `Issue` events
- `Comment` events

Signature verification:

- HMAC-SHA256 of the raw request body.
- Header: `linear-signature`
- Secret: `linear.webhookSecret`

Deduplication:

- Uses `linear-delivery` (Linear-Delivery UUID) when present to avoid processing the same delivery twice.

Supported actions:

- `create`
- `update`
- `remove` (ignored by default)

## GitHub Webhook (Optional)

If `github.enabled=true` and `github.cleanup.enabled=true`, you can configure GitHub to call this service when a PR is merged so it can clean up worktrees and branches.

Endpoint:

- `POST /github-webhook`

This endpoint returns `404 {"status":"disabled"}` unless both of these are true:

- `github.enabled=true`
- `github.cleanup.enabled=true`

Signature verification:

- Header: `x-hub-signature-256`
- Secret: `github.webhookSecret`

Expected event:

- Event: `pull_request`
- Action: `closed` with `pull_request.merged=true`

Notes:

- Cleanup is only attempted for branches that match `worktree.branchTemplate` (must include `{ISSUE_ID}`).
- Worktree removal and remote branch deletion are best-effort; failures are logged.

### GitHub UI Setup

GitHub webhooks are configured per-repository:

1. Go to the GitHub repo → Settings → Webhooks → Add webhook
2. Set:
   - Payload URL: `https://<public-host>/github-webhook`
   - Content type: `application/json`
   - Secret: a string you generate (for example `openssl rand -hex 32`)
3. Choose events:
   - “Let me select individual events” → “Pull requests”

The same secret must be configured in this service as `github.webhookSecret` (typically via `GITHUB_WEBHOOK_SECRET` in `.env` and `${GITHUB_WEBHOOK_SECRET}` in `config.yaml`).
