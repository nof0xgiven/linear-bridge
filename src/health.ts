import { logger } from './logger'
import { healthCheckFailuresTotal } from './metrics'
import { getLinearClient } from './linear'
import { testSandboxConnection } from './sandbox'
import type { AppConfig } from './config/schema'
import { $ } from 'bun'

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error'
  timestamp: string
  checks: Record<string, { status: 'ok' | 'degraded' | 'error'; message?: string }>
}

export async function getHealthStatus(config: AppConfig): Promise<HealthStatus> {
  const checks: HealthStatus['checks'] = {}

  const results = await Promise.allSettled([
    checkLinear(config),
    checkRpCli(config),
    checkGit(config),
    checkSandbox(config),
  ])

  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      checks[result.value.name] = result.value.result
      if (result.value.result.status !== 'ok') {
        healthCheckFailuresTotal.inc({ check: result.value.name })
      }
    } else {
      logger.error({ error: result.reason }, '[health] check failed')
    }
  })

  const statuses = Object.values(checks).map((check) => check.status)
  const status: HealthStatus['status'] = statuses.includes('error')
    ? 'error'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'ok'

  return {
    status,
    timestamp: new Date().toISOString(),
    checks,
  }
}

async function checkLinear(config: AppConfig) {
  try {
    const client = getLinearClient(config.linear)
    await client.viewer
    return { name: 'linear', result: { status: 'ok' as const } }
  } catch (error) {
    return {
      name: 'linear',
      result: {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function checkRpCli(config: AppConfig) {
  if (!config.context.enabled) {
    return { name: 'rp-cli', result: { status: 'degraded' as const, message: 'context disabled' } }
  }
  try {
    await $`rp-cli --version`.quiet()
    return { name: 'rp-cli', result: { status: 'ok' as const } }
  } catch (error) {
    return {
      name: 'rp-cli',
      result: {
        status: 'degraded' as const,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function checkGit(_config: AppConfig) {
  try {
    await $`git --version`.quiet()
    return { name: 'git', result: { status: 'ok' as const } }
  } catch (error) {
    return {
      name: 'git',
      result: {
        status: 'degraded' as const,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function checkSandbox(config: AppConfig) {
  try {
    await testSandboxConnection(config.sandbox)
    return { name: 'sandbox', result: { status: 'ok' as const } }
  } catch (error) {
    return {
      name: 'sandbox',
      result: {
        status: 'degraded' as const,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
