import type { TriggerConfig } from '../config/schema'
import type { TriggerContext, TriggerEvaluator } from './base'

export const mentionTriggerEvaluator: TriggerEvaluator = {
  type: 'mention',
  matches(trigger: TriggerConfig, context: TriggerContext): boolean {
    if (context.eventType !== 'Comment' || !context.comment) return false

    const wanted = trigger.value.trim()
    if (!wanted) return false

    const regex = new RegExp(`^\\s*${escapeRegex(wanted)}\\b`, 'i')
    return regex.test(context.comment.body)
  },
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')
}

