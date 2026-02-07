import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const args = process.argv.slice(2)
const payloadIndex = args.indexOf('--payload')
const urlIndex = args.indexOf('--url')

if (payloadIndex === -1 || !args[payloadIndex + 1]) {
  console.error('Usage: bun scripts/send-webhook.ts --payload <path> [--url <webhookUrl>]')
  process.exit(1)
}

const payloadPath = path.resolve(process.cwd(), args[payloadIndex + 1])
const webhookUrl = urlIndex !== -1 ? args[urlIndex + 1] : 'http://localhost:4747/webhook'

const secret = process.env.LINEAR_WEBHOOK_SECRET
if (!secret) {
  console.error('LINEAR_WEBHOOK_SECRET is required to sign the webhook payload.')
  process.exit(1)
}

const payload = fs.readFileSync(payloadPath, 'utf8')
const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex')

const response = await fetch(webhookUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'linear-signature': signature,
  },
  body: payload,
})

console.log(`Status: ${response.status}`)
console.log(await response.text())
