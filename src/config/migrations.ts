import type { AppConfig } from './schema'

export function migrateConfig(config: AppConfig): AppConfig {
  if (!config.version || config.version === '1.0') {
    return { ...config, version: '1.0' }
  }

  throw new Error(`Unsupported config version: ${config.version}`)
}
