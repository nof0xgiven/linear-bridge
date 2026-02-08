import type { ContextBuilderResult } from './types'
import type { AppConfig } from './config/schema'
import { logger } from './logger'
import path from 'path'

interface RepoPromptWorkspace {
  id: string
  name: string
  repo_paths: string[]
  showing_window_ids: number[]
}

interface RepoPromptWorkspaceListResponse {
  status: 'ok' | 'error'
  workspaces?: RepoPromptWorkspace[]
  error?: string
}

interface RepoPromptManageWorkspacesResponse {
  status: 'ok' | 'error'
  action?: string
  window_id?: number
  error?: string
}

interface WorkspaceResolution {
  workspace: RepoPromptWorkspace
  windowId: number
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
    showing_window_ids: Array.isArray(ws.showing_window_ids) ? ws.showing_window_ids.map(Number) : [],
  }))
}

async function createRepoPromptWorkspace(timeoutMs: number, repoPath: string): Promise<number | undefined> {
  const baseName = path.basename(repoPath) || 'workspace'
  const name = `linear-bridge:${baseName}`

  const { exitCode, stdout, stderr } = await runProcess(
    [
      'rp-cli',
      '--raw-json',
      '-c',
      'manage_workspaces',
      '-j',
      JSON.stringify({ action: 'create', name, folder_path: repoPath, open_in_new_window: true }),
    ],
    { timeoutMs }
  )

  if (exitCode !== 0) {
    throw new Error(`Failed to create RepoPrompt workspace: ${stderr || `Exit code ${exitCode}`}`)
  }

  const trimmed = stdout.trim()
  if (!trimmed) return undefined

  try {
    const parsed = JSON.parse(trimmed) as RepoPromptManageWorkspacesResponse
    if (parsed.status !== 'ok') {
      throw new Error(parsed.error || 'RepoPrompt workspace create failed')
    }
    return parsed.window_id
  } catch {
    // Non-JSON output - treat as success.
    return undefined
  }
}

async function openWorkspaceInNewWindow(timeoutMs: number, workspaceId: string): Promise<number | undefined> {
  const { exitCode, stdout, stderr } = await runProcess(
    [
      'rp-cli',
      '--raw-json',
      '-c',
      'manage_workspaces',
      '-j',
      JSON.stringify({ action: 'switch', workspace: workspaceId, open_in_new_window: true }),
    ],
    { timeoutMs }
  )

  if (exitCode !== 0) {
    throw new Error(`Failed to open workspace in new window: ${stderr || `Exit code ${exitCode}`}`)
  }

  const trimmed = stdout.trim()
  if (!trimmed) return undefined

  try {
    const parsed = JSON.parse(trimmed) as RepoPromptManageWorkspacesResponse
    if (parsed.status !== 'ok') {
      throw new Error(parsed.error || 'RepoPrompt workspace switch failed')
    }
    return parsed.window_id
  } catch {
    return undefined
  }
}

async function resolveRepoPromptWorkspaceForRepoPath(timeoutMs: number, repoPath: string): Promise<WorkspaceResolution> {
  const wanted = normalizePath(repoPath)

  const workspaces = await listRepoPromptWorkspaces(timeoutMs)
  const match = workspaces.find((ws) => ws.repo_paths.some((p) => normalizePath(p) === wanted))

  if (match) {
    // Workspace exists — reuse its window if already showing, otherwise open a new one
    if (match.showing_window_ids.length > 0) {
      return { workspace: match, windowId: match.showing_window_ids[0] }
    }
    const windowId = await openWorkspaceInNewWindow(timeoutMs, match.id)
    if (windowId == null) {
      throw new Error(`Failed to get window_id when opening existing workspace: ${match.name}`)
    }
    return { workspace: match, windowId }
  }

  // Workspace doesn't exist — create it in a new window
  const windowId = await createRepoPromptWorkspace(timeoutMs, repoPath)
  const workspacesAfter = await listRepoPromptWorkspaces(timeoutMs)
  const created = workspacesAfter.find((ws) => ws.repo_paths.some((p) => normalizePath(p) === wanted))
  if (!created) {
    throw new Error(`RepoPrompt workspace not found for repo path after create: ${repoPath}`)
  }
  if (windowId == null) {
    throw new Error(`Failed to get window_id when creating workspace for: ${repoPath}`)
  }
  return { workspace: created, windowId }
}

/**
 * Inject `-w <windowId>` into an rp-cli command string so it targets a specific window.
 * Replaces the first occurrence of `rp-cli` with `rp-cli -w <windowId>`.
 */
function injectWindowId(command: string, windowId: number): string {
  return command.replace(/\brp-cli\b/, `rp-cli -w ${windowId}`)
}

/**
 * Execute rp-cli context_builder with the given task description.
 * Each workspace is opened in its own RepoPrompt window to avoid conflicts
 * when multiple worktrees are active concurrently.
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

  let resolution: WorkspaceResolution

  try {
    resolution = await resolveRepoPromptWorkspaceForRepoPath(controlTimeoutMs, workspacePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[rp-cli] Failed to resolve RepoPrompt workspace: ${message}`)
    return { success: false, output: '', error: message }
  }

  // Inject -w <windowId> into the rp-cli command to target the correct window
  const command = injectWindowId(config.command.split('{TASK}').join(escapedTask), resolution.windowId)

  logger.info(
    {
      repoPath: workspacePath,
      targetWorkspace: { id: resolution.workspace.id, name: resolution.workspace.name },
      windowId: resolution.windowId,
    },
    '[rp-cli] Running context builder via RepoPrompt'
  )

  try {
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
