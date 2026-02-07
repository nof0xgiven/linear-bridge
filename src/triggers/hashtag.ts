import type { TriggerConfig } from '../config/schema'
import type { TriggerContext, TriggerEvaluator } from './base'

export const hashtagTriggerEvaluator: TriggerEvaluator = {
  type: 'hashtag',
  matches(trigger: TriggerConfig, context: TriggerContext): boolean {
    if (context.eventType !== 'Comment' || !context.comment) return false
    const value = trigger.value.startsWith('#') ? trigger.value : `#${trigger.value}`
    const regex = new RegExp(`${escapeRegex(value)}\\b`, 'i')
    return regex.test(context.comment.body)
  },
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')
}
