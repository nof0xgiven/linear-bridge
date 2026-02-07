<img src="image.png" />

# linear-bridge

Linear webhook service (CLI: `linear-bridge`) that runs RepoPrompt (`rp-cli`) and Sandbox Agent workflows from Linear issue labels and comment mentions (configuration-driven).

It supports context discovery, planning, coding in isolated git worktrees, code review, user guide generation, and optional GitHub PR automation (via `gh` + GitHub webhooks).

## How It Works

```
Trigger (label/hashtag/mention) → Webhook → Flow (rp-cli/worktree/agent) → Linear comments (+ optional files in repo/docs)
```

## Agents

This service launches an agent through **sandbox-agent**. Supported agents:

- `claude` (Claude Code)
- `codex`
- `opencode`
- `amp`

How the agent is selected:

- Default: `sandbox.default.agent` in `config.yaml`
- Per-workspace override: `sandbox.overrides[]` in `config.yaml`
- Per-trigger override: `linear.triggers[]` can set `agent: claude|codex|...` for label/hashtag/mention triggers

## Flows

Flows are selected by a trigger’s `action`.

The default configuration is **label-first** (recommended):

| Linear trigger | Action | What runs | Output |
|--------------|--------|----------|--------|
| Issue label `discovery` | `context` | RepoPrompt context builder (`rp-cli context_builder`) | Posts a context comment |
| Issue label `plan` | `plan` | RepoPrompt plan builder (`rp-cli builder --type plan`) | Posts a plan comment |
| Issue label `code` | `quick` | Git worktree + Sandbox Agent (coder) | Posts a “Code Bot” summary comment; leaves worktree |
| Issue label `claude` | `quick` | Git worktree + Sandbox Agent (coder, forced to Claude) | Posts a “Code Bot” summary comment; leaves worktree |
| Issue label `codex` | `quick` | Git worktree + Sandbox Agent (coder, forced to Codex) | Posts a “Code Bot” summary comment; leaves worktree |
| Issue label `review` | `review` | Sandbox Agent (read-only reviewer) using git diff from worktree | Posts a “Code Review” comment |
| Issue label `guide` | `guide` | Sandbox Agent (user guide workflow) | Writes docs + screenshots; posts guide link/path |
| Issue label `github` | `github` | `gh` CLI (commit/push/PR) | Posts PR link comment |
| Comment mention `@claude` / `@codex` | `reply` | Sandbox Agent (read-only Q&A) | Posts answer comment |

Notes:

- Label triggers match by **label name**, so the label must exist in your Linear team.
- `review` and `github` require an existing worktree (run the `code` workflow first).
- `reply` is designed to be read-only. For safety, the service blocks Linear MCP comment tools during mention replies so only this service posts back to Linear.

### Suggested Workflow

`discovery` → `plan` → (`code` or `claude` or `codex`) → `review` → `guide` → `github` → merge → cleanup

Optional / advanced:

- Hashtag triggers are supported but de-emphasized (labels are recommended).
- `full`: context builder + worktree + agent in one step (not enabled by default).

## Triggers

Triggers are configuration-driven. Default examples include:

| Trigger | Context Source | Use Case |
|---------|---------------|----------|
| `discovery` label | RepoPrompt (`rp-cli context_builder`) | Context-only discovery (posts context comment) |
| `plan` label | RepoPrompt (`rp-cli builder --type plan`) | Generate an implementation plan (posts plan comment) |
| `code` label | Sandbox Agent + git worktree | Coding workflow in an isolated worktree |
| `claude` label | Sandbox Agent + git worktree | Coding workflow (forced to Claude) |
| `codex` label | Sandbox Agent + git worktree | Coding workflow (forced to Codex) |
| `review` label | Sandbox Agent (review) + git diff | Read-only code review posted back to Linear |
| `guide` label | Sandbox Agent (user guide workflow) | Generate a user guide (docs + screenshots) |
| `github` label | `gh` CLI | Commit/push/PR and post PR link |
| `@claude` / `@codex` | Sandbox Agent (mention reply) | Ask a question and get a reply |

Optional:

| Trigger | Context Source | Use Case |
|---------|---------------|----------|
| `#et` | RepoPrompt (`rp-cli context_builder`) | Context-only discovery (de-emphasized) |
| `#sandbox` | Sandbox Agent + git worktree | Quick coding workflow (de-emphasized) |

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Create Configuration

Copy the example config and edit it:

```bash
cp config.example.yaml config.yaml
```

Or use the CLI wizard:

```bash
bun run build
./dist/cli/index.js init --interactive
```

### 3. Configure Secrets

Secrets are injected via environment variables referenced in `config.yaml`:

```bash
cp .env.example .env
```

### 4. Expose Webhook to Internet (ngrok)

The webhook server runs locally and needs to be exposed to the internet for Linear to reach it.

**Using ngrok (recommended):**
```bash
# Install ngrok
brew install ngrok

# Authenticate (one-time setup)
ngrok config add-authtoken YOUR_AUTHTOKEN

# Start tunnel to port 4747
ngrok http 4747
```

ngrok will give you a public URL like `https://abc123.ngrok-free.dev`. Use this for your Linear webhook.

> **Note:** Tailscale Funnel can also work but has been unreliable. ngrok is more straightforward.

### 5. Configure Linear Webhook

**Option A: Via Linear UI**
1. Go to Linear Settings > API > Webhooks
2. Create new webhook:
   - URL: `https://<your-ngrok-url>/webhook`
   - Events: `Issue`, `Comment`
3. Copy the signing secret to your `.env`

**Option B: Via GraphQL API**
```bash
# Create webhook programmatically
curl -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: YOUR_API_KEY" \
  -d '{
    "query": "mutation { webhookCreate(input: { url: \"https://YOUR_NGROK_URL/webhook\", resourceTypes: [\"Issue\", \"Comment\"], allPublicTeams: true }) { success webhook { id secret } } }"
  }'
```

Save the returned `secret` to your `.env` as `LINEAR_WEBHOOK_SECRET`.

### 6. Prerequisites

- **ngrok**: For exposing local server to the internet
- **rp-cli**: Must be installed and in PATH for context building
- **sandbox-agent**: Auto-installed via npm dependency
- **Claude Code**: Sandbox Agent will install on first use
- **gh** (optional): Required for the `github` label PR workflow

### 7. Run the Server

```bash
bun run dev
```

```bash
bun run start
```
Run `bun run start` under your preferred process manager.

## Workflow Details

### Worktree Structure

```
/path/to/repo                  # Main repo (workspace.localPath)
/path/to/repo-worktrees/       # Worktrees directory
  ├── eng-123/                 # Issue ENG-123 worktree
  │   └── (branch: fix/eng-123)
  └── eng-456/                 # Issue ENG-456 worktree
      └── (branch: fix/eng-456)
```

### Worktree Post-Create Script

If you need to prepare each worktree (e.g. copy secrets, install env files), set:

- `worktree.postCreateScript` in `config.yaml`

The script runs after the worktree is created and before the agent starts.
It is executed with:

- working directory: the worktree path
- env vars: `WORKTREE_PATH`, `WORKSPACE_PATH`, `WORKSPACE_NAME`, `ISSUE_ID`

If the script fails, the worktree is removed and the run is aborted.

### Agent Behavior

- **Permissions**: Auto-approved (allows file writes, bash commands)
- **Questions**: Auto-skipped (agent uses best-effort)
- **Timeout**: 30 minutes default
- **Progress**: Updates posted to Linear every ~1 minute

### Final Comment

When complete, a verification comment is posted:

```markdown
## Code Bot - Ready for Review

**Issue:** ENG-123
**Status:** Completed

### Worktree Location
/path/to/repo-worktrees/eng-123

### Branch
fix/eng-123

### Files Modified
- `src/components/Login.tsx`
- `src/utils/auth.ts`

### Summary
Modified 2 file(s)

---

_This change was generated automatically. Human verification required before merging._
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook` | POST | Linear webhook receiver |
| `/github-webhook` | POST | GitHub webhook receiver (optional; cleanup on merge) |
| `/health` | GET | Health check |
| `/metrics` | GET | Prometheus metrics |
| `/` | GET | Server info |

## Documentation

- `docs/quickstart.md`
- `docs/configuration.md`
- `docs/triggers.md`
- `docs/troubleshooting.md`
- `docs/security.md`
- `docs/webhook-spec.md`
- `docs/architecture.md`

### Label Workflows (Recommended)

This setup is designed to move a ticket through an explicit pipeline:

`discovery` → `plan` → `code` → `review` → `guide` → `github` → merge → cleanup

Apply these labels to a Linear issue:

- `discovery`: posts RepoPrompt context
- `plan`: posts RepoPrompt plan
- `code`: creates a worktree and runs the coding agent
- `claude`: creates a worktree and runs the coding agent forcing agent `claude`
- `codex`: creates a worktree and runs the coding agent forcing agent `codex`
- `review`: runs the review agent against the worktree diff and posts a code review comment (requires worktree)
- `guide`: runs the user guide workflow
- `github`: publishes a PR via `gh` and posts the PR link (requires worktree + config)

Optional automation:

- `linear.workspaces[].automation.coding` can move issues to "In Progress" after worktree creation, and to "In Review" after a successful run, and optionally remove the triggering label on success.

### User Guide Workflow

Apply the `guide` label to an issue to generate a user guide. The agent will:
- Log into the local app
- Capture screenshots
- Write a guide into the configured docs path
- Post a link or file path to Linear

Required env vars:
- `GUIDE_USERNAME`
- `GUIDE_PASSWORD`

### Plan Workflow

Apply the `plan` label to an issue to generate an implementation plan using RepoPrompt (`rp-cli ... builder --type plan`). The plan is posted back to Linear as a comment.

### Code Review Workflow

Apply the `review` label after running `code`. The bot will compute a git diff vs `origin/HEAD`, run the review agent in read-only mode, and post a code review comment.

### Mention Q&A Workflow

Comment starting with `@claude <question>` or `@codex <question>` to ask a question. The bot will run the corresponding Sandbox Agent and post a reply as a new comment.

### GitHub PR Workflow

Apply the `github` label after running `code`. The bot will:

- ensure `gh` is available
- optionally auto-commit (if enabled)
- push the worktree branch
- create (or reuse) a PR and post the PR URL back to Linear

Prerequisites:

- `github.enabled: true` in `config.yaml`
- `github.repos[]` includes a mapping for the Linear workspace name
- `gh` is installed and authenticated for the target repo (run `gh auth status`)

Notes:

- If `github.autoCommit: false` (recommended), the worktree must be clean (all changes committed) before applying the `github` label.
- If `github.autoCommit: true`, the bot will `git add -A` and `git commit` using `github.commitMessageTemplate`.

### Cleanup on Merge (GitHub Webhook)

If configured, GitHub can call this service on PR merge, and the service will:

- remove the git worktree directory
- delete the remote branch (best-effort)

This is an optional webhook, separate from Linear. GitHub does not “give” you a secret; you choose one and configure it in both places.

1. Generate a secret (example):
   - `openssl rand -hex 32`
2. Add it to `.env`:
   - `GITHUB_WEBHOOK_SECRET=...`
3. Enable cleanup in `config.yaml`:
   - Uncomment: `github.webhookSecret: ${GITHUB_WEBHOOK_SECRET}`
   - Set: `github.cleanup.enabled: true`
4. Restart your process so the new env var is loaded.
5. In GitHub, create the webhook:
   - Repo Settings → Webhooks → Add webhook
   - Payload URL: `https://<public-host>/github-webhook`
   - Content type: `application/json`
   - Secret: the same value as `GITHUB_WEBHOOK_SECRET`
   - Events: select “Let me select individual events” → “Pull requests”

After a PR is merged, the service removes the worktree and deletes the remote branch only if the branch matches `worktree.branchTemplate` (default: `fix/{ISSUE_ID}`).

### Optional Hashtag Workflows (De-emphasized)

If you configure hashtag triggers:

- `#et`: context-only discovery
- `#sandbox`: quick coding workflow

## Troubleshooting

See `docs/troubleshooting.md`.

## Architecture

```
src/
├── index.ts      # Hono server setup
├── github-webhook.ts # GitHub webhook handler (cleanup on merge)
├── webhook.ts    # Webhook handler, orchestrates flow
├── linear.ts     # Linear API client
├── rp-cli.ts     # Context builder (rp-cli wrapper)
├── worktree.ts   # Git worktree management
├── sandbox.ts    # Sandbox Agent SDK integration
├── triggers/     # Trigger matchers (label/hashtag/mention)
└── types.ts      # TypeScript types & Zod schemas
```
