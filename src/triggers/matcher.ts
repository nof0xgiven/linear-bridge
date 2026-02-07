import type { TriggerConfig } from '../config/schema'
import type { TriggerContext, TriggerMatch } from './base'
import { pluginRegistry } from '../plugins/registry'
import { labelTriggerEvaluator } from './label'
import { hashtagTriggerEvaluator } from './hashtag'
import { mentionTriggerEvaluator } from './mention'

pluginRegistry.registerTrigger(labelTriggerEvaluator)
pluginRegistry.registerTrigger(hashtagTriggerEvaluator)
pluginRegistry.registerTrigger(mentionTriggerEvaluator)

export function matchTriggers(
  triggers: TriggerConfig[],
  context: TriggerContext
): TriggerMatch | null {
  for (const trigger of triggers) {
    if (trigger.on && !trigger.on.includes(context.action)) {
      continue
    }

    const evaluator = pluginRegistry.getTrigger(trigger.type)
    if (!evaluator) {
      continue
    }

    if (evaluator.matches(trigger, context)) {
      return { trigger, action: trigger.action }
    }
  }
  return null
}
