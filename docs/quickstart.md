# Quickstart

Get from zero to your first automated fix in under 15 minutes.

## 1. Install

```bash
bun install
```

## 2. Create Config

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` to set:
- Linear `apiKey` and `webhookSecret`
- At least one `workspace` with `teamId` and `localPath`
- Triggers for `label` (recommended) and/or `hashtag`

## 3. Configure Secrets

```bash
cp .env.example .env
```

Populate secrets referenced in `config.yaml`, for example:
- `LINEAR_API_KEY`
- `LINEAR_WEBHOOK_SECRET`

## 4. Expose Webhook

```bash
ngrok http 4747
```

Copy the public URL.

## 5. Create Linear Webhook

Create a webhook in Linear:
- URL: `https://<ngrok-url>/webhook`
- Events: `Issue`, `Comment`

## 6. Run

```bash
bun run dev
```

## 7. Trigger

- Apply the `discovery` label to post RepoPrompt context, or
- Apply the `plan` label to generate an implementation plan, or
- Apply the `code` label to create a worktree and run the coding agent.
- Apply the `claude` or `codex` label to run the same coding workflow but force the agent.
- (Optional) Apply `review`, `guide`, and `github` as your ticket progresses.
- Comment `@claude <question>` or `@codex <question>` to get a Q&A-style reply.

You should see progress updates posted to the issue.
