import type { Context, Next } from 'hono'

interface RateLimitState {
  count: number
  resetAt: number
}

const state = new Map<string, RateLimitState>()

export interface RateLimitOptions {
  enabled: boolean
  windowMs: number
  max: number
}

export function rateLimitMiddleware(options: RateLimitOptions) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!options.enabled) {
      await next()
      return
    }

    const key = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || c.req.raw?.url || 'unknown'
    const now = Date.now()
    const record = state.get(key)

    if (!record || record.resetAt <= now) {
      state.set(key, { count: 1, resetAt: now + options.windowMs })
      await next()
      return
    }

    record.count += 1
    if (record.count > options.max) {
      c.status(429)
      c.header('retry-after', Math.ceil((record.resetAt - now) / 1000).toString())
      return c.json({ error: 'Rate limit exceeded' })
    }

    await next()
  }
}
