import type { Context } from 'hono'
import { $ } from 'bun'
import { timingSafeEqual } from 'node:crypto'
import type { AppConfig, WorkspaceConfig } from './config/schema'
import { logger } from './logger'
import { getWorktreeSpec, removeWorktree } from './worktree'

/**
 * Simple in-memory deduplication for GitHub webhook deliveries.
 */
const GITHUB_DEDUP_WINDOW_MS = 5 * 60_000 // 5 minutes
const processedGithubDeliveries = new Map<string, number>()

function isDuplicateGithubDelivery(deliveryId: string): boolean {
  const now = Date.now()
  const processedAt = processedGithubDeliveries.get(deliveryId)
  if (processedAt && now - processedAt < GITHUB_DEDUP_WINDOW_MS) return true

  if (processedGithubDeliveries.size > 2000) {
    for (const [key, ts] of processedGithubDeliveries.entries()) {
      if (now - ts > GITHUB_DEDUP_WINDOW_MS) {
        processedGithubDeliveries.delete(key)
      }
    }
  }

  processedGithubDeliveries.set(deliveryId, now)
  return false
}

async function verifyGitHubSignature(body: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader) return false

  const expectedPrefix = 'sha256='
  if (!signatureHeader.startsWith(expectedPrefix)) return false

  const provided = signatureHeader.slice(expectedPrefix.length).trim()
  if (!provided) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const computed = Buffer.from(signatureBytes).toString('hex')

  // Compare using constant-time equality to avoid timing leaks.
  const providedBytes = Buffer.from(provided, 'hex')
  const computedBytes = Buffer.from(computed, 'hex')
  if (providedBytes.length !== computedBytes.length || providedBytes.length === 0) return false
  return timingSafeEqual(providedBytes, computedBytes)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')
}

function parseIssueIdFromBranch(branchName: string, branchTemplate: string): string | null {
  if (!branchTemplate.includes('{ISSUE_ID}')) return null

  const [prefix, suffix] = branchTemplate.split('{ISSUE_ID}')
  const regex = new RegExp(`^${escapeRegex(prefix)}(.+?)${escapeRegex(suffix)}$`)
  const match = branchName.match(regex)
  if (!match) return null

  const issueId = match[1]?.trim()
  return issueId ? issueId : null
}

async function isWorktreeRegistered(basePath: string, worktreePath: string): Promise<boolean> {
  const output = await $`git worktree list --porcelain`.cwd(basePath).quiet().text()
  const lines = output.split('\n')
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim()
      if (p === worktreePath) return true
    }
  }
  return false
}

async function removeWorktreeSafe(basePath: string, worktreePath: string): Promise<void> {
  try {
    await removeWorktree(basePath, worktreePath)
    logger.info(`[github-webhook] Removed worktree at ${worktreePath}`)
  } catch (error) {
    logger.error({ error }, '[github-webhook] Failed to remove worktree')
  }
}

async function deleteRemoteBranchSafe(basePath: string, remote: string, branch: string): Promise<void> {
  try {
    await $`git push ${remote} --delete ${branch}`.cwd(basePath).quiet()
    logger.info(`[github-webhook] Deleted remote branch ${remote}/${branch}`)
  } catch (error) {
    logger.warn({ error }, `[github-webhook] Failed to delete remote branch ${remote}/${branch}`)
  }
}

function resolveWorkspace(config: AppConfig, workspaceName: string): WorkspaceConfig | null {
  return config.linear.workspaces.find((workspace) => workspace.name === workspaceName) ?? null
}

export function createGitHubWebhookHandler(config: AppConfig) {
  return async function githubWebhookHandler(c: Context) {
    if (!config.github.enabled || !config.github.cleanup.enabled) {
      return c.json({ status: 'disabled' }, 404)
    }

    const secret = config.github.webhookSecret
    if (!secret) {
      logger.warn('[github-webhook] github.webhookSecret is not configured')
      return c.json({ error: 'GitHub webhook not configured' }, 500)
    }

    const rawBody = await c.req.text()
    const signature = c.req.header('x-hub-signature-256') ?? null
    const event = c.req.header('x-github-event') ?? null
    const deliveryId = c.req.header('x-github-delivery') ?? null

    if (deliveryId && isDuplicateGithubDelivery(deliveryId)) {
      return c.json({ status: 'ignored', reason: 'duplicate_delivery' })
    }

    const valid = await verifyGitHubSignature(rawBody, signature, secret)
    if (!valid) {
      logger.warn('[github-webhook] Invalid signature')
      return c.json({ error: 'Invalid signature' }, 401)
    }

    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch (error) {
      logger.error({ error }, '[github-webhook] Invalid JSON payload')
      return c.json({ error: 'Invalid payload' }, 400)
    }

    if (event !== 'pull_request') {
      return c.json({ status: 'ignored', reason: 'unsupported_event', event })
    }

    const action = payload?.action
    const merged = Boolean(payload?.pull_request?.merged)
    const repoFullName = String(payload?.repository?.full_name ?? '')
    const branch = String(payload?.pull_request?.head?.ref ?? '')

    if (action !== 'closed' || !merged) {
      return c.json({ status: 'ignored', reason: 'not_merged', action, merged })
    }

    if (!repoFullName || !branch) {
      return c.json({ status: 'ignored', reason: 'missing_fields', repoFullName, branch })
    }

    const repoConfig = config.github.repos.find((repo) => repo.repo.toLowerCase() === repoFullName.toLowerCase())
    if (!repoConfig) {
      return c.json({ status: 'ignored', reason: 'repo_not_configured', repoFullName })
    }

    if (!config.github.cleanup.enabled) {
      return c.json({ status: 'ok', action: 'merged', repoFullName, branch, cleanup: 'disabled' })
    }

    const workspace = resolveWorkspace(config, repoConfig.workspace)
    if (!workspace) {
      logger.error(`[github-webhook] Workspace not found: ${repoConfig.workspace}`)
      return c.json({ error: 'Workspace not found' }, 500)
    }

    const issueId = parseIssueIdFromBranch(branch, config.worktree.branchTemplate)
    if (!issueId) {
      logger.warn(`[github-webhook] Branch did not match worktree.branchTemplate; skipping cleanup: ${branch}`)
      return c.json({ status: 'ignored', reason: 'branch_not_mapped', branch })
    }

    const spec = getWorktreeSpec(workspace, issueId, config.worktree)

    if (config.github.cleanup.removeWorktreeOnMerge) {
      const registered = await isWorktreeRegistered(workspace.localPath, spec.path).catch(() => false)
      if (registered) {
        await removeWorktreeSafe(workspace.localPath, spec.path)
      } else {
        logger.warn(`[github-webhook] Worktree not registered; skipping remove: ${spec.path}`)
      }
    }

    if (config.github.cleanup.deleteBranchOnMerge) {
      // Only delete branches that match our configured template to avoid deleting arbitrary branches.
      if (parseIssueIdFromBranch(branch, config.worktree.branchTemplate)) {
        await deleteRemoteBranchSafe(workspace.localPath, repoConfig.remote, branch)
      }
    }

    return c.json({ status: 'ok', action: 'merged', repoFullName, branch, issueId })
  }
}
