export type WorkflowBotName =
  | 'Code Bot'
  | 'Context Bot'
  | 'Plan Bot'
  | 'Guide Bot'
  | 'Review Bot'
  | 'GitHub Bot'
  | 'Mention Reply'

export type WorkflowErrorCode =
  | 'NO_TASK_DESCRIPTION'
  | 'NO_WORKTREE'
  | 'NO_DIFF'
  | 'WORKSPACE_NOT_CONFIGURED'
  | 'ORIGIN_HEAD_UNRESOLVED'
  | 'CONTEXT_DISABLED'
  | 'GUIDE_DISABLED'
  | 'GUIDE_MISSING_DOCS_PATH'
  | 'GUIDE_MISSING_CREDENTIALS'
  | 'GITHUB_DISABLED'
  | 'GITHUB_REPO_NOT_CONFIGURED'
  | 'WORKTREE_DIRTY'
  | 'UNKNOWN'

export type WorkflowFailure = {
  code: WorkflowErrorCode
  message: string
  nextSteps?: string[]
  details?: string
}

export type WorkflowFailureAckOptions = {
  bot: WorkflowBotName
  issueRef?: string
  failure: WorkflowFailure
  triggerLabelRemoved?: boolean
  automationWarning?: string
}

export function formatFailureAck(options: WorkflowFailureAckOptions): string {
  const { bot, issueRef, failure, triggerLabelRemoved, automationWarning } = options

  const parts: string[] = []
  parts.push(`## ${bot}`)
  parts.push('')
  if (issueRef) {
    parts.push(`**Issue:** ${issueRef}`)
    parts.push('')
  }
  parts.push(failure.message.trim())

  if (failure.nextSteps && failure.nextSteps.length > 0) {
    parts.push('')
    parts.push('### Next steps')
    parts.push('')
    for (const step of failure.nextSteps) {
      parts.push(`- ${step}`)
    }
  }

  if (failure.details) {
    parts.push('')
    parts.push('### Details')
    parts.push('')
    parts.push('```')
    parts.push(failure.details.trim())
    parts.push('```')
  }

  if (triggerLabelRemoved) {
    parts.push('')
    parts.push('_Trigger label removed to allow retry._')
  }

  if (automationWarning) {
    parts.push('')
    parts.push(`_Automation warning:_ ${automationWarning.trim()}`)
  }

  return parts.join('\n')
}

