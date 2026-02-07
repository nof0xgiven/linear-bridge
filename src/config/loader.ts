import fs from 'fs'
import path from 'path'
import os from 'os'
import { parse as parseYaml } from 'yaml'
import { AppConfigSchema, type AppConfig } from './schema'
import { migrateConfig } from './migrations'
import { validateConfig } from './validator'
import { logger } from '../logger'

export interface LoadConfigOptions {
  configPaths?: string[]
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const configPaths = options.configPaths ?? resolveConfigPaths()
  const loadedConfigs = configPaths.map((configPath) => loadConfigFile(configPath))
  const merged = mergeConfigs(loadedConfigs)
  const interpolated = interpolateEnv(merged)
  const parsed = AppConfigSchema.parse(interpolated)
  const migrated = migrateConfig(parsed)
  validateConfig(migrated)
  return migrated
}

export function resolveConfigPaths(): string[] {
  const envConfig = process.env.ENHANCE_TICKET_CONFIG
  if (envConfig) {
    const paths = envConfig.split(',').map((p) => p.trim()).filter(Boolean)
    if (paths.length === 0) {
      throw new Error('ENHANCE_TICKET_CONFIG is set but empty')
    }
    paths.forEach((configPath) => {
      if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`)
      }
    })
    return paths
  }

  const cwdConfig = path.join(process.cwd(), 'config.yaml')
  const homeConfig = path.join(os.homedir(), '.enhance-ticket', 'config.yaml')
  // Merge order matters: later configs override earlier ones.
  // Use home as fallback and allow local config to override it.
  const candidates = [homeConfig, cwdConfig].filter((p) => fs.existsSync(p))
  if (candidates.length === 0) {
    throw new Error(
      'No config file found. Set ENHANCE_TICKET_CONFIG or create ./config.yaml'
    )
  }
  return candidates
}

function loadConfigFile(configPath: string): Record<string, unknown> {
  const ext = path.extname(configPath).toLowerCase()
  const raw = fs.readFileSync(configPath, 'utf8')
  try {
    if (ext === '.yaml' || ext === '.yml') {
      return parseYaml(raw) as Record<string, unknown>
    }
    if (ext === '.json') {
      return JSON.parse(raw) as Record<string, unknown>
    }
  } catch (error) {
    throw new Error(
      `Failed to parse config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  throw new Error(`Unsupported config file extension: ${configPath}`)
}

function mergeConfigs(configs: Record<string, unknown>[]): Record<string, unknown> {
  return configs.reduce((acc, current) => deepMerge(acc, current), {})
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...target }
  Object.entries(source).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      output[key] = value.slice()
      return
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const currentTarget = output[key]
      if (currentTarget && typeof currentTarget === 'object' && !Array.isArray(currentTarget)) {
        output[key] = deepMerge(currentTarget as Record<string, unknown>, value as Record<string, unknown>)
      } else {
        output[key] = deepMerge({}, value as Record<string, unknown>)
      }
      return
    }
    output[key] = value
  })
  return output
}

function interpolateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing: string[] = []
  const resolved = resolveValue(config, missing)
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`)
  }
  return resolved
}

function resolveValue(value: unknown, missing: string[]): any {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
      const resolved = process.env[varName]
      if (!resolved) {
        missing.push(varName)
        return ''
      }
      return resolved
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, missing))
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      output[key] = resolveValue(val, missing)
    }
    return output
  }
  return value
}

export function buildDefaultTriggers(config: AppConfig): AppConfig {
  if (config.linear.triggers.length > 0) {
    return config
  }

  logger.warn('[config] No triggers configured, using defaults')
  return {
    ...config,
    linear: {
      ...config.linear,
      triggers: [
        { type: 'label', value: 'discovery', action: 'context', on: ['create', 'update'] },
        { type: 'label', value: 'plan', action: 'plan', on: ['create', 'update'] },
        { type: 'label', value: 'code', action: 'quick', on: ['create', 'update'] },
        { type: 'label', value: 'claude', action: 'quick', agent: 'claude', on: ['create', 'update'] },
        { type: 'label', value: 'codex', action: 'quick', agent: 'codex', on: ['create', 'update'] },
        { type: 'label', value: 'review', action: 'review', on: ['create', 'update'] },
        { type: 'label', value: 'guide', action: 'guide', on: ['create', 'update'] },
        { type: 'label', value: 'github', action: 'github', on: ['create', 'update'] },
        { type: 'mention', value: '@claude', action: 'reply', agent: 'claude', on: ['create'] },
        { type: 'mention', value: '@codex', action: 'reply', agent: 'codex', on: ['create'] },
      ],
    },
  }
}
