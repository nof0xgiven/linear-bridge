import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

const registry = new Registry()

collectDefaultMetrics({ register: registry })

export const webhookEventsTotal = new Counter({
  name: 'enhance_ticket_webhook_events_total',
  help: 'Total webhook events received',
  labelNames: ['type', 'action', 'result'] as const,
  registers: [registry],
})

export const triggerMatchesTotal = new Counter({
  name: 'enhance_ticket_trigger_matches_total',
  help: 'Total triggers matched',
  labelNames: ['triggerType', 'action'] as const,
  registers: [registry],
})

export const agentRunsTotal = new Counter({
  name: 'enhance_ticket_agent_runs_total',
  help: 'Total agent runs by outcome',
  labelNames: ['action', 'outcome'] as const,
  registers: [registry],
})

export const agentRunDurationSeconds = new Histogram({
  name: 'enhance_ticket_agent_run_duration_seconds',
  help: 'Agent run duration in seconds',
  labelNames: ['action', 'outcome'] as const,
  buckets: [30, 60, 300, 600, 1200, 1800, 3600],
  registers: [registry],
})

export const healthCheckFailuresTotal = new Counter({
  name: 'enhance_ticket_health_check_failures_total',
  help: 'Total health check failures',
  labelNames: ['check'] as const,
  registers: [registry],
})

export async function metricsPayload(): Promise<string> {
  return registry.metrics()
}

export function resetMetrics(): void {
  registry.resetMetrics()
}
