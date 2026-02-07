import { LinearClient, type Issue, type Team } from '@linear/sdk'
import type { AppConfig } from './config/schema'

let client: LinearClient | null = null
let cachedKey: string | null = null

export function getLinearClient(config: AppConfig['linear']): LinearClient {
  if (!client || cachedKey !== config.apiKey) {
    client = new LinearClient({ apiKey: config.apiKey })
    cachedKey = config.apiKey
  }
  return client
}

/**
 * Fetch issue details including description
 */
export async function getIssue(config: AppConfig['linear'], issueId: string) {
  const linear = getLinearClient(config)
  const issue = await withRetry(() => linear.issue(issueId))
  const [team, project] = await Promise.all([issue.team, issue.project])
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    url: issue.url,
    teamId: team?.id,
    projectId: project?.id,
  }
}

export interface IssueCommentSummary {
  id: string
  body: string
  createdAt: string
}

export interface IssueLabelSummary {
  id: string
  name: string
}

export interface WorkflowStateSummary {
  id: string
  name: string
  type?: string
}

export interface IssueWithComments {
  id: string
  identifier?: string
  title: string
  description: string
  url?: string
  teamId?: string
  projectId?: string
  comments: IssueCommentSummary[]
  labelIds?: string[]
  labels?: IssueLabelSummary[]
  stateId?: string
  stateName?: string
}

/**
 * Fetch issue details including all comments
 */
export async function getIssueWithComments(
  config: AppConfig['linear'],
  issueId: string
): Promise<IssueWithComments> {
  const linear = getLinearClient(config)
  const issue = await withRetry(() => linear.issue(issueId))
  const [team, project, state] = await Promise.all([issue.team, issue.project, issue.state])

  const comments: IssueCommentSummary[] = []
  let after: string | undefined

  do {
    const connection = await withRetry(() => issue.comments({ first: 50, after }))
    for (const comment of connection.nodes) {
      comments.push({
        id: comment.id,
        body: comment.body ?? '',
        createdAt: comment.createdAt.toISOString()
      })
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined
  } while (after)

  const labels = await fetchAllIssueLabels(issue)

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    url: issue.url,
    teamId: team?.id,
    projectId: project?.id,
    comments,
    labelIds: issue.labelIds ?? undefined,
    labels,
    stateId: state?.id,
    stateName: state?.name,
  }
}

export interface IssueAutomationSnapshot {
  id: string
  identifier?: string
  title: string
  teamId?: string
  stateId?: string
  stateName?: string
  labelIds: string[]
  labels: IssueLabelSummary[]
}

/**
 * Fetch issue details needed for state/label automation (no comments).
 */
export async function getIssueAutomationSnapshot(
  config: AppConfig['linear'],
  issueId: string
): Promise<IssueAutomationSnapshot> {
  const linear = getLinearClient(config)
  const issue = await withRetry(() => linear.issue(issueId))
  const [team, state, labels] = await Promise.all([issue.team, issue.state, fetchAllIssueLabels(issue)])

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    teamId: team?.id,
    stateId: state?.id,
    stateName: state?.name,
    labelIds: issue.labelIds ?? [],
    labels,
  }
}

/**
 * Create a comment on an issue
 */
export async function createComment(
  config: AppConfig['linear'],
  issueId: string,
  body: string
): Promise<string> {
  const linear = getLinearClient(config)
  const comment = await withRetry(() => linear.createComment({
    issueId,
    body,
  }))

  const createdComment = comment.comment ? await comment.comment : undefined
  if (!createdComment) {
    throw new Error('Failed to create comment')
  }
  return createdComment.id
}

/**
 * Update an existing comment
 */
export async function updateComment(
  config: AppConfig['linear'],
  commentId: string,
  body: string
): Promise<void> {
  const linear = getLinearClient(config)
  await withRetry(() => linear.updateComment(commentId, { body }))
}

/**
 * Delete a comment
 */
export async function deleteComment(config: AppConfig['linear'], commentId: string): Promise<void> {
  const linear = getLinearClient(config)
  await withRetry(() => linear.deleteComment(commentId))
}

export async function updateIssueState(
  config: AppConfig['linear'],
  issueId: string,
  workflowStateId: string
): Promise<void> {
  await updateIssue(config, issueId, { stateId: workflowStateId })
}

export async function updateIssueLabels(
  config: AppConfig['linear'],
  issueId: string,
  labelIds: string[]
): Promise<void> {
  await updateIssue(config, issueId, { labelIds })
}

export async function updateIssue(
  config: AppConfig['linear'],
  issueId: string,
  input: { stateId?: string; labelIds?: string[] }
): Promise<void> {
  const linear = getLinearClient(config)
  await withRetry(() => linear.updateIssue(issueId, input))
}

type CachedTeamStates = {
  fetchedAtMs: number
  states: WorkflowStateSummary[]
}

const teamWorkflowStatesCache = new Map<string, CachedTeamStates>()
const TEAM_STATES_CACHE_TTL_MS = 5 * 60_000

export async function listTeamWorkflowStates(
  config: AppConfig['linear'],
  teamId: string,
  options?: { forceRefresh?: boolean }
): Promise<WorkflowStateSummary[]> {
  const cached = teamWorkflowStatesCache.get(teamId)
  const now = Date.now()
  if (!options?.forceRefresh && cached && (now - cached.fetchedAtMs) < TEAM_STATES_CACHE_TTL_MS) {
    return cached.states.slice()
  }

  const linear = getLinearClient(config)
  const team = await withRetry(() => linear.team(teamId))
  const states = await fetchAllTeamStates(team)
  teamWorkflowStatesCache.set(teamId, { fetchedAtMs: now, states })
  return states.slice()
}

export async function resolveWorkflowStateId(
  config: AppConfig['linear'],
  teamId: string,
  stateNameOrId: string
): Promise<string> {
  const wanted = stateNameOrId.trim()
  if (!wanted) {
    throw new Error('Workflow state must be non-empty')
  }

  if (looksLikeUuid(wanted)) {
    return wanted
  }

  const states = await listTeamWorkflowStates(config, teamId)
  const match = states.find((s) => s.name.trim().toLowerCase() === wanted.toLowerCase())
  if (!match) {
    const names = states.map((s) => s.name).sort().join(', ')
    throw new Error(`Workflow state not found for team ${teamId}: "${wanted}". Available: ${names}`)
  }
  return match.id
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 500): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      attempt += 1
      if (attempt > retries || !isRetryableError(error)) {
        throw error
      }
      await delay(baseDelayMs * attempt)
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (message.includes('rate limit') || message.includes('429')) return true
    if (message.includes('timeout') || message.includes('timed out')) return true
    if (message.includes('502') || message.includes('503') || message.includes('504')) return true
  }
  return false
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
}

async function fetchAllIssueLabels(issue: Issue): Promise<IssueLabelSummary[]> {
  const labels: IssueLabelSummary[] = []
  let after: string | undefined

  do {
    const connection = await withRetry(() => issue.labels({ first: 250, after }))
    for (const label of connection.nodes ?? []) {
      if (!label?.id || !label?.name) continue
      labels.push({ id: label.id, name: label.name })
    }
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined
  } while (after)

  return labels
}

async function fetchAllTeamStates(team: Team): Promise<WorkflowStateSummary[]> {
  const states: WorkflowStateSummary[] = []
  let after: string | undefined

  do {
    const connection = await withRetry(() => team.states({ first: 250, after }))
    for (const state of connection.nodes ?? []) {
      if (!state?.id || !state?.name) continue
      states.push({ id: state.id, name: state.name, type: state.type })
    }
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined
  } while (after)

  return states
}
