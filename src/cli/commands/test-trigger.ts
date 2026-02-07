import { Command } from 'commander'
import { clearConfigCache, getConfig } from '../../config'
import { matchTriggers } from '../../triggers/matcher'

interface TestOptions {
  config?: string
  labels?: string
  comment?: string
  action?: 'create' | 'update' | 'remove'
}

export function testTriggerCommand(program: Command): void {
  program
    .command('test-trigger <issueId>')
    .description('Test trigger matching for an issue or comment')
    .option('-c, --config <path>', 'Config file path')
    .option('-l, --labels <labels>', 'Comma-separated label names')
    .option('--comment <text>', 'Comment body to test hashtag triggers')
    .option('-a, --action <action>', 'Webhook action (create|update|remove)', 'create')
    .action((issueId: string, options: TestOptions) => {
      clearConfigCache()
      const configPaths = options.config ? [options.config] : undefined
      const config = getConfig({ configPaths })

      const action = options.action ?? 'create'
      const labels = options.labels ? options.labels.split(',').map((label) => label.trim()).filter(Boolean) : []

      const context = options.comment
        ? {
            eventType: 'Comment' as const,
            action,
            issue: { id: issueId },
            comment: { id: 'cli-comment', body: options.comment },
          }
        : {
            eventType: 'Issue' as const,
            action,
            issue: { id: issueId, labels },
          }

      const match = matchTriggers(config.linear.triggers, context)
      if (!match) {
        console.log('No trigger matched.')
        process.exit(1)
      }

      console.log(`Matched trigger: ${match.trigger.type} -> ${match.action}`)
    })
}
