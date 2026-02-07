# Security

## Webhook Verification

All webhook requests must include a valid `linear-signature` HMAC.

## Secrets Management

Store secrets in environment variables and reference them via `${VAR}` in config.

## Rate Limiting

Webhook endpoint is protected by an in-memory rate limiter. Tune via `server.rateLimit`.

## Sandboxed Execution

Sandbox Agent runs in an isolated environment. Prefer remote sandbox servers for production.
