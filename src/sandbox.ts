import {
  SandboxAgent,
  type UniversalEvent,
  type PermissionEventData,
  type QuestionEventData,
  type SessionEndedData,
  type ItemEventData,
} from 'sandbox-agent'
import { $ } from 'bun'
import type { SandboxResult } from './types'
import type { AppConfig } from './config/schema'
import { logger } from './logger'

let client: SandboxAgent | null = null
let cachedKey: string | null = null

async function getClient(config: AppConfig['sandbox']): Promise<SandboxAgent> {
  const connectionKey = JSON.stringify(config.connection ?? {})
  if (!client || cachedKey !== connectionKey) {
    const baseUrl = config.connection?.baseUrl
    const token = config.connection?.token
    const host = config.connection?.host
    const port = config.connection?.port

    if (baseUrl) {
      client = await SandboxAgent.connect({ baseUrl, token })
      cachedKey = connectionKey
      return client
    }

    // Start local sandbox-agent server (auto-spawns binary)
    client = await SandboxAgent.start({
      spawn: {
        log: 'silent',
        token,
        host,
        port,
      }
    })
    cachedKey = connectionKey
  }
  return client
}

export type ProgressCallback = (update: { type: string; message: string }) => Promise<void>

export interface SandboxRunConfig {
  agent: AppConfig['sandbox']['default']['agent']
  agentMode?: string
  permissionMode: AppConfig['sandbox']['default']['permissionMode']
  timeoutMs: number
  progressIntervalMs: number
  includeToolCalls: boolean
  reasoning?: string
  promptPrefix?: string
  promptSuffix?: string
}

export async function runSandboxAgent(
  sessionId: string,
  prompt: string,
  workspacePath: string,
  onProgress: ProgressCallback,
  runConfig: SandboxRunConfig,
  sandboxConfig: AppConfig['sandbox'],
  options?: {
    detectFileChanges?: boolean
    permissionPolicy?: 'default' | 'mentionReply' | 'review'
  }
): Promise<SandboxResult> {
  const sandboxClient = await getClient(sandboxConfig)
  const filesModified: string[] = []
  const detectFileChanges = options?.detectFileChanges ?? true
  let lastAssistantMessage = ''
  let lastProgressTime = 0
  let offset = 0

  // Create session - working directory is embedded in the prompt
  // The agent will cd to the worktree path as part of its first action
  await sandboxClient.createSession(sessionId, {
    agent: runConfig.agent,
    agentMode: runConfig.agentMode,
    permissionMode: runConfig.permissionMode,
  })

  // Build prompt with explicit working directory instruction
  const safeWorkspacePath = workspacePath.replace(/'/g, `'\\''`)
  const fullPrompt = `IMPORTANT: First, change to the working directory: cd '${safeWorkspacePath}'\n\n${prompt}`

  let sawCompleted = false
  let sawFailed = false
  let sentTurn = false

  // Stream events with timeout
  const abortController = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, runConfig.timeoutMs)

  const handleEvent = async (event: UniversalEvent): Promise<SandboxResult | null> => {
    switch (event.type) {
      case 'session.started':
        await onProgress({ type: 'status', message: 'Agent session started' })
        return null

      case 'item.completed': {
        await handleItemCompleted(event, filesModified, onProgress, lastProgressTime, runConfig)
        lastProgressTime = Date.now()

        const data = event.data as ItemEventData
        const item = data?.item
        const status = item?.status
        if (status === 'failed') sawFailed = true
        if (status === 'completed') sawCompleted = true

        if (item?.kind === 'message' && item?.role === 'assistant') {
          const text = item.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
          if (text.trim()) {
            lastAssistantMessage = text.trim()
          }
        }
        return null
      }

      case 'permission.requested': {
        const permData = event.data as PermissionEventData
        const reply = decidePermissionReply(permData, options?.permissionPolicy ?? 'default')
        if (reply === 'reject') {
          logger.warn(
            {
              action: permData.action,
              toolNames: extractPermissionToolNames(permData.metadata),
            },
            '[sandbox] Permission rejected by policy'
          )
        }
        await sandboxClient.replyPermission(sessionId, permData.permission_id, { reply })
        return null
      }

      case 'question.requested': {
        const qData = event.data as QuestionEventData
        await sandboxClient.rejectQuestion(sessionId, qData.question_id)
        return null
      }

      case 'session.ended': {
        clearTimeout(timeoutId)
        const endData = event.data as SessionEndedData
        return await finalizeResult({
          success: endData.reason === 'completed',
          sessionId,
          reason: endData.reason as SandboxResult['reason'],
          filesModified,
          summary: buildSummary(filesModified),
          answer: lastAssistantMessage || undefined,
          error: endData.message ?? undefined
        }, workspacePath, detectFileChanges)
      }

      default:
        return null
    }
  }

  const pollEvents = async (): Promise<SandboxResult | null> => {
    let hasMore = true
    while (hasMore && !abortController.signal.aborted) {
      const response = await sandboxClient.getEvents(sessionId, { offset, limit: 100 })
      for (const event of response.events) {
        offset += 1
        const result = await handleEvent(event)
        if (result) return result
      }
      hasMore = response.hasMore
      if (response.events.length === 0) break
    }
    return null
  }

  try {
    while (!abortController.signal.aborted) {
      if (!sentTurn) {
        sentTurn = true
        try {
          for await (const event of sandboxClient.streamTurn(sessionId, { message: fullPrompt }, undefined, abortController.signal)) {
            if (abortController.signal.aborted) break
            offset += 1
            const result = await handleEvent(event)
            if (result) return result
          }
        } catch (error) {
          if (abortController.signal.aborted) break
          if (!isRetryableStreamError(error)) {
            throw error
          }
        }
      }

      const result = await pollEvents()
      if (result) return result

      if (sawFailed) {
        return await finalizeResult({
          success: false,
          sessionId,
          reason: 'error',
          filesModified,
          summary: buildSummary(filesModified),
          answer: lastAssistantMessage || undefined,
          error: 'Agent reported a failed item'
        }, workspacePath, detectFileChanges)
      }

      if (sawCompleted) {
        return await finalizeResult({
          success: true,
          sessionId,
          reason: 'completed',
          filesModified,
          summary: buildSummary(filesModified),
          answer: lastAssistantMessage || undefined,
        }, workspacePath, detectFileChanges)
      }

      await delay(1000)
    }

    if (timedOut) {
      logger.warn(`[sandbox] Timeout reached, terminating session ${sessionId}`)
      try {
        await sandboxClient.terminateSession(sessionId)
        logger.info(`[sandbox] Session ${sessionId} terminated successfully`)
      } catch (error) {
        logger.error({ error }, `[sandbox] Failed to terminate session ${sessionId}`)
      }

      return await finalizeResult({
        success: false,
        sessionId,
        reason: 'timeout',
        filesModified,
        summary: buildSummary(filesModified),
        answer: lastAssistantMessage || undefined,
        error: `Timeout after ${runConfig.timeoutMs / 1000}s - session terminated`
      }, workspacePath, detectFileChanges)
    }
  } catch (error) {
    if (timedOut) {
      logger.warn(`[sandbox] Error during timeout, terminating session ${sessionId}`)
      try {
        await sandboxClient.terminateSession(sessionId)
      } catch (termError) {
        logger.error({ error: termError }, `[sandbox] Failed to terminate session after error`)
      }

      return await finalizeResult({
        success: false,
        sessionId,
        reason: 'timeout',
        filesModified,
        summary: buildSummary(filesModified),
        answer: lastAssistantMessage || undefined,
        error: `Timeout after ${runConfig.timeoutMs / 1000}s - ${error instanceof Error ? error.message : String(error)}`
      }, workspacePath, detectFileChanges)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }

  // Fallback if stream ends without session.ended
  return await finalizeResult({
    success: false,
    sessionId,
    reason: 'terminated',
    filesModified,
    summary: 'Session ended unexpectedly',
    answer: lastAssistantMessage || undefined,
  }, workspacePath, detectFileChanges)
}

function extractPermissionToolNames(metadata: unknown): string[] {
  const toolNames = new Set<string>()

  if (!metadata || typeof metadata !== 'object') return []
  const meta = metadata as any
  const suggestions = meta.permissionSuggestions
  if (!Array.isArray(suggestions)) return []

  for (const suggestion of suggestions) {
    const rules = suggestion?.rules
    if (!Array.isArray(rules)) continue
    for (const rule of rules) {
      const toolName = rule?.toolName
      if (typeof toolName === 'string' && toolName.trim()) {
        toolNames.add(toolName.trim())
      }
    }
  }

  return Array.from(toolNames)
}

function extractPermissionCommand(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const meta = metadata as any
  const cmd = meta?.input?.command
  return typeof cmd === 'string' ? cmd : null
}

function decidePermissionReply(
  data: PermissionEventData,
  policy: 'default' | 'mentionReply' | 'review'
): 'once' | 'reject' {
  if (policy === 'default') return 'once'

  // Mention replies and reviews must never call Linear MCP tools (to avoid side effects / duplicate replies).
  const toolNames = extractPermissionToolNames(data.metadata)
  if (toolNames.some((t) => /^mcp__.*linear/i.test(t))) return 'reject'

  // Fallback: block obvious Linear MCP invocations even when suggestions aren't available.
  const cmd = extractPermissionCommand(data.metadata)
  if (cmd && /\bmcp-cli\b/i.test(cmd) && /\blinear\b/i.test(cmd)) {
    return 'reject'
  }

  if (policy === 'mentionReply') {
    return 'once'
  }

  // Review workflow must be read-only: reject obviously destructive or write-y bash commands.
  if (cmd && isReviewWriteCommand(cmd)) {
    return 'reject'
  }

  return 'once'
}

function isReviewWriteCommand(command: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false

  // File writes / destructive ops / git history ops.
  const denied = [
    /\b(git)\s+(commit|push|merge|rebase|reset|checkout|cherry-pick|apply|am)\b/i,
    /\b(rm|mv|cp|chmod|chown|ln)\b/i,
    /\btee\b/i,
    />/i, // redirection (>, >>)
    /\bbrew\s+install\b/i,
    /\bbun\s+install\b/i,
    /\bnpm\s+install\b/i,
    /\bpnpm\s+install\b/i,
    /\byarn\s+install\b/i,
  ]

  return denied.some((re) => re.test(cmd))
}

async function handleItemCompleted(
  event: UniversalEvent,
  filesModified: string[],
  onProgress: ProgressCallback,
  lastProgressTime: number,
  config: SandboxRunConfig
): Promise<void> {
  const data = event.data as ItemEventData
  const item = data?.item
  if (item?.content) {
    for (const part of item.content) {
      // Track file modifications
      if (part.type === 'file_ref') {
        const fileRef = part as { type: 'file_ref'; path: string; action: string }
        if ((fileRef.action === 'write' || fileRef.action === 'patch') && !filesModified.includes(fileRef.path)) {
          filesModified.push(fileRef.path)
        }
      }
      // Throttled progress updates
      if (
        config.includeToolCalls &&
        part.type === 'tool_call' &&
        Date.now() - lastProgressTime > config.progressIntervalMs
      ) {
        const toolCall = part as { type: 'tool_call'; name: string }
        await onProgress({ type: 'tool', message: `Running: ${toolCall.name}` })
      }
    }
  }
}

function buildSummary(files: string[]): string {
  if (files.length === 0) return 'No files were modified.'
  return `Modified ${files.length} file(s): ${files.join(', ')}`
}

async function finalizeResult(result: SandboxResult, worktreePath: string, detectFileChanges: boolean): Promise<SandboxResult> {
  if (!detectFileChanges) return result
  if (result.filesModified.length > 0) return result

  try {
    const output = await $`git status --porcelain`.cwd(worktreePath).quiet().text()
    const files = parseGitStatusFiles(output)
    if (files.length > 0) {
      return {
        ...result,
        filesModified: files,
        summary: buildSummary(files),
      }
    }

    const committedFiles = await getCommittedFiles(worktreePath)
    if (committedFiles.length > 0) {
      return {
        ...result,
        filesModified: committedFiles,
        summary: buildSummary(committedFiles),
      }
    }

    return result
  } catch {
    return result
  }
}

async function getCommittedFiles(worktreePath: string): Promise<string[]> {
  const baseBranch = await getMainBranch(worktreePath)
  if (!baseBranch) return []

  const output = await $`git diff --name-only ${baseBranch}...HEAD`.cwd(worktreePath).quiet().text()
  return output.split('\n').map((line) => line.trim()).filter(Boolean)
}

async function getMainBranch(worktreePath: string): Promise<string | null> {
  try {
    const result = await $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(worktreePath).quiet().text()
    const branch = result.trim().replace('refs/remotes/origin/', '')
    if (!branch) return null
    return `origin/${branch}`
  } catch {
    return null
  }
}

function parseGitStatusFiles(output: string): string[] {
  const files: string[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const pathPart = line.slice(3).trim()
    if (!pathPart) continue
    const arrowIndex = pathPart.lastIndexOf(' -> ')
    const path = arrowIndex >= 0 ? pathPart.slice(arrowIndex + 4) : pathPart
    if (path && !files.includes(path)) files.push(path)
  }
  return files
}

function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'TimeoutError' || error.name === 'AbortError'
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (message.includes('timed out')) return true
    if (message.includes('unable to connect')) return true
    if (message.includes('connection refused')) return true
  }

  const maybeCode = (error as { code?: string } | null)?.code
  if (maybeCode === 'ECONNREFUSED' || maybeCode === 'ConnectionRefused') return true

  return false
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build prompt for full workflow (with rp-cli context)
 */
export function buildAgentPrompt(
  issueIdentifier: string,
  issueTitle: string,
  issueDescription: string | undefined,
  context: string,
  comments: string,
  promptConfig?: Pick<SandboxRunConfig, 'promptPrefix' | 'promptSuffix' | 'reasoning'>
): string {
  const basePrompt = `# Ticket Implementation Request

## Linear Issue: ${issueIdentifier}
**Title:** ${issueTitle}

**Description:**
${issueDescription || 'No description provided.'}

## Comments
${comments || 'No comments provided.'}

## Codebase Context
${context}

## Instructions
1. Understand the task using the issue details and context provided.
2. Identify the root cause if this is a bug, or the correct implementation path if this is a feature/change.
3. Implement a minimal, surgical change (scope discipline).
4. Verify the change compiles and passes repo quality checks.
5. Do NOT refactor unrelated code.
6. Do NOT add new dependencies unless absolutely necessary.

Focus on correctness over cleverness.`

  return applyPromptCustomizations(basePrompt, promptConfig)
}

/**
 * Build prompt for sandbox-only workflow (uses template with issue context)
 */
export async function buildSandboxPrompt(
  taskTitle: string,
  taskDescription: string | undefined,
  taskComments: string,
  promptConfig?: Pick<SandboxRunConfig, 'promptPrefix' | 'promptSuffix' | 'reasoning'>
): Promise<string> {
  const template = await loadBugFixTemplate()
  const basePrompt = renderTemplate(template, {
    task_title: taskTitle,
    task_description: taskDescription || 'No description provided.',
    task_comments: taskComments || 'No comments provided.'
  })
  return applyPromptCustomizations(basePrompt, promptConfig)
}

/**
 * Build prompt for user guide workflow
 */
export async function buildUserGuidePrompt(
  taskTitle: string,
  taskDescription: string | undefined,
  taskComments: string,
  guideConfig: {
    codebasePath: string
    docsPath: string
    guideFile: string
    screenshotsDir: string
    serverUrl: string
    usernameEnv: string
    passwordEnv: string
    templatePath: string
  },
  promptConfig?: Pick<SandboxRunConfig, 'promptPrefix' | 'promptSuffix' | 'reasoning'>
): Promise<string> {
  const template = await loadUserGuideTemplate(guideConfig.templatePath)
  const basePrompt = renderTemplate(template, {
    task_title: taskTitle,
    task_description: taskDescription || 'No description provided.',
    task_comments: taskComments || 'No comments provided.',
    codebase_path: guideConfig.codebasePath,
    docs_path: guideConfig.docsPath,
    guide_file: guideConfig.guideFile,
    screenshots_dir: guideConfig.screenshotsDir,
    server_url: guideConfig.serverUrl,
    username_env: guideConfig.usernameEnv,
    password_env: guideConfig.passwordEnv,
  })
  return applyPromptCustomizations(basePrompt, promptConfig)
}

/**
 * Build prompt for mention-based Q&A replies
 */
export async function buildMentionReplyPrompt(
  mention: string,
  issueIdentifier: string,
  issueTitle: string,
  issueDescription: string | undefined,
  issueUrl: string | undefined,
  userComment: string,
  question: string,
  repoPath: string,
  recentComments: string,
  mentionConfig: Pick<AppConfig['mentionReply'], 'templatePath'>,
  promptConfig?: Pick<SandboxRunConfig, 'promptPrefix' | 'promptSuffix' | 'reasoning'>
): Promise<string> {
  const template = await loadMentionReplyTemplate(mentionConfig.templatePath)
  const basePrompt = renderTemplate(template, {
    mention,
    issue_identifier: issueIdentifier,
    issue_title: issueTitle,
    issue_description: issueDescription || 'No description provided.',
    issue_url: issueUrl || '',
    user_comment: userComment || '',
    question: question || '',
    repo_path: repoPath,
    recent_comments: recentComments || 'No comments provided.',
  })
  return applyPromptCustomizations(basePrompt, promptConfig)
}

/**
 * Build prompt for code review workflow (read-only; include git diff in prompt)
 */
export async function buildReviewPrompt(
  taskTitle: string,
  taskDescription: string | undefined,
  gitDiffStat: string,
  gitDiff: string,
  reviewConfig: Pick<AppConfig['review'], 'templatePath'>,
  promptConfig?: Pick<SandboxRunConfig, 'promptPrefix' | 'promptSuffix' | 'reasoning'>
): Promise<string> {
  const template = await loadReviewTemplate(reviewConfig.templatePath)
  const basePrompt = renderTemplate(template, {
    task_title: taskTitle,
    task_description: taskDescription || 'No description provided.',
  })

  const diffSection = `\n\n## Git Diff (stat)\n\n\`\`\`\n${gitDiffStat || '(no diff)'}\n\`\`\`\n\n## Git Diff\n\n\`\`\`diff\n${gitDiff || '(no diff)'}\n\`\`\`\n`

  return applyPromptCustomizations(basePrompt + diffSection, promptConfig)
}

/**
 * Dispose the sandbox agent client (for cleanup)
 */
export async function disposeSandboxClient(): Promise<void> {
  if (client) {
    await client.dispose()
    client = null
  }
}

export async function testSandboxConnection(config: AppConfig['sandbox']): Promise<void> {
  const sandboxClient = await getClient(config)
  await sandboxClient.getHealth()
}

let cachedTemplate: string | null = null
let cachedUserGuideTemplate: { path: string; content: string } | null = null
let cachedMentionReplyTemplate: { path: string; content: string } | null = null
let cachedReviewTemplate: { path: string; content: string } | null = null

async function loadBugFixTemplate(): Promise<string> {
  if (cachedTemplate) return cachedTemplate
  const templateUrl = new URL('../templates/bug_fix.md', import.meta.url)
  cachedTemplate = await Bun.file(templateUrl).text()
  return cachedTemplate
}

async function loadUserGuideTemplate(templatePath: string): Promise<string> {
  if (cachedUserGuideTemplate && cachedUserGuideTemplate.path === templatePath) {
    return cachedUserGuideTemplate.content
  }
  const resolvedPath = templatePath.startsWith('/')
    ? templatePath
    : new URL(`../${templatePath}`, import.meta.url).pathname
  const content = await Bun.file(resolvedPath).text()
  cachedUserGuideTemplate = { path: templatePath, content }
  return content
}

async function loadMentionReplyTemplate(templatePath: string): Promise<string> {
  if (cachedMentionReplyTemplate && cachedMentionReplyTemplate.path === templatePath) {
    return cachedMentionReplyTemplate.content
  }
  const resolvedPath = templatePath.startsWith('/')
    ? templatePath
    : new URL(`../${templatePath}`, import.meta.url).pathname
  const content = await Bun.file(resolvedPath).text()
  cachedMentionReplyTemplate = { path: templatePath, content }
  return content
}

async function loadReviewTemplate(templatePath: string): Promise<string> {
  if (cachedReviewTemplate && cachedReviewTemplate.path === templatePath) {
    return cachedReviewTemplate.content
  }
  const resolvedPath = templatePath.startsWith('/')
    ? templatePath
    : new URL(`../${templatePath}`, import.meta.url).pathname
  const content = await Bun.file(resolvedPath).text()
  cachedReviewTemplate = { path: templatePath, content }
  return content
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => variables[key] ?? '')
}

function applyPromptCustomizations(
  prompt: string,
  config?: Pick<SandboxRunConfig, 'promptPrefix' | 'promptSuffix' | 'reasoning'>
): string {
  if (!config) return prompt

  const prefix = config.promptPrefix ? `${config.promptPrefix}\n\n` : ''
  const suffix = config.promptSuffix ? `\n\n${config.promptSuffix}` : ''
  const reasoning = config.reasoning ? `\n\nReasoning level: ${config.reasoning}` : ''

  return `${prefix}${prompt}${reasoning}${suffix}`
}
