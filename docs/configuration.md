# Configuration

All configuration is file-based. Defaults are loaded from:

1. `LINEAR_BRIDGE_CONFIG` (comma-separated list)
2. `./config.yaml`
3. `~/.linear-bridge/config.yaml`

Environment variables in the config are interpolated using `${VAR_NAME}`.
When multiple config files are present, later entries override earlier ones. By default, local `./config.yaml` overrides the home config.

## Top-Level Fields

- `version`: Config version string.
- `server`: Host, port, log level, rate limit.
- `linear`: API key, webhook secret, workspaces, triggers.
- `sandbox`: Agent defaults, per-workspace overrides, connection settings.
- `context`: rp-cli command and limits.
- `worktree`: Naming templates, post-create script, and cleanup behavior.
- `progress`: Update interval and detail flags.
- `bot`: Mention name used for default triggers.
- `mentionReply`: Mention-based Q&A reply settings (template, truncation).
- `review`: Code review workflow settings (template, diff limits).
- `github`: GitHub PR automation + cleanup settings.
- `advanced`: Telemetry, metrics, health check toggles.
  - `deadLetterPath`: JSONL file path for failed webhooks.

## Workspaces

Each workspace maps Linear teams/projects to local repositories.

Required fields:
- `name`
- `teamId`
- `localPath`

Optional:
- `projectIds` (if omitted, any project within the team matches).
- `guide` (user guide agent settings).
- `automation` (optional issue state + label automation).

## Triggers

Trigger types:
- `label`: Matches issue labels on Issue events.
- `hashtag`: Matches comment text on Comment events.
- `mention`: Matches comment mentions at the start of the comment (e.g. `@claude`).

Fields:
- `type`: `label`, `hashtag`, or `mention`
- `value`: Label name or hashtag
- `action`: `full`, `quick`, `context`, `guide`, `plan`, `reply`, `review`, or `github`
- `agent`: Optional agent override for any trigger. Required for `mention` triggers. One of: `claude`, `codex`, `opencode`, `amp`.
- `on`: Optional list of webhook actions (`create`, `update`, `remove`)

## Workspace Automation

Optional automation lives under `linear.workspaces[].automation`.

Currently supported:

### `automation.labels`

Applies to all label-triggered workflows.

Fields:
- `removeTriggerLabelOnFailure`: If true, remove the triggering label when a workflow fails so you can re-add it to retry (default: false).

### `automation.coding`

Applies to coding workflows that create a worktree and run an agent (`quick` and `full`).

Fields:
- `setInProgressState`: Workflow state name or ID (UUID). If set, the issue is moved after the worktree is created and before the agent starts.
- `setInReviewStateOnSuccess`: Workflow state name or ID (UUID). If set, the issue is moved after a successful agent run.
- `removeTriggerLabelOnSuccess`: If true, remove the label that triggered the run (only for label triggers) after a successful agent run.

To list your team's workflow states (names + IDs), run:

```bash
set -a && source .env && set +a
bun dist/cli/index.js linear workflow-states --teamId <TEAM_ID>
```

## Mention Reply

The mention reply workflow is configured under `mentionReply`:

- `templatePath`: Prompt template file path (default: `templates/mention_reply.md`).
- `stripMention`: Whether to strip the mention token from the start of the user comment before prompting (default: true).
- `maxAnswerChars`: Max characters to include in the posted answer comment (default: 50000).
- `maxContextComments`: Number of recent comments to include in the prompt context (default: 10).

## Review

The review workflow is configured under `review`:

- `templatePath`: Prompt template file path (default: `templates/review.md`).
- `maxDiffChars`: Max characters of git diff to include in the prompt (default: 120000).
- `maxContextComments`: Number of recent comments to include in the prompt context (default: 10).
- `maxCommentChars`: Max characters to include in the posted review comment (default: 50000).

## GitHub

The GitHub PR automation workflow is configured under `github`.

Requirements:

- `gh` CLI installed and authenticated (non-interactive).

Key fields:

- `enabled`: Enable GitHub workflows (default: false).
- `repos[]`: Maps a Linear workspace name to a GitHub repo (`owner/name`) and remote.
- `autoCommit`: If true, the bot can commit uncommitted changes in the worktree.
- `commitMessageTemplate`: Used when `autoCommit=true`.

Cleanup on merge (optional):

- Configure a GitHub webhook (event: `pull_request`) to POST to `/github-webhook`.
- Set `github.webhookSecret` (the webhook secret used to verify `x-hub-signature-256`).
- Set `github.cleanup.enabled: true` (cleanup is disabled by default).

Important:

- If your `config.yaml` contains `${GITHUB_WEBHOOK_SECRET}`, the process will fail to start unless that env var exists. Only uncomment `github.webhookSecret: ${GITHUB_WEBHOOK_SECRET}` after you have added `GITHUB_WEBHOOK_SECRET=...` to `.env`.
- If you changed `.env`, restart your process so the new environment variables are loaded.

## Templates

Worktree templates accept:
- `{WORKSPACE_PATH}`
- `{WORKSPACE_NAME}`
- `{ISSUE_ID}`
- `{WORKTREE_PATH}` (post-create script only)

Context command must include `{TASK}`.

## Worktree Post-Create Script

Use `worktree.postCreateScript` to run a script after the worktree is created and before the agent starts.

Templates support `{WORKSPACE_PATH}`, `{WORKSPACE_NAME}`, `{ISSUE_ID}`, and `{WORKTREE_PATH}`.
If the script exits non-zero, the worktree is cleaned up and the run fails.

## Guide Agent (Per-Workspace)

Example:
```yaml
linear:
  workspaces:
    - name: "Main Workspace"
      teamId: "team_abc123"
      localPath: "/path/to/repo"
      guide:
        enabled: true
        docsPath: "/path/to/docs"
        docsBaseUrl: ${GUIDE_DOCS_BASE_URL}
        serverUrl: "http://localhost:3000"
        usernameEnv: "GUIDE_USERNAME"
        passwordEnv: "GUIDE_PASSWORD"
        templatePath: "templates/user_guide.md"
        screenshotsDir: "assets/guides/{ISSUE_ID}"
```

Notes:
- `docsPath` must be writable.
- `docsBaseUrl` is used to build the link posted to Linear. If missing, the bot will post the file path instead.
- Credentials are read from env vars named by `usernameEnv` and `passwordEnv`.
