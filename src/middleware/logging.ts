import type { Context, Next } from 'hono'
import { logger } from '../logger'

export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
  c.set('requestId', requestId)
  c.header('x-request-id', requestId)
  await next()
}

export async function requestLoggingMiddleware(c: Context, next: Next): Promise<void> {
  const start = Date.now()
  await next()
  const durationMs = Date.now() - start
  const requestId = c.get('requestId') as string | undefined
  logger.info({
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs,
  }, 'request completed')
}
