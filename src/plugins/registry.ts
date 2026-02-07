import type { TriggerEvaluator } from '../triggers/base'

class PluginRegistry {
  private triggerEvaluators = new Map<string, TriggerEvaluator>()

  registerTrigger(evaluator: TriggerEvaluator): void {
    this.triggerEvaluators.set(evaluator.type, evaluator)
  }

  getTrigger(type: string): TriggerEvaluator | undefined {
    return this.triggerEvaluators.get(type)
  }
}

export const pluginRegistry = new PluginRegistry()
