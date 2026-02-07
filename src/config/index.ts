import { loadConfig, buildDefaultTriggers, type LoadConfigOptions } from './loader'
import type { AppConfig } from './schema'

let cachedConfig: AppConfig | null = null

export function getConfig(options: LoadConfigOptions = {}): AppConfig {
  if (!cachedConfig || options.configPaths) {
    const config = loadConfig(options)
    cachedConfig = buildDefaultTriggers(config)
  }
  return cachedConfig
}

export function clearConfigCache(): void {
  cachedConfig = null
}
