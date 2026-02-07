import fs from 'fs/promises'
import path from 'path'
import type { AppConfig } from './config/schema'
import { logger } from './logger'

export interface DeadLetterEntry {
  timestamp: string
  issueId: string
  workflow: 'full' | 'quick' | 'context' | 'guide' | 'plan' | 'reply' | 'review' | 'github'
  error: string
}

export async function writeDeadLetter(config: AppConfig, entry: DeadLetterEntry): Promise<void> {
  try {
    const filePath = path.isAbsolute(config.advanced.deadLetterPath)
      ? config.advanced.deadLetterPath
      : path.join(process.cwd(), config.advanced.deadLetterPath)

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    logger.error({ error }, '[dead-letter] Failed to write entry')
  }
}
