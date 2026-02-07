import pino from 'pino'

const baseLogger = pino({
  level: 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
})

export const logger = baseLogger

export function setLogLevel(level: string): void {
  logger.level = level
}
