import { Hono } from 'hono'
import { createWebhookHandler } from './webhook'
import { createGitHubWebhookHandler } from './github-webhook'
import { getConfig } from './config'
import { logger, setLogLevel } from './logger'
import { requestIdMiddleware, requestLoggingMiddleware } from './middleware/logging'
import { rateLimitMiddleware } from './middleware/ratelimit'
import { getHealthStatus } from './health'
import { metricsPayload } from './metrics'
import type { AppConfig } from './config/schema'

let config: AppConfig
try {
  config = getConfig()
  setLogLevel(config.server.logLevel)
} catch (error) {
  console.error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const app = new Hono()

// Middleware
app.use('*', requestIdMiddleware)
app.use('*', requestLoggingMiddleware)

// Routes
app.post('/webhook', rateLimitMiddleware(config.server.rateLimit), createWebhookHandler(config))
app.get('/webhook', (c) => {
  return c.text('Linear webhook endpoint - POST only. Use this URL in Linear webhook settings.')
})

app.post('/github-webhook', rateLimitMiddleware(config.server.rateLimit), createGitHubWebhookHandler(config))
app.get('/github-webhook', (c) => {
  return c.text('GitHub webhook endpoint - POST only. Configure this URL in GitHub webhook settings.')
})

app.get('/health', async (c) => {
  if (!config.advanced.enableHealthCheck) {
    return c.json({ status: 'disabled' }, 404)
  }
  const status = await getHealthStatus(config)
  return c.json(status)
})

app.get('/metrics', async (c) => {
  if (!config.advanced.enableMetrics) {
    return c.json({ status: 'disabled' }, 404)
  }
  const payload = await metricsPayload()
  c.header('content-type', 'text/plain; version=0.0.4')
  return c.text(payload)
})

app.get('/', (c) => {
  return c.text('enhance-ticket webhook server')
})

// OAuth callback handler
app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')

  if (!code) {
    return c.json({ error: 'No authorization code provided' }, 400)
  }

  const clientId = config.linear.oauth.clientId
  const clientSecret = config.linear.oauth.clientSecret
  const redirectUri = config.linear.oauth.redirectUri

  if (!clientId || !clientSecret || !redirectUri) {
    return c.json({ error: 'OAuth not configured (missing CLIENT_ID or CLIENT_SECRET)' }, 500)
  }

  try {
    // Exchange code for access token
    const response = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      logger.error({ data }, '[oauth] Token exchange failed')
      return c.json({ error: 'Token exchange failed', details: data }, 400)
    }

    logger.info('[oauth] Token exchange successful')

    // Return success page
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>OAuth Success</title></head>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>✅ Authorization Successful</h1>
          <p>The Sandbox app has been authorized for your Linear workspace.</p>
          <p>Webhooks will now be delivered automatically.</p>
          <p style="color: #666; margin-top: 40px;">You can close this window.</p>
        </body>
      </html>
    `)
  } catch (error) {
    logger.error({ error }, '[oauth] Error')
    return c.json({ error: 'OAuth exchange failed', message: String(error) }, 500)
  }
})

const port = config.server.port

logger.info(`[server] Starting on port ${port}`)
logger.info(`[server] Trigger count: ${config.linear.triggers.length}`)

// Explicitly start the server for pm2 compatibility
const server = Bun.serve({
  port,
  hostname: config.server.host,
  fetch: app.fetch,
})

logger.info(`[server] Listening on http://${config.server.host}:${server.port}`)
