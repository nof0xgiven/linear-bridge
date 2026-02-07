import type { ContextBuilderResult } from './types'
import type { AppConfig } from './config/schema'
import { logger } from './logger'
import path from 'path'

interface RepoPromptWindow {
  windowID: number
  workspaceID: string
  workspaceName: string
  rootFolderPaths: string[]
}

interface RepoPromptWorkspace {
  id: string
  name: string
  repo_paths: string[]
}

interface RepoPromptWorkspaceListResponse {
  status: 'ok' | 'error'
  workspaces?: RepoPromptWorkspace[]
  error?: string
}

interface RepoPromptManageWorkspacesResponse {
  status: 'ok' | 'error'
  action?: string
  error?: string
}

function normalizePath(value: string): string {
  try {
    return path.resolve(value)
  } catch {
    return value
  }
}

async function runProcess(
  cmd: string[],
  options: {
    cwd?: string
    timeoutMs: number
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Ensure PATH includes common locations for rp-cli
      PATH: `${process.env.PATH}:/usr/local/bin:${process.env.HOME}/.local/bin`,
    },
  })

  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill()
      reject(new Error(`Process timed out after ${options.timeoutMs / 1000} seconds`))
    }, options.timeoutMs)
  })

  let exitCode: number
  try {
    exitCode = await Promise.race([proc.exited, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

async function listRepoPromptWindows(timeoutMs: number): Promise<RepoPromptWindow[]> {
  const { exitCode, stdout, stderr } = await runProcess(
    ['rp-cli', '--raw-json', '-e', 'windows'],
    { timeoutMs }
  )

  if (exitCode !== 0) {
    throw new Error(`Failed to list RepoPrompt windows: ${stderr || `Exit code ${exitCode}`}`)
  }

  const trimmed = stdout.trim()
  if (!trimmed) return []

  const parsed = JSON.parse(trimmed) as any
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected windows response from rp-cli (expected JSON array)')
  }

  return parsed.map((w) => ({
    windowID: Number(w.windowID),
    workspaceID: String(w.workspaceID ?? ''),
    workspaceName: String(w.workspaceName ?? ''),
    rootFolderPaths: Array.isArray(w.rootFolderPaths) ? w.rootFolderPaths.map(String) : [],
  }))
}

async function listRepoPromptWorkspaces(timeoutMs: number): Promise<RepoPromptWorkspace[]> {
  const { exitCode, stdout, stderr } = await runProcess(
    ['rp-cli', '--raw-json', '-c', 'manage_workspaces', '-j', JSON.stringify({ action: 'list' })],
    { timeoutMs }
  )

  if (exitCode !== 0) {
    throw new Error(`Failed to list RepoPrompt workspaces: ${stderr || `Exit code ${exitCode}`}`)
  }

  const trimmed = stdout.trim()
  if (!trimmed) return []

  const parsed = JSON.parse(trimmed) as RepoPromptWorkspaceListResponse
  if (parsed.status !== 'ok') {
    throw new Error(parsed.error || 'RepoPrompt workspace list failed')
  }

  return (parsed.workspaces ?? []).map((ws) => ({
    id: String(ws.id),
    name: String(ws.name),
    repo_paths: Array.isArray(ws.repo_paths) ? ws.repo_paths.map(String) : [],
  }))
}

async function createRepoPromptWorkspace(timeoutMs: number, repoPath: string): Promise<void> {
  const baseName = path.basename(repoPath) || 'workspace'
  const name = `enhance-ticket:${baseName}`

  const { exitCode, stdout, stderr } = await runProcess(
    [
      'rp-cli',
      '--raw-json',
      '-c',
      'manage_workspaces',
      '-j',
      JSON.stringify({ action: 'create', name, folder_path: repoPath }),
    ],
    { timeoutMs }
  )

  if (exitCode !== 0) {
    throw new Error(`Failed to create RepoPrompt workspace: ${stderr || `Exit code ${exitCode}`}`)
  }

  const trimmed = stdout.trim()
  if (!trimmed) return

  try {
    const parsed = JSON.parse(trimmed) as RepoPromptManageWorkspacesResponse
    if (parsed.status !== 'ok') {
      throw new Error(parsed.error || 'RepoPrompt workspace create failed')
    }
  } catch {
    // Non-JSON output - treat as success.
  }
}

async function resolveRepoPromptWorkspaceForRepoPath(timeoutMs: number, repoPath: string): Promise<RepoPromptWorkspace> {
  const wanted = normalizePath(repoPath)

  const workspaces = await listRepoPromptWorkspaces(timeoutMs)
  const match = workspaces.find((ws) => ws.repo_paths.some((p) => normalizePath(p) === wanted))
  if (match) return match

  await createRepoPromptWorkspace(timeoutMs, repoPath)
  const workspacesAfter = await listRepoPromptWorkspaces(timeoutMs)
  const created = workspacesAfter.find((ws) => ws.repo_paths.some((p) => normalizePath(p) === wanted))
  if (!created) {
    throw new Error(`RepoPrompt workspace not found for repo path after create: ${repoPath}`)
  }
  return created
}

async function switchWindowWorkspace(timeoutMs: number, windowId: number, workspaceId: string): Promise<void> {
  const { exitCode, stdout, stderr } = await runProcess(
    [
      'rp-cli',
      '--raw-json',
      '-w',
      String(windowId),
      '-c',
      'manage_workspaces',
      '-j',
      JSON.stringify({ action: 'switch', workspace: workspaceId }),
    ],
    { timeoutMs }
  )

  if (exitCode !== 0) {
    throw new Error(`Failed to switch RepoPrompt workspace: ${stderr || `Exit code ${exitCode}`}`)
  }

  const trimmed = stdout.trim()
  if (!trimmed) return

  try {
    const parsed = JSON.parse(trimmed) as RepoPromptManageWorkspacesResponse
    if (parsed.status !== 'ok') {
      throw new Error(parsed.error || 'RepoPrompt workspace switch failed')
    }
  } catch {
    // Non-JSON output - treat as success.
  }
}

function injectRpCliWindowFlag(commandTemplate: string, windowId: number): string | null {
  const trimmed = commandTemplate.trim()
  if (!trimmed.startsWith('rp-cli')) {
    return null
  }

  // Strip any existing window targeting (we will control it).
  let command = commandTemplate
    .replace(/\s+-w\s+\S+/g, '')
    .replace(/\s+--window=\S+/g, '')
    .replace(/\s+--window\s+\S+/g, '')

  // Ensure a window is always specified (required when multiple windows exist).
  command = command.replace(/\brp-cli\b/, `rp-cli -w ${windowId}`)
  return command
}

/**
 * Execute rp-cli context_builder with the given task description
 */
export async function runContextBuilder(
  taskDescription: string,
  workspacePath: string,
  config: AppConfig['context']
): Promise<ContextBuilderResult> {
  const controlTimeoutMs = Math.min(config.timeoutMs, 30_000)

  // Escape the task description for shell safety.
  // The command uses single quotes, so we must handle single quotes specially:
  // To embed a single quote in a bash single-quoted string: end string, add \', start new string
  // e.g., "It's" becomes "It'\''s"
  // Also escape newlines to prevent multi-line command issues.
  const escapedTask = taskDescription
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/'/g, "'\\''")

  let targetWorkspace: RepoPromptWorkspace
  let targetWindow: RepoPromptWindow
  let previousWorkspaceId: string

  try {
    targetWorkspace = await resolveRepoPromptWorkspaceForRepoPath(controlTimeoutMs, workspacePath)
    const windows = await listRepoPromptWindows(controlTimeoutMs)
    if (windows.length === 0) {
      throw new Error('No RepoPrompt windows available (is the RepoPrompt app running?)')
    }

    // Prefer a window already showing the desired workspace to reduce disruption.
    targetWindow = windows.find((w) => w.workspaceID === targetWorkspace.id)
      ?? windows.sort((a, b) => a.windowID - b.windowID)[0]
    previousWorkspaceId = targetWindow.workspaceID
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[rp-cli] Failed to resolve RepoPrompt target: ${message}`)
    return { success: false, output: '', error: message }
  }

  const injectedCommandTemplate = injectRpCliWindowFlag(config.command, targetWindow.windowID)
  if (!injectedCommandTemplate) {
    const message = 'Unsupported context.command format. Expected command to start with rp-cli.'
    logger.error(`[rp-cli] ${message}`)
    return { success: false, output: '', error: message }
  }

  const command = injectedCommandTemplate.split('{TASK}').join(escapedTask)

  logger.info(
    {
      repoPath: workspacePath,
      rpWindowId: targetWindow.windowID,
      previousWorkspace: { id: previousWorkspaceId, name: targetWindow.workspaceName },
      targetWorkspace: { id: targetWorkspace.id, name: targetWorkspace.name },
    },
    '[rp-cli] Running context builder via RepoPrompt'
  )

  try {
    // Ensure the window points at the right RepoPrompt workspace for this repo.
    if (previousWorkspaceId !== targetWorkspace.id) {
      await switchWindowWorkspace(controlTimeoutMs, targetWindow.windowID, targetWorkspace.id)
    }

    const { exitCode, stdout, stderr } = await runProcess(['bash', '-c', command], {
      cwd: workspacePath,
      timeoutMs: config.timeoutMs,
    })

    if (exitCode !== 0) {
      logger.error(`[rp-cli] Failed with exit code ${exitCode}`)
      logger.error(`[rp-cli] stderr: ${stderr}`)
      return {
        success: false,
        output: stdout,
        error: stderr || `Exit code: ${exitCode}`,
      }
    }

    return { success: true, output: stdout }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`[rp-cli] Error: ${errorMessage}`)
    return { success: false, output: '', error: errorMessage }
  } finally {
    // Best-effort restore to avoid leaving the user's window on a different workspace.
    if (previousWorkspaceId && previousWorkspaceId !== targetWorkspace.id) {
      try {
        await switchWindowWorkspace(controlTimeoutMs, targetWindow.windowID, previousWorkspaceId)
      } catch (error) {
        logger.warn({ error }, '[rp-cli] Failed to restore previous RepoPrompt workspace')
      }
    }
  }
}

/**
 * Format context builder output for Linear comment
 */
export function formatOutputForComment(result: ContextBuilderResult, maxLength = 50000): string {
  if (!result.success) {
    return `## Context Builder Failed

\`\`\`
${result.error || 'Unknown error'}
\`\`\`

${result.output ? `### Partial Output\n\`\`\`\n${result.output.substring(0, 2000)}\n\`\`\`` : ''}`
  }

  // Truncate if too long for Linear (max ~64KB, but keep it readable)
  let output = result.output

  if (output.length > maxLength) {
    output = output.substring(0, maxLength) + '\n\n... (truncated)'
  }

  return `## Context Builder Result

${output}`
}

const PLAN_COMMAND_TEMPLATE = `rp-cli -e 'builder "{TASK}" --type plan'`

/**
 * Execute rp-cli builder with --type plan for the given task description
 */
export async function runPlanBuilder(
  taskDescription: string,
  workspacePath: string,
  config: AppConfig['context']
): Promise<ContextBuilderResult> {
  return runContextBuilder(taskDescription, workspacePath, {
    ...config,
    command: PLAN_COMMAND_TEMPLATE,
  })
}

/**
 * Format plan builder output for Linear comment
 */
export function formatPlanOutputForComment(result: ContextBuilderResult, maxLength = 50000): string {
  if (!result.success) {
    return `## Plan Failed

\`\`\`
${result.error || 'Unknown error'}
\`\`\`

${result.output ? `### Partial Output\n\`\`\`\n${result.output.substring(0, 2000)}\n\`\`\`` : ''}`
  }

  let output = result.output
  if (output.length > maxLength) {
    output = output.substring(0, maxLength) + '\n\n... (truncated)'
  }

  return `## Plan

${output}`
}
