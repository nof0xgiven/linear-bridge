import type { TriggerConfig } from '../config/schema'

export interface TriggerLabel {
  id: string
  name: string
}

export interface TriggerContext {
  eventType: 'Issue' | 'Comment'
  action: 'create' | 'update' | 'remove'
  issue: {
    id: string
    identifier?: string
    title?: string
    description?: string
    labels?: string[]
    labelsDetailed?: TriggerLabel[]
    labelIds?: string[]
    updatedFromLabelIds?: string[]
    teamId?: string
    projectId?: string
  }
  comment?: {
    id: string
    body: string
  }
}

export interface TriggerMatch {
  trigger: TriggerConfig
  action: TriggerConfig['action']
}

export interface TriggerEvaluator {
  type: TriggerConfig['type']
  matches: (trigger: TriggerConfig, context: TriggerContext) => boolean
}
