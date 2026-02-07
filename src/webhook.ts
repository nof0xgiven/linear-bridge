import type { Context } from 'hono'
import path from 'path'
import { $ } from 'bun'
import { mkdir } from 'fs/promises'
import {
  createComment,
  getIssue,
  getIssueWithComments,
  getIssueAutomationSnapshot,
  resolveWorkflowStateId,
  updateComment,
  updateIssue,
} from './linear'
import { formatOutputForComment, formatPlanOutputForComment, runContextBuilder, runPlanBuilder } from './rp-cli'
import { createWorktree, getWorktreeSpec, removeWorktree, type WorktreeResult } from './worktree'
import { runSandboxAgent, buildAgentPrompt, buildSandboxPrompt, buildMentionReplyPrompt, buildReviewPrompt, buildUserGuidePrompt, type ProgressCallback } from './sandbox'
import type { SandboxResult } from './types'
import { LinearCommentDataSchema, LinearIssueDataSchema, LinearWebhookPayloadSchema } from './types'
import type { AppConfig, TriggerConfig, WorkspaceConfig } from './config/schema'
import { logger } from './logger'
import { matchTriggers } from './triggers/matcher'
import { resolveWorkspaceForIssue, getSandboxOverride } from './workspace'
import { agentRunDurationSeconds, agentRunsTotal, triggerMatchesTotal, webhookEventsTotal } from './metrics'
import { writeDeadLetter } from './dead-letter'
import { formatFailureAck, type WorkflowFailure, type WorkflowBotName } from './workflow-errors'

/**
 * Simple in-memory deduplication cache for webhook events.
 * Prevents processing the same event multiple times within a short window.
 */
const DEDUP_WINDOW_MS = 30_000 // 30 seconds
const processedEvents = new Map<string, number>()

/**
 * Generate a deduplication key for a webhook event
 */
function getDeduplicationKey(type: string, action: string, dataId: string): string {
  return `${type}:${action}:${dataId}`
}

/**
 * Check if an event has already been processed recently
 */
function isDuplicateEvent(key: string): boolean {
  const now = Date.now()
  const processedAt = processedEvents.get(key)

  if (processedAt && now - processedAt < DEDUP_WINDOW_MS) {
    return true
  }

  // Clean up old entries periodically (when we have more than 1000 entries)
  if (processedEvents.size > 1000) {
    for (const [k, timestamp] of processedEvents.entries()) {
      if (now - timestamp > DEDUP_WINDOW_MS) {
        processedEvents.delete(k)
      }
    }
  }

  return false
}

/**
 * Mark an event as processed
 */
function markEventProcessed(key: string): void {
  processedEvents.set(key, Date.now())
}

/**
 * Normalize labels from webhook payload
 */
function normalizeLabels(labels: { name: string }[] | undefined): string[] {
  return (labels ?? []).map((label) => label.name)
}

/**
 * Verify Linear webhook signature using HMAC-SHA256
 */
async function verifySignature(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) {
    logger.warn('[webhook] No signature provided')
    return false
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const computedSignature = Buffer.from(signatureBytes).toString('hex')

  return computedSignature === signature
}

/**
 * Main webhook handler
 */
export function createWebhookHandler(config: AppConfig) {
  return async function webhookHandler(c: Context) {
    const secret = config.linear.webhookSecret

    // Get raw body for signature verification
    const rawBody = await c.req.text()
    const signature = c.req.header('linear-signature') ?? null
    const deliveryId = c.req.header('linear-delivery') ?? null

    // Verify signature
    const isValid = await verifySignature(rawBody, signature, secret)
    if (!isValid) {
      logger.warn('[webhook] Invalid signature')
      webhookEventsTotal.inc({ type: 'unknown', action: 'unknown', result: 'invalid_signature' })
      return c.json({ error: 'Invalid signature' }, 401)
    }

    // Parse payload
    let payload
    try {
      payload = LinearWebhookPayloadSchema.parse(JSON.parse(rawBody))
    } catch (error) {
      logger.error({ error }, '[webhook] Invalid payload')
      webhookEventsTotal.inc({ type: 'unknown', action: 'unknown', result: 'invalid_payload' })
      return c.json({ error: 'Invalid payload' }, 400)
    }

    logger.info(`[webhook] Received ${payload.type} ${payload.action}`)
    webhookEventsTotal.inc({ type: payload.type, action: payload.action, result: 'received' })

    // Check for duplicate events
    const dedupKey = deliveryId
      ? `delivery:${deliveryId}`
      : payload.webhookId
        ? `webhook:${payload.webhookId}`
        : getDeduplicationKey(payload.type, payload.action, payload.data.id)
    if (isDuplicateEvent(dedupKey)) {
      logger.info(`[webhook] Duplicate event ignored: ${dedupKey}`)
      webhookEventsTotal.inc({ type: payload.type, action: payload.action, result: 'deduplicated' })
      return c.json({ status: 'ignored', reason: 'Duplicate event' })
    }
    markEventProcessed(dedupKey)

    // Handle Issue events
    if (payload.type === 'Issue') {
      const issueResult = LinearIssueDataSchema.safeParse(payload.data)
      if (!issueResult.success) {
        logger.error({ error: issueResult.error }, '[webhook] Invalid issue data')
        return c.json({ error: 'Invalid issue data' }, 400)
      }

      const issue = issueResult.data
      logger.info(`[webhook] Issue ${payload.action}: ${issue.identifier || issue.id} - ${issue.title}`)

      const updatedFromLabelIds = payload.type === 'Issue'
        ? payload.updatedFrom?.labelIds
        : undefined

      const triggerMatch = matchTriggers(config.linear.triggers, {
        eventType: 'Issue',
        action: payload.action,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          labels: normalizeLabels(issue.labels),
          labelsDetailed: issue.labels,
          labelIds: issue.labelIds ?? issue.labels?.map((label) => label.id),
          updatedFromLabelIds,
        },
      })

      if (!triggerMatch) {
        logger.info('[webhook] No matching trigger for issue')
        return c.json({ status: 'ignored', reason: 'No trigger match' })
      }

      triggerMatchesTotal.inc({ triggerType: triggerMatch.trigger.type, action: triggerMatch.action })

      const ackMessage = triggerMatch.action === 'quick'
        ? '🚀 **Sandbox provisioning...**'
        : triggerMatch.action === 'context'
          ? '🔍 **Starting context discovery...**'
          : triggerMatch.action === 'guide'
            ? '📘 **User guide in progress..**'
            : triggerMatch.action === 'plan'
              ? 'Creating plan..'
              : triggerMatch.action === 'review'
                ? 'Reviewing changes..'
            : triggerMatch.action === 'github'
                  ? 'Publishing PR..'
            : '**On it...** Starting automation workflow...'

      createComment(config.linear, issue.id, ackMessage).then((ackCommentId) => {
        if (triggerMatch.action === 'quick') {
          processSandboxRequest(config, issue.id, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'context') {
          processContextOnly(config, issue.id, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'guide') {
          processGuideRequest(config, issue.id, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'plan') {
          processPlanRequest(config, issue.id, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'review') {
          processReviewRequest(config, issue.id, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'github') {
          processGithubRequest(config, issue.id, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        processContextRequest(config, issue.id, ackCommentId, triggerMatch.trigger).catch((error) => {
          logger.error({ error }, '[webhook] Background processing failed')
        })
      }).catch((error) => {
        logger.error({ error }, '[webhook] Failed to post acknowledgment')
      })

      return c.json({ status: 'processing', trigger: triggerMatch.trigger.type })
    }

    if (payload.action !== 'create') {
      return c.json({ status: 'ignored', reason: 'Not a create event' })
    }

    if (payload.type === 'Comment') {
      const commentResult = LinearCommentDataSchema.safeParse(payload.data)
      if (!commentResult.success) {
        logger.error({ error: commentResult.error }, '[webhook] Invalid comment data')
        return c.json({ error: 'Invalid comment data' }, 400)
      }

      const comment = commentResult.data
      logger.info(`[webhook] Comment on issue ${comment.issueId}: ${comment.body.substring(0, 100)}...`)

      const triggerMatch = matchTriggers(config.linear.triggers, {
        eventType: 'Comment',
        action: payload.action,
        issue: { id: comment.issueId },
        comment: { id: comment.id, body: comment.body },
      })

      if (!triggerMatch) {
        logger.info('[webhook] No trigger found')
        return c.json({ status: 'ignored', reason: 'No trigger' })
      }

      triggerMatchesTotal.inc({ triggerType: triggerMatch.trigger.type, action: triggerMatch.action })

      const ackMessage = triggerMatch.action === 'reply'
        ? `Starting reply with ${triggerMatch.trigger.value}...`
        : triggerMatch.action === 'quick'
        ? '🚀 **Sandbox provisioning...**'
        : triggerMatch.action === 'context'
          ? '🔍 **Starting context discovery...**'
          : triggerMatch.action === 'guide'
            ? '📘 **User guide in progress..**'
            : triggerMatch.action === 'plan'
              ? 'Creating plan..'
            : '**On it...** Starting automation workflow...'

      createComment(config.linear, comment.issueId, ackMessage).then((ackCommentId) => {
        if (triggerMatch.action === 'reply') {
          processMentionReply(config, comment.issueId, { id: comment.id, body: comment.body }, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'quick') {
          processSandboxRequest(config, comment.issueId, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'context') {
          processContextOnly(config, comment.issueId, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'guide') {
          processGuideRequest(config, comment.issueId, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        if (triggerMatch.action === 'plan') {
          processPlanRequest(config, comment.issueId, ackCommentId, triggerMatch.trigger).catch((error) => {
            logger.error({ error }, '[webhook] Background processing failed')
          })
          return
        }

        processContextRequest(config, comment.issueId, ackCommentId, triggerMatch.trigger).catch((error) => {
          logger.error({ error }, '[webhook] Background processing failed')
        })
      }).catch((error) => {
        logger.error({ error }, '[webhook] Failed to post acknowledgment')
      })

      return c.json({ status: 'processing', trigger: triggerMatch.trigger.type })
    }

    return c.json({ status: 'ignored', reason: 'Unhandled event type' })
  }
}

function buildSandboxRunConfig(config: AppConfig, workspaceName: string, trigger?: TriggerConfig) {
  const override = getSandboxOverride(config, workspaceName)
  const base = config.sandbox.default
  const { workspace: _workspace, ...overrideValues } = override ?? {}
  const merged = {
    ...base,
    ...overrideValues,
  }

  return {
    agent: trigger?.agent ?? merged.agent,
    agentMode: merged.agentMode,
    permissionMode: merged.permissionMode,
    timeoutMs: merged.timeoutMs,
    progressIntervalMs: merged.progressIntervalMs,
    includeToolCalls: config.progress.includeToolCalls,
    reasoning: merged.reasoning,
    promptPrefix: merged.promptPrefix,
    promptSuffix: merged.promptSuffix,
  }
}

type TriggerLabelFailureAutomationResult = {
  removed: boolean
  warning?: string
}

async function maybeRemoveTriggerLabelOnFailureSafe(
  config: AppConfig,
  workspace: WorkspaceConfig,
  issueId: string,
  trigger: TriggerConfig | undefined
): Promise<TriggerLabelFailureAutomationResult> {
  if (!trigger || trigger.type !== 'label') return { removed: false }

  const enabled = Boolean(workspace.automation?.labels?.removeTriggerLabelOnFailure)
  if (!enabled) return { removed: false }

  const labelName = trigger.value.trim()
  if (!labelName) return { removed: false }

  try {
    const snapshot = await getIssueAutomationSnapshot(config.linear, issueId)
    const label = snapshot.labels.find((l) => l.name.trim().toLowerCase() === labelName.toLowerCase())
    if (!label) return { removed: false }

    const newLabelIds = snapshot.labelIds.filter((id) => id !== label.id)
    if (newLabelIds.length === snapshot.labelIds.length) return { removed: false }

    await updateIssue(config.linear, issueId, { labelIds: newLabelIds })
    return { removed: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { removed: false, warning: `Failed to remove trigger label "${labelName}": ${msg}` }
  }
}

async function updateAckWithFailure(
  config: AppConfig,
  ackCommentId: string,
  options: {
    bot: WorkflowBotName
    issueRef?: string
    failure: WorkflowFailure
    workspace?: WorkspaceConfig
    issueId?: string
    trigger?: TriggerConfig
  }
): Promise<void> {
  const { bot, issueRef, failure, workspace, issueId, trigger } = options

  let labelFailure: TriggerLabelFailureAutomationResult | null = null
  if (workspace && issueId) {
    labelFailure = await maybeRemoveTriggerLabelOnFailureSafe(config, workspace, issueId, trigger)
  }

  await updateComment(
    config.linear,
    ackCommentId,
    formatFailureAck({
      bot,
      issueRef,
      failure,
      triggerLabelRemoved: Boolean(labelFailure?.removed),
      automationWarning: labelFailure?.warning,
    })
  )
}

/**
 * Process the context builder request in the background
 * Flow: Context → Worktree → Sandbox Agent → Result
 */
async function processContextRequest(
  config: AppConfig,
  issueId: string,
  ackCommentId: string,
  trigger?: TriggerConfig
): Promise<void> {
  try {
    // Fetch issue details
    logger.info(`[process] Fetching issue ${issueId}`)
    const issue = await getIssueWithComments(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[process] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    // Build task description from issue
    const taskDescription = [issue.title, issue.description].filter(Boolean).join('\n\n')

    if (!taskDescription.trim()) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Code Bot',
        issueRef,
        failure: {
          code: 'NO_TASK_DESCRIPTION',
          message: 'No issue description provided.',
          nextSteps: ['Add a description to the issue and retry the workflow.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    let contextOutput = ''
    if (config.context.enabled) {
      // Phase 1: Context building
      await updateComment(
        config.linear,
        ackCommentId,
        `**Phase 1/3:** Building context for **${issueRef}**\n\n_Analyzing codebase..._`
      )

      logger.info('[process] Running context builder...')
      const contextResult = await runContextBuilder(taskDescription, workspace.localPath, config.context)

      if (!contextResult.success) {
        await createComment(
          config.linear,
          issue.id,
          formatOutputForComment(contextResult, config.context.maxOutputSize)
        )
        await updateAckWithFailure(config, ackCommentId, {
          bot: 'Code Bot',
          issueRef,
          failure: {
            code: 'UNKNOWN',
            message: 'Context builder failed. See the latest comment for details.',
          },
          workspace,
          issueId: issue.id,
          trigger,
        })
        return
      }

      contextOutput = contextResult.output

      await createComment(
        config.linear,
        issue.id,
        formatOutputForComment(contextResult, config.context.maxOutputSize)
      )
    } else {
      logger.info('[process] Context builder disabled, skipping to worktree')
    }

    // Phase 2: Create worktree
    await updateComment(
      config.linear,
      ackCommentId,
      `**Phase 2/3:** Creating worktree for **${issueRef}**\n\n_Setting up isolated environment..._`
    )

    const worktree = await createWorktree(workspace, issueRef, config.worktree)

    if (!worktree.success) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Code Bot',
        issueRef,
        failure: {
          code: 'UNKNOWN',
          message: 'Worktree creation failed.',
          nextSteps: ['Check server logs for details and retry the workflow.'],
          details: worktree.error,
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    logger.info(`[process] Worktree created at ${worktree.path}`)

    // Phase 3: Sandbox agent
    const runConfig = buildSandboxRunConfig(config, workspace.name, trigger)
    const startAutomationWarning = await applyCodingStartAutomationSafe(config, workspace, issue.id, issue.teamId, trigger)
    const startWarningLine = startAutomationWarning ? `\n\n_Automation warning:_ ${startAutomationWarning}` : ''

    await updateComment(
      config.linear,
      ackCommentId,
      `**Phase 3/3:** Agent working on task for **${issueRef}**\n\nAgent: \`${runConfig.agent}\`\nWorktree: \`${worktree.path}\`\nBranch: \`${worktree.branch}\`\n\n_This may take up to 30 minutes..._${startWarningLine}`
    )

    const sandboxResult = await runSandboxAgentWorkflow(
      config,
      issue,
      contextOutput,
      worktree.path,
      ackCommentId,
      runConfig
    )

    // Final verification comment (post as new comment to preserve chronological order)
    const verificationComment = formatVerificationComment(
      issue,
      sandboxResult,
      worktree,
      config.progress.includeFileChanges
    )
    await createComment(config.linear, issue.id, verificationComment)

    const successAutomationWarning = await applyCodingSuccessAutomationSafe(config, workspace, issue.id, issue.teamId, trigger, sandboxResult)

    if (sandboxResult.success) {
      const endWarningLine = successAutomationWarning ? `\n\n_Automation warning:_ ${successAutomationWarning}` : ''
      await updateComment(
        config.linear,
        ackCommentId,
        `✅ **Completed** for **${issueRef}**.\n\nSee the latest comment for details.${endWarningLine}`
      )
      logger.info(`[process] Completed for ${issueRef}`)
    } else {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Code Bot',
        issueRef,
        failure: {
          code: 'UNKNOWN',
          message: 'Agent run failed. See the latest comment for details.',
          details: sandboxResult.error || undefined,
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      logger.info(`[process] Failed for ${issueRef}`)
    }

    if (config.worktree.cleanupOnComplete) {
      await removeWorktreeSafe(workspace.localPath, worktree.path)
    }
  } catch (error) {
    logger.error({ error }, `[process] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'context',
      error: error instanceof Error ? error.message : String(error),
    })

    // Try to update with error
    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(
        config.linear,
        ackCommentId,
        formatFailureAck({
          bot: 'Code Bot',
          failure: {
            code: 'UNKNOWN',
            message: 'Unhandled error while running workflow.',
            details: errorMessage,
          },
        })
      )
    } catch {
      logger.error('[process] Failed to post error comment')
    }
  }
}

/**
 * Process sandbox request directly (skip context building)
 * Flow: Worktree → Sandbox Agent → Result
 */
async function processSandboxRequest(
  config: AppConfig,
  issueId: string,
  ackCommentId: string,
  trigger?: TriggerConfig
): Promise<void> {
  try {
    // Fetch issue details with comments
    logger.info(`[sandbox] Fetching issue ${issueId}`)
    const issue = await getIssueWithComments(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[sandbox] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    // Build task description from issue
    const taskDescription = [issue.title, issue.description].filter(Boolean).join('\n\n')

    if (!taskDescription.trim()) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Code Bot',
        issueRef,
        failure: {
          code: 'NO_TASK_DESCRIPTION',
          message: 'No issue description provided.',
          nextSteps: ['Add a description to the issue and retry the workflow.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    // Step 1: Create worktree
    await updateComment(
      config.linear,
      ackCommentId,
      `🚀 **Sandbox provisioning...**\n\nCreating worktree for **${issueRef}**`
    )

    const worktree = await createWorktree(workspace, issueRef, config.worktree)

    if (!worktree.success) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Code Bot',
        issueRef,
        failure: {
          code: 'UNKNOWN',
          message: 'Worktree creation failed.',
          nextSteps: ['Check server logs for details and retry the workflow.'],
          details: worktree.error,
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    logger.info(`[sandbox] Worktree created at ${worktree.path}`)

    const runConfig = buildSandboxRunConfig(config, workspace.name, trigger)
    const startAutomationWarning = await applyCodingStartAutomationSafe(config, workspace, issue.id, issue.teamId, trigger)
    const startWarningLine = startAutomationWarning ? `\n\n_Automation warning:_ ${startAutomationWarning}` : ''

    // Step 2: Sandbox created
    await updateComment(
      config.linear,
      ackCommentId,
      `✅ **Sandbox created**\n\nAgent: \`${runConfig.agent}\`\nWorktree: \`${worktree.path}\`\nBranch: \`${worktree.branch}\`\n\n⏳ **Agent starting...**${startWarningLine}`
    )

    // Step 3: Run sandbox agent with template prompt
    const sandboxResult = await runSandboxAgentWorkflowDirect(
      config,
      issue,
      worktree.path,
      ackCommentId,
      runConfig
    )

    // Final verification comment (post as new comment to preserve chronological order)
    const verificationComment = formatVerificationComment(
      issue,
      sandboxResult,
      worktree,
      config.progress.includeFileChanges
    )
    await createComment(config.linear, issue.id, verificationComment)

    const successAutomationWarning = await applyCodingSuccessAutomationSafe(config, workspace, issue.id, issue.teamId, trigger, sandboxResult)

    if (sandboxResult.success) {
      const endWarningLine = successAutomationWarning ? `\n\n_Automation warning:_ ${successAutomationWarning}` : ''
      await updateComment(
        config.linear,
        ackCommentId,
        `✅ **Completed** for **${issueRef}**.\n\nSee the latest comment for details.${endWarningLine}`
      )
      logger.info(`[sandbox] Completed for ${issueRef}`)
    } else {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Code Bot',
        issueRef,
        failure: {
          code: 'UNKNOWN',
          message: 'Agent run failed. See the latest comment for details.',
          details: sandboxResult.error || undefined,
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      logger.info(`[sandbox] Failed for ${issueRef}`)
    }

    if (config.worktree.cleanupOnComplete) {
      await removeWorktreeSafe(workspace.localPath, worktree.path)
    }
  } catch (error) {
    logger.error({ error }, `[sandbox] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'quick',
      error: error instanceof Error ? error.message : String(error),
    })

    // Try to update with error
    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(
        config.linear,
        ackCommentId,
        formatFailureAck({
          bot: 'Code Bot',
          failure: {
            code: 'UNKNOWN',
            message: 'Unhandled error while running quick workflow.',
            details: errorMessage,
          },
        })
      )
    } catch {
      logger.error('[sandbox] Failed to post error comment')
    }
  }
}

/**
 * Process context-only request (no worktree, no agent)
 */
async function processContextOnly(
  config: AppConfig,
  issueId: string,
  ackCommentId: string,
  trigger?: TriggerConfig
): Promise<void> {
  try {
    logger.info(`[context] Fetching issue ${issueId}`)
    const issue = await getIssueWithComments(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[context] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    const taskDescription = [issue.title, issue.description].filter(Boolean).join('\n\n')
    if (!taskDescription.trim()) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Context Bot',
        issueRef,
        failure: {
          code: 'NO_TASK_DESCRIPTION',
          message: 'No issue description provided.',
          nextSteps: ['Add a description to the issue and retry the workflow.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    if (!config.context.enabled) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Context Bot',
        issueRef,
        failure: {
          code: 'CONTEXT_DISABLED',
          message: 'RepoPrompt integration is disabled (`context.enabled=false`).',
          nextSteps: ['Enable `context.enabled` in `config.yaml`, then retry.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    await updateComment(
      config.linear,
      ackCommentId,
      `**Context:** Building context for **${issueRef}**\n\n_Analyzing codebase..._`
    )

    const contextResult = await runContextBuilder(taskDescription, workspace.localPath, config.context)
    await createComment(
      config.linear,
      issue.id,
      formatOutputForComment(contextResult, config.context.maxOutputSize)
    )

    if (contextResult.success) {
      await updateComment(
        config.linear,
        ackCommentId,
        `✅ **Context created** for **${issueRef}**.\n\nSee the latest comment for details.`
      )
      return
    }

    await updateAckWithFailure(config, ackCommentId, {
      bot: 'Context Bot',
      issueRef,
      failure: {
        code: 'UNKNOWN',
        message: 'Context builder failed. See the latest comment for details.',
      },
      workspace,
      issueId: issue.id,
      trigger,
    })
  } catch (error) {
    logger.error({ error }, `[context] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'context',
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(config.linear, ackCommentId, formatFailureAck({
        bot: 'Context Bot',
        failure: {
          code: 'UNKNOWN',
          message: 'Unhandled error while building context.',
          details: errorMessage,
        },
      }))
    } catch {
      logger.error('[context] Failed to post error comment')
    }
  }
}

/**
 * Process plan request (RepoPrompt builder --type plan)
 */
async function processPlanRequest(
  config: AppConfig,
  issueId: string,
  ackCommentId: string,
  trigger?: TriggerConfig
): Promise<void> {
  try {
    logger.info(`[plan] Fetching issue ${issueId}`)
    const issue = await getIssue(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[plan] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    const taskDescription = [issue.title, issue.description].filter(Boolean).join('\n\n')
    if (!taskDescription.trim()) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Plan Bot',
        issueRef,
        failure: {
          code: 'NO_TASK_DESCRIPTION',
          message: 'No issue description provided.',
          nextSteps: ['Add a description to the issue and retry the workflow.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    if (!config.context.enabled) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Plan Bot',
        issueRef,
        failure: {
          code: 'CONTEXT_DISABLED',
          message: 'RepoPrompt integration is disabled (`context.enabled=false`).',
          nextSteps: ['Enable `context.enabled` in `config.yaml`, then retry.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    await updateComment(
      config.linear,
      ackCommentId,
      `Creating plan..\n\nIssue: **${issueRef}**\n\n_Analyzing codebase..._`
    )

    const planResult = await runPlanBuilder(taskDescription, workspace.localPath, config.context)
    await createComment(
      config.linear,
      issue.id,
      formatPlanOutputForComment(planResult, config.context.maxOutputSize)
    )

    if (planResult.success) {
      await updateComment(
        config.linear,
        ackCommentId,
        `✅ **Plan created** for **${issueRef}**.\n\nSee the latest comment for details.`
      )
      return
    }

    await updateAckWithFailure(config, ackCommentId, {
      bot: 'Plan Bot',
      issueRef,
      failure: {
        code: 'UNKNOWN',
        message: 'Plan generation failed. See the latest comment for details.',
      },
      workspace,
      issueId: issue.id,
      trigger,
    })
  } catch (error) {
    logger.error({ error }, `[plan] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'plan',
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(config.linear, ackCommentId, formatFailureAck({
        bot: 'Plan Bot',
        failure: {
          code: 'UNKNOWN',
          message: 'Unhandled error while generating plan.',
          details: errorMessage,
        },
      }))
    } catch {
      logger.error('[plan] Failed to post error comment')
    }
  }
}

async function getOriginHeadRef(repoPath: string): Promise<{ remoteRef: string; branch: string }> {
  const ref = await $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(repoPath).quiet().text()
  const trimmed = ref.trim()
  const prefix = 'refs/remotes/origin/'
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`Unexpected origin/HEAD ref: ${trimmed}`)
  }
  const branch = trimmed.slice(prefix.length).trim()
  if (!branch) {
    throw new Error(`Unable to resolve origin/HEAD branch from: ${trimmed}`)
  }
  return { remoteRef: `origin/${branch}`, branch }
}

async function assertIsGitWorktree(pathToRepo: string): Promise<void> {
  const inside = await $`git rev-parse --is-inside-work-tree`.cwd(pathToRepo).quiet().text()
  if (inside.trim() !== 'true') {
    throw new Error(`Not a git worktree: ${pathToRepo}`)
  }
}

/**
 * Process code review request (Sandbox Agent; read-only; posts review to Linear)
 */
async function processReviewRequest(
  config: AppConfig,
  issueId: string,
  ackCommentId: string,
  trigger?: TriggerConfig
): Promise<void> {
  try {
    logger.info(`[review] Fetching issue ${issueId}`)
    const issue = await getIssueWithComments(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[review] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    const spec = getWorktreeSpec(workspace, issueRef, config.worktree)

    // Review requires an existing worktree (typically produced by the `code` label flow).
    try {
      await assertIsGitWorktree(spec.path)
    } catch {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Review Bot',
        issueRef,
        failure: {
          code: 'NO_WORKTREE',
          message: `No worktree found for **${issueRef}**.`,
          nextSteps: ['Run the `code` workflow first, then re-apply the `review` label.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    let base: { remoteRef: string; branch: string }
    try {
      base = await getOriginHeadRef(workspace.localPath)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Review Bot',
        issueRef,
        failure: {
          code: 'ORIGIN_HEAD_UNRESOLVED',
          message: 'Unable to resolve the base branch from `origin/HEAD`.',
          nextSteps: [
            'Ensure the repo has a remote `origin` with a default branch.',
            'Run `git remote set-head origin --auto` in the main repo checkout.',
            'Then retry the `review` workflow.',
          ],
          details: msg,
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    const diffStat = await $`git diff --stat ${base.remoteRef}...HEAD`.cwd(spec.path).quiet().text()
    const diff = await $`git diff ${base.remoteRef}...HEAD`.cwd(spec.path).quiet().text()

    if (!diff.trim()) {
      await updateComment(
        config.linear,
        ackCommentId,
        `## Review Bot\n\nNo diff detected for **${issueRef}** (branch is identical to \`${base.remoteRef}\`).`
      )
      return
    }

    const truncatedDiff = diff.length > config.review.maxDiffChars
      ? diff.substring(0, config.review.maxDiffChars) + '\n\n... (truncated)'
      : diff

    await updateComment(
      config.linear,
      ackCommentId,
      `Reviewing changes..\n\nIssue: **${issueRef}**\nBranch: \`${spec.branch}\`\nBase: \`${base.remoteRef}\``
    )

    const startTime = Date.now()
    const baseRunConfig = buildSandboxRunConfig(config, workspace.name)
    const runConfig = { ...baseRunConfig, permissionMode: 'plan' as const }

    const recentComments = formatRecentComments(
      issue.comments,
      new Set([ackCommentId]),
      config.review.maxContextComments
    )

    const prompt = await buildReviewPrompt(
      issue.title,
      issue.description,
      diffStat.trim(),
      truncatedDiff,
      config.review,
      {
        promptPrefix: runConfig.promptPrefix,
        promptSuffix: runConfig.promptSuffix,
        reasoning: runConfig.reasoning,
      }
    )

    let lastUpdateTime = 0
    const onProgress: ProgressCallback = async (update) => {
      const now = Date.now()
      if (now - lastUpdateTime < config.progress.updateIntervalMs) return
      lastUpdateTime = now
      await updateComment(
        config.linear,
        ackCommentId,
        `Reviewing changes..\n\nIssue: **${issueRef}**\nBranch: \`${spec.branch}\`\nBase: \`${base.remoteRef}\`\n\n_Last update: ${update.message}_`
      ).catch((error) => logger.error({ error }, '[review] Failed to post progress update'))
    }

    const sessionId = `review-${issueRef}-${Date.now()}`
    const result = await runSandboxAgent(
      sessionId,
      `${prompt}\n\n## Recent Comments\n\n${recentComments}`,
      spec.path,
      onProgress,
      runConfig,
      config.sandbox,
      { permissionPolicy: 'review' }
    )

    recordAgentMetrics('review', result, startTime)

    const reviewText = truncateForLinear(result.answer?.trim() || '', config.review.maxCommentChars)
    const warningLine = result.filesModified.length > 0
      ? `\n\nWarning: Agent reported file modifications in a review workflow: ${result.filesModified.map((f) => `\`${f}\``).join(', ')}`
      : ''

    const errorBlock = result.success
      ? ''
      : `\n\n### Error\n\n\`\`\`\n${result.error || 'Agent run failed'}\n\`\`\``

    const body = `## Code Review

**Issue:** ${issueRef}
**Branch:** \`${spec.branch}\`
**Base:** \`${base.remoteRef}\`

${reviewText || '_No review response was produced._'}

_Session:_ \`${result.sessionId}\`${warningLine}${errorBlock}`

    await createComment(config.linear, issue.id, body)

    if (result.success) {
      await updateComment(
        config.linear,
        ackCommentId,
        `✅ **Review completed** for **${issueRef}**.\n\nSee the latest comment for details.`
      )
      return
    }

    await updateAckWithFailure(config, ackCommentId, {
      bot: 'Review Bot',
      issueRef,
      failure: {
        code: 'UNKNOWN',
        message: 'Review run failed. See the latest comment for details.',
        details: result.error || undefined,
      },
      workspace,
      issueId: issue.id,
      trigger,
    })
  } catch (error) {
    logger.error({ error }, `[review] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'review',
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(
        config.linear,
        ackCommentId,
        formatFailureAck({
          bot: 'Review Bot',
          failure: {
            code: 'UNKNOWN',
            message: 'Unhandled error while running review.',
            details: errorMessage,
          },
        })
      )
    } catch {
      logger.error('[review] Failed to post error comment')
    }
  }
}

async function resolveGitHubRepoForWorkspace(config: AppConfig, workspaceName: string) {
  return config.github.repos.find((repo) => repo.workspace === workspaceName) ?? null
}

type GitHubRepoConfig = AppConfig['github']['repos'][number]

async function buildPrBody(
  repoConfig: GitHubRepoConfig,
  issue: { identifier?: string; id: string; title: string; description?: string; url?: string },
  branch: string
): Promise<string> {
  const issueRef = issue.identifier || issue.id
  const variables = {
    ISSUE_ID: issueRef,
    ISSUE_TITLE: issue.title,
    ISSUE_URL: issue.url ?? '',
    ISSUE_DESCRIPTION: issue.description ?? '',
    BRANCH: branch,
  }

  if (repoConfig.pr.bodyTemplatePath) {
    const resolved = repoConfig.pr.bodyTemplatePath.startsWith('/')
      ? repoConfig.pr.bodyTemplatePath
      : new URL(`../${repoConfig.pr.bodyTemplatePath}`, import.meta.url).pathname
    const template = await Bun.file(resolved).text()
    return renderTemplate(template, variables)
  }

  return `Automated PR for Linear issue **${issueRef}**.

Issue: ${issue.url ?? '(no url)'}

### Summary
${issue.title}

### Description
${issue.description || '(no description)'}
`
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/)
  return match ? match[0] : null
}

/**
 * Process GitHub publish request (commit/push/PR via gh; posts PR link to Linear)
 */
async function processGithubRequest(
  config: AppConfig,
  issueId: string,
  ackCommentId: string,
  trigger?: TriggerConfig
): Promise<void> {
  try {
    logger.info(`[github] Fetching issue ${issueId}`)
    const issue = await getIssue(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[github] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    if (!config.github.enabled) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'GitHub Bot',
        issueRef,
        failure: {
          code: 'GITHUB_DISABLED',
          message: 'GitHub integration is disabled (`github.enabled=false`).',
          nextSteps: ['Enable `github.enabled` and configure `github.repos[]`, then retry.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    const repoConfig = await resolveGitHubRepoForWorkspace(config, workspace.name)
    if (!repoConfig) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'GitHub Bot',
        issueRef,
        failure: {
          code: 'GITHUB_REPO_NOT_CONFIGURED',
          message: `No GitHub repo configured for workspace: \`${workspace.name}\`.`,
          nextSteps: ['Add a matching entry to `github.repos[]`, then retry.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    const spec = getWorktreeSpec(workspace, issueRef, config.worktree)
    try {
      await assertIsGitWorktree(spec.path)
    } catch {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'GitHub Bot',
        issueRef,
        failure: {
          code: 'NO_WORKTREE',
          message: `No worktree found for **${issueRef}**.`,
          nextSteps: ['Run the `code` workflow first, then re-apply the `github` label.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    await updateComment(
      config.linear,
      ackCommentId,
      `Publishing PR..\n\nIssue: **${issueRef}**\nBranch: \`${spec.branch}\`\nRepo: \`${repoConfig.repo}\``
    )

    // Ensure gh is available and authenticated (non-interactive).
    try {
      await $`gh --version`.quiet()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'GitHub Bot',
        issueRef,
        failure: {
          code: 'UNKNOWN',
          message: 'GitHub CLI (`gh`) is not available or not authenticated.',
          nextSteps: [
            'Install `gh` and authenticate it on the host running this service.',
            'Then retry the `github` workflow.',
          ],
          details: msg,
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    const status = await $`git status --porcelain`.cwd(spec.path).quiet().text()
    if (status.trim()) {
      if (!config.github.autoCommit) {
        await updateAckWithFailure(config, ackCommentId, {
          bot: 'GitHub Bot',
          issueRef,
          failure: {
            code: 'WORKTREE_DIRTY',
            message: 'Worktree has uncommitted changes.',
            nextSteps: ['Commit the changes in the worktree, or set `github.autoCommit: true`, then retry.'],
            details: `Worktree: ${spec.path}`,
          },
          workspace,
          issueId: issue.id,
          trigger,
        })
        return
      }

      const commitMessage = renderTemplate(config.github.commitMessageTemplate, {
        ISSUE_ID: issueRef,
        ISSUE_TITLE: issue.title,
      }).trim()

      await $`git add -A`.cwd(spec.path).quiet()
      try {
        await $`git commit -m ${commitMessage}`.cwd(spec.path).quiet()
      } catch (error) {
        // If nothing to commit after add, ignore.
        const msg = error instanceof Error ? error.message : String(error)
        if (!msg.toLowerCase().includes('nothing to commit')) {
          throw error
        }
      }
    }

    await $`git push -u ${repoConfig.remote} ${spec.branch}`.cwd(spec.path)

    const base = repoConfig.baseBranch ?? (await getOriginHeadRef(workspace.localPath)).branch

    // If a PR already exists for this branch, reuse it.
    const existingJson = await $`gh pr list --repo ${repoConfig.repo} --head ${spec.branch} --state open --json url,number`.quiet().text()
    let prUrl: string | null = null
    try {
      const parsed = JSON.parse(existingJson) as Array<{ url?: string }>
      prUrl = parsed.find((item) => typeof item.url === 'string' && item.url)?.url ?? null
    } catch {
      // ignore
    }

    if (!prUrl) {
      const title = renderTemplate(repoConfig.pr.titleTemplate, {
        ISSUE_ID: issueRef,
        ISSUE_TITLE: issue.title,
      }).trim()

      const body = await buildPrBody(repoConfig, issue, spec.branch)
      const createOutput = repoConfig.pr.draft
        ? await $`gh pr create --repo ${repoConfig.repo} --head ${spec.branch} --base ${base} --title ${title} --body ${body} --draft`.quiet().text()
        : await $`gh pr create --repo ${repoConfig.repo} --head ${spec.branch} --base ${base} --title ${title} --body ${body}`.quiet().text()

      prUrl = extractFirstUrl(createOutput) || null
      if (!prUrl) {
        throw new Error(`Unable to parse PR URL from gh output:\n${createOutput}`)
      }
    }

    const body = `## GitHub PR

PR: ${prUrl}

**Issue:** ${issueRef}
**Repo:** \`${repoConfig.repo}\`
**Branch:** \`${spec.branch}\`
**Base:** \`${base}\`
`

    await createComment(config.linear, issue.id, body)

    await updateComment(
      config.linear,
      ackCommentId,
      `✅ **PR published** for **${issueRef}**.\n\n${prUrl}`
    )
  } catch (error) {
    logger.error({ error }, `[github] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'github',
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(
        config.linear,
        ackCommentId,
        formatFailureAck({
          bot: 'GitHub Bot',
          failure: {
            code: 'UNKNOWN',
            message: 'Unhandled error while publishing PR.',
            details: errorMessage,
          },
        })
      )
    } catch {
      logger.error('[github] Failed to post error comment')
    }
  }
}

/**
 * Process mention-based Q&A reply request (Sandbox Agent only)
 */
async function processMentionReply(
  config: AppConfig,
  issueId: string,
  triggeringComment: { id: string; body: string },
  ackCommentId: string,
  trigger: TriggerConfig
): Promise<void> {
  const mention = trigger.value.trim()
  const agent = trigger.agent

  try {
    if (!agent) {
      await updateComment(
        config.linear,
        ackCommentId,
        `## Mention Reply Error\n\nTrigger is missing required field "agent" (value: ${mention || '(empty)'}).`
      )
      return
    }

    logger.info(`[reply] Fetching issue ${issueId}`)
    const issue = await getIssueWithComments(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[reply] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    const question = extractMentionQuestion(triggeringComment.body, mention, config.mentionReply.stripMention)
    if (!question) {
      await updateComment(
        config.linear,
        ackCommentId,
        `## ${mention} Reply\n\nNo question found after the mention. Please write your question after ${mention}.`
      )
      return
    }

    const recentComments = formatRecentComments(
      issue.comments,
      new Set([ackCommentId, triggeringComment.id]),
      config.mentionReply.maxContextComments
    )

    await updateComment(
      config.linear,
      ackCommentId,
      `${mention}: Thinking...\n\nIssue: **${issueRef}**\nAgent: \`${agent}\`\n\n_Analyzing the codebase..._`
    )

    const startTime = Date.now()
    const baseRunConfig = buildSandboxRunConfig(config, workspace.name)
    // Use permissionMode=plan so the agent emits permission requests for MCP calls.
    // We selectively reject Linear MCP permissions to ensure only this service posts back to Linear.
    const runConfig = { ...baseRunConfig, agent, permissionMode: 'plan' as const }

    const prompt = await buildMentionReplyPrompt(
      mention,
      issueRef,
      issue.title,
      issue.description,
      issue.url,
      triggeringComment.body,
      question,
      workspace.localPath,
      recentComments,
      config.mentionReply,
      runConfig
    )

    let lastUpdateTime = 0
    const onProgress: ProgressCallback = async (update) => {
      const now = Date.now()
      if (now - lastUpdateTime < config.progress.updateIntervalMs) return
      lastUpdateTime = now
      await updateComment(
        config.linear,
        ackCommentId,
        `${mention}: Thinking...\n\nIssue: **${issueRef}**\nAgent: \`${agent}\`\n\n_Last update: ${update.message}_`
      ).catch((error) => logger.error({ error }, '[reply] Failed to post progress update'))
    }

    const sessionId = `reply-${agent}-${issueRef}-${Date.now()}`
    const result = await runSandboxAgent(
      sessionId,
      prompt,
      workspace.localPath,
      onProgress,
      runConfig,
      config.sandbox,
      { detectFileChanges: false, permissionPolicy: 'mentionReply' }
    )

    recordAgentMetrics('reply', result, startTime)

    const maxAnswerChars = config.mentionReply.maxAnswerChars
    const answer = truncateForLinear(result.answer?.trim() || '', maxAnswerChars)

    const warningLine = result.filesModified.length > 0
      ? `\n\nWarning: Agent reported file modifications in a read-only workflow: ${result.filesModified.map((f) => `\`${f}\``).join(', ')}`
      : ''

    const errorBlock = result.success
      ? ''
      : `\n\n### Error\n\n\`\`\`\n${result.error || 'Agent run failed'}\n\`\`\``

    const body = `## ${mention} Reply

**Question:**
${quoteMarkdown(question)}

**Answer:**

${answer || '_No response was produced._'}

_Session:_ \`${result.sessionId}\`${warningLine}${errorBlock}`

    await createComment(config.linear, issue.id, body)

    const completionStatus = result.success ? '✅ **Completed**' : '❌ **Failed**'
    await updateComment(
      config.linear,
      ackCommentId,
      `${completionStatus} for ${mention}.\n\nSee the latest comment for details.`
    )
  } catch (error) {
    logger.error({ error }, `[reply] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'reply',
      error: error instanceof Error ? error.message : String(error),
    })

    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(
        config.linear,
        ackCommentId,
        `## Mention Reply Error\n\n\`\`\`\n${errorMessage}\n\`\`\``
      )
    } catch {
      logger.error('[reply] Failed to post error comment')
    }
  }
}

/**
 * Process user guide request (no worktree, sandbox only)
 */
async function processGuideRequest(
  config: AppConfig,
  issueId: string,
  ackCommentId: string,
  trigger?: TriggerConfig
): Promise<void> {
  try {
    logger.info(`[guide] Fetching issue ${issueId}`)
    const issue = await getIssueWithComments(config.linear, issueId)
    const issueRef = issue.identifier || issue.id
    logger.info(`[guide] Issue: ${issueRef} - ${issue.title}`)
    const workspace = resolveWorkspaceForIssue(config, issue)

    const guide = workspace.guide
    if (!guide || guide.enabled === false) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Guide Bot',
        issueRef,
        failure: {
          code: 'GUIDE_DISABLED',
          message: 'Guide workflow is not enabled for this workspace.',
          nextSteps: ['Enable `linear.workspaces[].guide.enabled`, then retry.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      return
    }

    if (!guide.docsPath) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Guide Bot',
        issueRef,
        failure: {
          code: 'GUIDE_MISSING_DOCS_PATH',
          message: 'Guide `docsPath` is missing for this workspace.',
          nextSteps: ['Set `linear.workspaces[].guide.docsPath` to a writable directory, then retry.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      await writeDeadLetter(config, {
        timestamp: new Date().toISOString(),
        issueId,
        workflow: 'guide',
        error: 'Guide docsPath is missing for this workspace',
      })
      return
    }

    const safeIssueId = normalizeIssueIdentifier(issueRef)
    const guideFileName = `${safeIssueId}.md`
    const guideFile = path.join(guide.docsPath, guideFileName)
    const screenshotsDir = renderTemplate(guide.screenshotsDir ?? 'assets/guides/{ISSUE_ID}', {
      ISSUE_ID: safeIssueId,
    })
    const screenshotsPath = path.join(guide.docsPath, screenshotsDir)

    await mkdir(screenshotsPath, { recursive: true })

    const usernameEnv = guide.usernameEnv ?? 'GUIDE_USERNAME'
    const passwordEnv = guide.passwordEnv ?? 'GUIDE_PASSWORD'
    const username = process.env[usernameEnv]
    const password = process.env[passwordEnv]
    if (!username || !password) {
      await updateAckWithFailure(config, ackCommentId, {
        bot: 'Guide Bot',
        issueRef,
        failure: {
          code: 'GUIDE_MISSING_CREDENTIALS',
          message: `Missing credentials. Ensure \`${usernameEnv}\` and \`${passwordEnv}\` are set.`,
          nextSteps: ['Set the env vars on the host running the service, restart the process, then retry.'],
        },
        workspace,
        issueId: issue.id,
        trigger,
      })
      await writeDeadLetter(config, {
        timestamp: new Date().toISOString(),
        issueId,
        workflow: 'guide',
        error: `Missing credentials: ${usernameEnv} or ${passwordEnv}`,
      })
      return
    }

    await updateComment(
      config.linear,
      ackCommentId,
      `📘 **User guide in progress..**\n\nIssue: **${issueRef}**\nDocs path: \`${guide.docsPath}\``
    )

    const runConfig = buildSandboxRunConfig(config, workspace.name)
    const result = await runUserGuideWorkflow(config, issue, workspace.localPath, {
      docsPath: guide.docsPath,
      docsBaseUrl: guide.docsBaseUrl,
      serverUrl: guide.serverUrl ?? 'http://localhost:3000',
      usernameEnv,
      passwordEnv,
      templatePath: guide.templatePath ?? 'templates/user_guide.md',
      guideFile,
      screenshotsDir,
    }, ackCommentId, runConfig)

    const completionComment = formatGuideResultComment(issueRef, guideFile, guide.docsBaseUrl, result)
    await createComment(config.linear, issue.id, completionComment)

    if (result.success) {
      await updateComment(
        config.linear,
        ackCommentId,
        `✅ **Completed** for **${issueRef}**.\n\nSee the latest comment for details.`
      )
      return
    }

    await updateAckWithFailure(config, ackCommentId, {
      bot: 'Guide Bot',
      issueRef,
      failure: {
        code: 'UNKNOWN',
        message: 'Guide workflow failed. See the latest comment for details.',
      },
      workspace,
      issueId: issue.id,
      trigger,
    })
  } catch (error) {
    logger.error({ error }, `[guide] Error processing ${issueId}`)
    await writeDeadLetter(config, {
      timestamp: new Date().toISOString(),
      issueId,
      workflow: 'guide',
      error: error instanceof Error ? error.message : String(error),
    })

    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await updateComment(config.linear, ackCommentId, formatFailureAck({
        bot: 'Guide Bot',
        failure: {
          code: 'UNKNOWN',
          message: 'Unhandled error while generating guide.',
          details: errorMessage,
        },
      }))
    } catch {
      logger.error('[guide] Failed to post error comment')
    }
  }
}

/**
 * Run the sandbox agent workflow (with rp-cli context)
 */
async function runSandboxAgentWorkflow(
  config: AppConfig,
  issue: { identifier?: string; id: string; title: string; description?: string; comments: { id: string; body: string; createdAt: string }[] },
  context: string,
  worktreePath: string,
  commentId: string,
  runConfig: ReturnType<typeof buildSandboxRunConfig>
): Promise<SandboxResult> {
  const sessionId = `et-${issue.identifier || issue.id}-${Date.now()}`
  const startTime = Date.now()
  logger.info({
    agent: runConfig.agent,
    agentMode: runConfig.agentMode,
    reasoning: runConfig.reasoning,
    hasPromptPrefix: Boolean(runConfig.promptPrefix),
    hasPromptSuffix: Boolean(runConfig.promptSuffix),
    comments: issue.comments.length,
  }, '[sandbox] Starting full run')

  let lastUpdateTime = 0
  const onProgress: ProgressCallback = async (update) => {
    const now = Date.now()
    // Throttle updates to Linear (max once per minute)
    if (now - lastUpdateTime < config.progress.updateIntervalMs) return
    lastUpdateTime = now
    await updateComment(
      config.linear,
      commentId,
      formatProgressComment(issue, update, worktreePath)
    ).catch((error) => logger.error({ error }, '[webhook] Failed to post progress update'))
  }

  const commentsText = formatIssueComments(issue.comments)
  const prompt = buildAgentPrompt(
    issue.identifier || issue.id,
    issue.title,
    issue.description,
    context,
    commentsText,
    runConfig
  )
  const result = await runSandboxAgent(sessionId, prompt, worktreePath, onProgress, runConfig, config.sandbox)
  recordAgentMetrics('full', result, startTime)
  return result
}

/**
 * Run the sandbox agent workflow directly (template-based context)
 */
async function runSandboxAgentWorkflowDirect(
  config: AppConfig,
  issue: { identifier?: string; id: string; title: string; description?: string; comments: { id: string; body: string; createdAt: string }[] },
  worktreePath: string,
  commentId: string,
  runConfig: ReturnType<typeof buildSandboxRunConfig>
): Promise<SandboxResult> {
  const sessionId = `sb-${issue.identifier || issue.id}-${Date.now()}`
  const startTime = Date.now()
  logger.info({
    agent: runConfig.agent,
    agentMode: runConfig.agentMode,
    reasoning: runConfig.reasoning,
    hasPromptPrefix: Boolean(runConfig.promptPrefix),
    hasPromptSuffix: Boolean(runConfig.promptSuffix),
    comments: issue.comments.length,
  }, '[sandbox] Starting quick run')

  let lastUpdateTime = 0
  const onProgress: ProgressCallback = async (update) => {
    const now = Date.now()
    // Throttle updates to Linear (max once per minute)
    if (now - lastUpdateTime < config.progress.updateIntervalMs) return
    lastUpdateTime = now
    await updateComment(
      config.linear,
      commentId,
      formatProgressComment(issue, update, worktreePath)
    ).catch((error) => logger.error({ error }, '[webhook] Failed to post progress update'))
  }

  const commentsText = formatIssueComments(issue.comments)
  const prompt = await buildSandboxPrompt(issue.title, issue.description, commentsText, runConfig)
  const result = await runSandboxAgent(sessionId, prompt, worktreePath, onProgress, runConfig, config.sandbox)
  recordAgentMetrics('quick', result, startTime)
  return result
}

/**
 * Run the user guide workflow (template-based)
 */
async function runUserGuideWorkflow(
  config: AppConfig,
  issue: { identifier?: string; id: string; title: string; description?: string; comments: { id: string; body: string; createdAt: string }[] },
  workspacePath: string,
  guideConfig: {
    docsPath: string
    docsBaseUrl?: string
    serverUrl: string
    usernameEnv: string
    passwordEnv: string
    templatePath: string
    guideFile: string
    screenshotsDir: string
  },
  commentId: string,
  runConfig: ReturnType<typeof buildSandboxRunConfig>
): Promise<SandboxResult> {
  const sessionId = `guide-${issue.identifier || issue.id}-${Date.now()}`
  const startTime = Date.now()
  logger.info({
    agent: runConfig.agent,
    agentMode: runConfig.agentMode,
    reasoning: runConfig.reasoning,
    hasPromptPrefix: Boolean(runConfig.promptPrefix),
    hasPromptSuffix: Boolean(runConfig.promptSuffix),
    comments: issue.comments.length,
  }, '[guide] Starting run')

  let lastUpdateTime = 0
  const onProgress: ProgressCallback = async (update) => {
    const now = Date.now()
    if (now - lastUpdateTime < config.progress.updateIntervalMs) return
    lastUpdateTime = now
    await updateComment(
      config.linear,
      commentId,
      formatGuideProgressComment(issue, update, guideConfig.docsPath)
    ).catch((error) => logger.error({ error }, '[webhook] Failed to post guide progress update'))
  }

  const commentsText = formatIssueComments(issue.comments)
  const prompt = await buildUserGuidePrompt(
    issue.title,
    issue.description,
    commentsText,
    {
      codebasePath: workspacePath,
      docsPath: guideConfig.docsPath,
      guideFile: guideConfig.guideFile,
      screenshotsDir: guideConfig.screenshotsDir,
      serverUrl: guideConfig.serverUrl,
      usernameEnv: guideConfig.usernameEnv,
      passwordEnv: guideConfig.passwordEnv,
      templatePath: guideConfig.templatePath,
    },
    runConfig
  )

  const result = await runSandboxAgent(sessionId, prompt, workspacePath, onProgress, runConfig, config.sandbox)
  recordAgentMetrics('guide', result, startTime)
  return result
}

function recordAgentMetrics(action: 'full' | 'quick' | 'guide' | 'reply' | 'review', result: SandboxResult, startTime: number): void {
  const outcome = result.success ? 'success' : 'failure'
  agentRunsTotal.inc({ action, outcome })
  agentRunDurationSeconds.observe({ action, outcome }, (Date.now() - startTime) / 1000)
}

async function applyCodingStartAutomationSafe(
  config: AppConfig,
  workspace: WorkspaceConfig,
  issueId: string,
  teamId: string | undefined,
  trigger?: TriggerConfig
): Promise<string | null> {
  const desired = workspace.automation?.coding?.setInProgressState?.trim()
  if (!desired) return null
  if (!teamId) return null

  try {
    const stateId = await resolveWorkflowStateId(config.linear, teamId, desired)
    await updateIssue(config.linear, issueId, { stateId })
    logger.info({ issueId, teamId, stateId, trigger: trigger?.value }, '[automation] Moved issue to In Progress')
    return null
  } catch (error) {
    logger.warn({ error, issueId, teamId, desired, trigger: trigger?.value }, '[automation] Failed to move issue to In Progress')
    const msg = error instanceof Error ? error.message : String(error)
    return `Failed to move issue to "${desired}": ${msg}`
  }
}

async function applyCodingSuccessAutomationSafe(
  config: AppConfig,
  workspace: WorkspaceConfig,
  issueId: string,
  teamId: string | undefined,
  trigger: TriggerConfig | undefined,
  result: SandboxResult
): Promise<string | null> {
  if (!result.success) return null

  const coding = workspace.automation?.coding
  if (!coding) return null

  const desiredReview = coding.setInReviewStateOnSuccess?.trim()
  const shouldRemoveLabel = Boolean(coding.removeTriggerLabelOnSuccess)

  if (!desiredReview && !shouldRemoveLabel) return null
  if (!teamId) return null

  try {
    const update: { stateId?: string; labelIds?: string[] } = {}

    if (desiredReview) {
      update.stateId = await resolveWorkflowStateId(config.linear, teamId, desiredReview)
    }

    if (shouldRemoveLabel && trigger?.type === 'label') {
      const labelName = trigger.value.trim()
      if (labelName) {
        const snapshot = await getIssueAutomationSnapshot(config.linear, issueId)
        const label = snapshot.labels.find((l) => l.name.trim().toLowerCase() === labelName.toLowerCase())
        if (label) {
          const newLabelIds = snapshot.labelIds.filter((id) => id !== label.id)
          if (newLabelIds.length !== snapshot.labelIds.length) {
            update.labelIds = newLabelIds
          }
        }
      }
    }

    if (!update.stateId && !update.labelIds) return null
    await updateIssue(config.linear, issueId, update)

    logger.info(
      { issueId, teamId, stateId: update.stateId, removedLabel: trigger?.type === 'label' ? trigger.value : undefined },
      '[automation] Applied success automation'
    )
    return null
  } catch (error) {
    logger.warn({ error, issueId, teamId, trigger: trigger?.value }, '[automation] Failed to apply success automation')
    const msg = error instanceof Error ? error.message : String(error)
    return `Failed to apply success automation: ${msg}`
  }
}

async function removeWorktreeSafe(
  basePath: string,
  worktreePath: string
): Promise<void> {
  try {
    await removeWorktree(basePath, worktreePath)
    logger.info(`[worktree] Removed worktree at ${worktreePath}`)
  } catch (error) {
    logger.error({ error }, '[worktree] Failed to remove worktree')
  }
}

function formatIssueComments(comments: { id: string; body: string; createdAt: string }[]): string {
  if (comments.length === 0) return 'No comments.'

  return comments
    .map((comment) => `- ${comment.createdAt}\n${comment.body}`)
    .join('\n\n')
}

/**
 * Format progress comment for Linear
 */
function formatProgressComment(
  issue: { identifier?: string; id: string },
  update: { type: string; message: string },
  worktreePath: string
): string {
  return `🤖 **Agent working...**

**Issue:** ${issue.identifier || issue.id}
**Worktree:** \`${worktreePath}\`

**Current:** ${update.message}

_This may take up to 30 minutes..._`
}

function formatGuideProgressComment(
  issue: { identifier?: string; id: string },
  update: { type: string; message: string },
  docsPath: string
): string {
  return `📘 **Guide in progress...**

**Issue:** ${issue.identifier || issue.id}
**Docs Path:** \`${docsPath}\`

**Current:** ${update.message}

_This may take up to 30 minutes..._`
}

/**
 * Format verification comment for Linear
 */
function formatVerificationComment(
  issue: { identifier?: string; id: string },
  result: SandboxResult,
  worktree: WorktreeResult,
  includeFileChanges: boolean
): string {
  if (!result.success) {
    return `## Code Bot - Failed

**Issue:** ${issue.identifier || issue.id}
**Status:** ${result.reason}
**Worktree:** \`${worktree.path}\`
**Branch:** \`${worktree.branch}\`

### Error
\`\`\`
${result.error || 'Unknown error'}
\`\`\`

_The worktree remains for manual investigation._`
  }

  const fileList = includeFileChanges
    ? (result.filesModified.length > 0
      ? result.filesModified.map(f => `- \`${f}\``).join('\n')
      : '_No files modified_')
    : '_File list hidden by configuration_'

  return `## Code Bot - Ready for Review

**Issue:** ${issue.identifier || issue.id}
**Status:** Completed

### Worktree Location
\`\`\`
${worktree.path}
\`\`\`

### Branch
\`\`\`
${worktree.branch}
\`\`\`

### Files Modified
${fileList}

### Summary
${result.summary}

---

_This change was generated automatically. Human verification required before merging._`
}

function formatGuideResultComment(
  issueRef: string,
  guideFile: string,
  docsBaseUrl: string | undefined,
  result: SandboxResult
): string {
  if (!result.success) {
    return `## User Guide Bot - Failed

**Issue:** ${issueRef}
**Status:** ${result.reason}

### Error
\`\`\`
${result.error || 'Unknown error'}
\`\`\``
  }

  const guideSlug = path.basename(guideFile).replace(/\.md$/, '')
  const baseUrl = docsBaseUrl ? docsBaseUrl.replace(/\/+$/, '') : ''
  const guideLink = baseUrl ? `${baseUrl}/${guideSlug}` : guideFile

  return `## User Guide Bot - Ready for Review

**Issue:** ${issueRef}
**Status:** Completed

### Guide Link
${guideLink}

### Guide File
\`${guideFile}\``
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => variables[key] ?? '')
}

function normalizeIssueIdentifier(issueIdentifier: string): string {
  return issueIdentifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}

function extractMentionQuestion(body: string, mention: string, stripMention: boolean): string {
  const trimmed = body.trimStart()
  if (!stripMention) return trimmed.trim()

  const wanted = mention.trim()
  if (!wanted) return trimmed.trim()

  const regex = new RegExp(`^${escapeRegex(wanted)}\\b`, 'i')
  const withoutMention = trimmed.replace(regex, '')
  return withoutMention.replace(/^[\s:,-]+/, '').trim()
}

function formatRecentComments(
  comments: { id: string; body: string; createdAt: string }[],
  excludeIds: Set<string>,
  maxComments: number
): string {
  const filtered = comments
    .filter((comment) => comment.body?.trim())
    .filter((comment) => !excludeIds.has(comment.id))

  if (filtered.length === 0) return 'No comments.'

  const selected = filtered.slice(-maxComments)
  return selected
    .map((comment) => {
      const oneLine = comment.body.trim().replace(/\r?\n/g, ' ')
      const excerpt = oneLine.length > 500 ? `${oneLine.substring(0, 500)}... (truncated)` : oneLine
      return `- ${comment.createdAt}: ${excerpt}`
    })
    .join('\n')
}

function truncateForLinear(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '\n\n... (truncated)'
}

function quoteMarkdown(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return '> (empty)'
  return trimmed.split('\n').map((line) => `> ${line}`).join('\n')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')
}
