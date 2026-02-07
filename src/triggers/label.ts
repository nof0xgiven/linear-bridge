import type { TriggerConfig } from '../config/schema'
import type { TriggerContext, TriggerEvaluator } from './base'

export const labelTriggerEvaluator: TriggerEvaluator = {
  type: 'label',
  matches(trigger: TriggerConfig, context: TriggerContext): boolean {
    if (context.eventType !== 'Issue') return false

    const wanted = trigger.value.trim().toLowerCase()
    if (!wanted) return false

    const labels = context.issue.labels ?? []
    const hasLabel = labels.some((label) => label.trim().toLowerCase() === wanted)
    if (!hasLabel) return false

    // For update events, only trigger when the label was newly added in this update.
    // This prevents "on: [update]" from retriggering on every subsequent issue edit.
    if (context.action !== 'update') {
      return true
    }

    const previousLabelIds = context.issue.updatedFromLabelIds
    if (previousLabelIds === undefined) {
      // If we can't safely detect additions, don't match on update.
      return false
    }

    const currentLabelIds = context.issue.labelIds
      ?? context.issue.labelsDetailed?.map((label) => label.id)
      ?? []

    const labelId = context.issue.labelsDetailed
      ?.find((label) => label.name.trim().toLowerCase() === wanted)
      ?.id

    if (!labelId) return false

    return !previousLabelIds.includes(labelId) && currentLabelIds.includes(labelId)
  },
}
