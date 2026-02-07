import { $ } from 'bun'
import path from 'path'
import type { AppConfig, WorkspaceConfig } from './config/schema'
import { logger } from './logger'

export interface WorktreeResult {
  success: boolean
  path: string
  branch: string
  error?: string
}

export interface WorktreeSpec {
  path: string
  branch: string
  issueId: string
}

export function getWorktreeSpec(
  workspace: WorkspaceConfig,
  issueIdentifier: string,
  config: AppConfig['worktree']
): WorktreeSpec {
  const safeIssueId = normalizeIssueIdentifier(issueIdentifier)
  const variables = {
    ISSUE_ID: safeIssueId,
    WORKSPACE_PATH: workspace.localPath,
    WORKSPACE_NAME: workspace.name,
  }

  const branch = renderTemplate(config.branchTemplate, variables)
  const rawPath = renderTemplate(config.nameTemplate, variables)
  const worktreePath = path.isAbsolute(rawPath) ? rawPath : path.join(workspace.localPath, rawPath)

  return { path: worktreePath, branch, issueId: safeIssueId }
}

/**
 * Create a git worktree for isolated ticket work
 * @param workspace - Workspace configuration. The repo base path is `workspace.localPath`.
 * @param issueIdentifier - Linear issue identifier (e.g., ENG-123).
 * @param config - Worktree config (naming templates, post-create script, cleanup).
 */
export async function createWorktree(
  workspace: WorkspaceConfig,
  issueIdentifier: string,
  config: AppConfig['worktree']
): Promise<WorktreeResult> {
  const spec = getWorktreeSpec(workspace, issueIdentifier, config)
  const { path: worktreePath, branch, issueId: safeIssueId } = spec
  const variables = {
    ISSUE_ID: safeIssueId,
    WORKSPACE_PATH: workspace.localPath,
    WORKSPACE_NAME: workspace.name,
  }

  try {
    // Ensure worktrees directory exists
    const parentDir = path.dirname(worktreePath)
    await $`mkdir -p ${parentDir}`.quiet()

    // Remove existing worktree registration if it exists
    try {
      await $`git worktree remove ${worktreePath} --force`.cwd(workspace.localPath).quiet()
    } catch {
      // Worktree not registered, that's fine
    }

    // Remove existing worktree directory if it exists
    try {
      await $`rm -rf ${worktreePath}`.cwd(workspace.localPath).quiet()
    } catch {
      // Directory doesn't exist, that's fine
    }

    // Prune any stale worktree entries
    try {
      await $`git worktree prune`.cwd(workspace.localPath).quiet()
    } catch {
      // Prune not available or failed, continue
    }

    // Create branch from main/master and worktree
    const mainBranch = await getMainBranch(workspace.localPath)
    await $`git worktree add -B ${branch} ${worktreePath} ${mainBranch}`.cwd(workspace.localPath).quiet()

    if (config.postCreateScript) {
      const scriptVariables = {
        ...variables,
        WORKTREE_PATH: worktreePath,
      }
      const scriptTemplate = renderTemplate(config.postCreateScript, scriptVariables)
      const scriptPath = path.isAbsolute(scriptTemplate)
        ? scriptTemplate
        : path.join(worktreePath, scriptTemplate)

      const exists = await Bun.file(scriptPath).exists()
      if (!exists) {
        throw new Error(`Post-create script not found: ${scriptPath}`)
      }

      logger.info(`[worktree] Running post-create script: ${scriptPath}`)
      try {
        await $`bash ${scriptPath}`.cwd(worktreePath).env({
          ...process.env,
          WORKTREE_PATH: worktreePath,
          WORKSPACE_PATH: workspace.localPath,
          WORKSPACE_NAME: workspace.name,
          ISSUE_ID: safeIssueId,
        }).quiet()
        logger.info('[worktree] Post-create script completed')
      } catch (error) {
        logger.error({ error }, `[worktree] Post-create script failed: ${scriptPath}`)
        try {
          await removeWorktree(workspace.localPath, worktreePath)
        } catch {
          // Cleanup best-effort
        }
        throw error
      }
    }

    logger.info(`[worktree] Created worktree at ${worktreePath} on branch ${branch}`)
    return { success: true, path: worktreePath, branch }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ error }, `[worktree] Failed to create worktree: ${errorMessage}`)
    return {
      success: false,
      path: worktreePath,
      branch,
      error: errorMessage
    }
  }
}

/**
 * Clean up worktree after work is complete (optional, for future use)
 */
export async function removeWorktree(basePath: string, worktreePath: string): Promise<void> {
  await $`git worktree remove ${worktreePath} --force`.cwd(basePath).quiet()
}

async function getMainBranch(basePath: string): Promise<string> {
  const result = await $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(basePath).quiet().text()
  return result.trim().replace('refs/remotes/origin/', '')
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => variables[key] ?? '')
}

function normalizeIssueIdentifier(issueIdentifier: string): string {
  return issueIdentifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}
