import type { AppConfig, WorkspaceConfig } from './config/schema'

export interface IssueContext {
  id: string
  identifier?: string
  teamId?: string
  projectId?: string
}

export function resolveWorkspaceForIssue(
  config: AppConfig,
  issue: IssueContext
): WorkspaceConfig {
  if (!issue.teamId) {
    throw new Error('Issue teamId is required for workspace resolution')
  }

  const candidates = config.linear.workspaces.filter((workspace) => workspace.teamId === issue.teamId)
  if (candidates.length === 0) {
    throw new Error(`No workspace configured for teamId ${issue.teamId}`)
  }

  if (issue.projectId) {
    const projectMatches = candidates.filter((workspace) => (workspace.projectIds ?? []).includes(issue.projectId as string))
    if (projectMatches.length === 1) {
      return projectMatches[0]
    }
    if (projectMatches.length > 1) {
      throw new Error(`Multiple workspaces match projectId ${issue.projectId}`)
    }
  }

  const fallbackMatches = candidates.filter((workspace) => (workspace.projectIds ?? []).length === 0)
  if (fallbackMatches.length === 1) {
    return fallbackMatches[0]
  }

  if (fallbackMatches.length > 1) {
    throw new Error(`Multiple workspaces match teamId ${issue.teamId} with no projectIds filter`)
  }

  throw new Error(`No workspace configured for teamId ${issue.teamId} with projectId ${issue.projectId ?? 'none'}`)
}

export function getSandboxOverride(config: AppConfig, workspaceName: string) {
  return config.sandbox.overrides.find((override) => override.workspace === workspaceName)
}
