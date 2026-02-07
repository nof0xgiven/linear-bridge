# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Linear webhook service that runs RepoPrompt (`rp-cli`) and Sandbox Agent workflows from Linear issue labels and comment mentions.

It can post context and plans back to Linear, create isolated git worktrees for coding, run a read-only code review agent, generate user guides, and optionally publish GitHub PRs (plus cleanup on merge).

**Stack:** Bun runtime, TypeScript, Hono (web framework), Linear SDK, Sandbox Agent SDK

## Development Commands

```bash
# Install dependencies
bun install

# Development mode (auto-reload on changes)
bun run dev

# Type checking
bun run typecheck

# Production start (direct)
bun src/index.ts

# Production (via PM2)
pm2 start ecosystem.config.cjs
pm2 restart enhance-ticket              # After code changes
pm2 restart enhance-ticket --update-env # After .env changes (CRITICAL!)
pm2 logs enhance-ticket                 # View logs
pm2 delete enhance-ticket               # Clean restart
```

## Architecture

### Label-First Workflow (Recommended)

1. `discovery` label → RepoPrompt context builder (posts context comment)
2. `plan` label → RepoPrompt plan builder (posts plan comment)
3. `code` label → worktree + coding agent (posts Code Bot summary; leaves worktree)
4. `review` label → read-only review agent (posts code review comment; requires worktree)
5. `guide` label → user guide workflow (writes docs + screenshots; posts link/path)
6. `github` label → `gh` PR automation (posts PR link; requires worktree + config)
7. Merge PR → optional GitHub webhook cleanup (removes worktree + deletes branch)

### Module Responsibilities

| Module | Purpose |
|--------|---------|
| `index.ts` | Hono server setup, routes, OAuth handler |
| `webhook.ts` | Webhook handler orchestration, trigger detection, workflow coordination |
| `linear.ts` | Linear API client (create/update comments, fetch issues) |
| `rp-cli.ts` | Context builder wrapper (calls `rp-cli context_builder`) |
| `worktree.ts` | Git worktree management (create, remove) |
| `sandbox.ts` | Sandbox Agent SDK integration, event streaming, progress tracking |
| `types.ts` | TypeScript types and Zod validation schemas |

### Key Patterns

**Webhook signature verification:** HMAC-SHA256 validation using `LINEAR_WEBHOOK_SECRET`. Webhook is rejected with 401 if signature invalid.

**Trigger detection:**
- `discovery` label → Context-only discovery (RepoPrompt)
- `plan` label → Plan generation (RepoPrompt)
- `code` label → Worktree + coding agent
- `review` label → Read-only code review agent (diff-based)
- `guide` label → User guide agent
- `github` label → PR automation via `gh`
- `@claude <question>` / `@codex <question>` → Mention Q&A reply (Sandbox Agent; read-only)
- Hashtag triggers can be enabled in config but are de-emphasized.

**Background processing:** After webhook acknowledgment, work continues in background. Linear comments are updated with progress.

**Worktree naming:** `<WORKSPACE_PATH>-worktrees/<issue-id>/` with branch `fix/<issue-id>`

**Sandbox Agent integration:**
- Uses `sandbox-agent` SDK to spawn Claude Code sessions
- Auto-approves permissions (based on `SANDBOX_PERMISSION_MODE`)
- Auto-rejects questions (non-interactive mode)
- Streams events and tracks file modifications
- 30-minute default timeout

**Progress throttling:** Linear comments updated max once per minute to avoid rate limits

## Environment Configuration

Config is loaded from `config.yaml` (or `ENHANCE_TICKET_CONFIG`) and environment variables referenced in the config via `${VAR}`.

Required env vars (typical):

- `LINEAR_API_KEY` - For posting comments and fetching issues
- `LINEAR_WEBHOOK_SECRET` - For HMAC signature validation

Optional:

- `SANDBOX_TOKEN` - Sandbox Agent connection token (depends on your sandbox-agent setup)
- `GUIDE_USERNAME` / `GUIDE_PASSWORD` - For the user guide workflow
- `GITHUB_WEBHOOK_SECRET` - Only needed if you enable GitHub cleanup webhooks

## PM2 Environment Loading

**CRITICAL:** PM2 does NOT reload `.env` automatically. After changing environment variables:

```bash
# Option 1: Restart with --update-env flag
pm2 restart enhance-ticket --update-env

# Option 2: Delete and restart (more reliable)
pm2 delete enhance-ticket && pm2 start ecosystem.config.cjs
```

The `ecosystem.config.cjs` manually parses `.env` at startup because PM2 doesn't support it natively.

## Webhook Exposure

The server runs locally on port 4747 and must be exposed to the internet for Linear to reach it.

**Using ngrok (recommended):**
```bash
ngrok http 4747
# Use the https:// URL in Linear webhook settings
```

**Getting current ngrok URL:**
```bash
curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url'
```

## Linear Webhook Behavior

**Important:** Linear automatically disables webhooks after repeated failures (3 retries with exponential backoff). If the endpoint is down or returns errors, the webhook stops working and must be manually re-enabled in Linear Settings > API > Webhooks.

After re-enabling or recreating the webhook, update `LINEAR_WEBHOOK_SECRET` in `.env` and restart PM2 with `--update-env`.

## Dependencies

**External tools required:**
- `rp-cli` - Must be in PATH for context building and planning workflows
- `sandbox-agent` - Auto-installed via npm, spawns Claude Code
- `ngrok` - For webhook exposure (or use Tailscale Funnel, though less reliable)
- `gh` (optional) - Required for GitHub PR automation workflows

**Claude Code authentication:** Run `claude` once to complete OAuth login. Sandbox Agent will fail if Claude is not authenticated.

## Testing

```bash
# Health check
curl http://localhost:4747/health

# Verify environment loaded
curl http://localhost:4747/health | jq '.env'

# Test webhook endpoint (should return method explanation)
curl http://localhost:4747/webhook

# Check ngrok tunnel status
curl http://localhost:4040/api/tunnels
```

## Debugging

**Most common issues:**
1. Webhook returns 401 → `LINEAR_WEBHOOK_SECRET` mismatch or PM2 didn't reload env
2. Linear stopped sending webhooks → Webhook disabled due to failures, re-enable in Linear UI
3. `rp-cli not found` → Ensure it's in PATH (`/usr/local/bin` or `~/.local/bin`)
4. Agent fails to start → Claude Code not authenticated, run `claude` manually first
5. Worktree creation fails → Main branch doesn't exist or git remote not configured

**Logs:**
```bash
pm2 logs enhance-ticket --lines 100
pm2 logs enhance-ticket  # Follow mode (Ctrl+C to exit)
```

## Type Safety

All Linear webhook payloads are validated using Zod schemas at runtime. Invalid payloads are rejected with 400.

TypeScript strict mode is enabled. All functions should have explicit return types.
