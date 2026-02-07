import { zodToJsonSchema } from 'zod-to-json-schema'
import { writeFileSync } from 'fs'
import { AppConfigSchema } from '../src/config/schema'

const schema = zodToJsonSchema(AppConfigSchema, { name: 'EnhanceTicketConfig' })

writeFileSync('config.schema.json', JSON.stringify(schema, null, 2))
