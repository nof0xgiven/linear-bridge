import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import { stringify } from 'yaml'

interface InitOptions {
  minimal?: boolean
  force?: boolean
  interactive?: boolean
  output?: string
}

export function initCommand(program: Command): void {
  program
    .command('init')
    .description('Create a starter config.yaml')
    .option('-m, --minimal', 'Use minimal config template')
    .option('-f, --force', 'Overwrite existing config file')
    .option('-i, --interactive', 'Run interactive setup wizard')
    .option('-o, --output <path>', 'Output path', 'config.yaml')
    .action(async (options: InitOptions) => {
      const outputPath = path.resolve(process.cwd(), options.output ?? 'config.yaml')
      if (fs.existsSync(outputPath) && !options.force) {
        throw new Error(`Config already exists at ${outputPath}. Use --force to overwrite.`)
      }

      if (options.interactive) {
        const config = await buildInteractiveConfig()
        fs.writeFileSync(outputPath, stringify(config), 'utf8')
        return
      }

      const templateName = options.minimal ? 'config.minimal.yaml' : 'config.example.yaml'
      const templatePath = path.resolve(process.cwd(), templateName)
      if (!fs.existsSync(templatePath)) {
        throw new Error(`Template not found: ${templatePath}`)
      }
      fs.copyFileSync(templatePath, outputPath)
    })
}

async function buildInteractiveConfig() {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const workspaceName = await rl.question('Workspace name: ')
  const teamId = await rl.question('Linear teamId: ')
  const localPath = await rl.question('Local repo path: ')
  const mentionName = await rl.question('Mention tag (default: et): ')
  rl.close()

  if (!workspaceName || !teamId || !localPath) {
    throw new Error('Workspace name, teamId, and local repo path are required.')
  }

  return {
    version: '1.0',
    server: {
      port: 4747,
      host: '0.0.0.0',
      logLevel: 'info',
    },
    bot: {
      mentionName: mentionName || 'et',
    },
    linear: {
      apiKey: '${LINEAR_API_KEY}',
      webhookSecret: '${LINEAR_WEBHOOK_SECRET}',
      workspaces: [
        {
          name: workspaceName,
          teamId,
          projectIds: [],
          localPath,
        },
      ],
      triggers: [
        { type: 'label', value: 'discovery', action: 'context', on: ['create', 'update'] },
        { type: 'label', value: 'plan', action: 'plan', on: ['create', 'update'] },
        { type: 'label', value: 'code', action: 'quick', on: ['create', 'update'] },
        { type: 'label', value: 'review', action: 'review', on: ['create', 'update'] },
        { type: 'label', value: 'guide', action: 'guide', on: ['create', 'update'] },
        { type: 'label', value: 'github', action: 'github', on: ['create', 'update'] },
        { type: 'mention', value: '@claude', action: 'reply', agent: 'claude', on: ['create'] },
        { type: 'mention', value: '@codex', action: 'reply', agent: 'codex', on: ['create'] },
      ],
    },
    sandbox: {
      default: {
        agent: 'claude',
        permissionMode: 'default',
        timeoutMs: 1800000,
        progressIntervalMs: 60000,
      },
      overrides: [],
      connection: {},
    },
    context: {
      enabled: true,
      command: "rp-cli -e 'context_builder task=\"{TASK}\"'",
      timeoutMs: 600000,
      maxOutputSize: 50000,
    },
    worktree: {
      nameTemplate: '{WORKSPACE_PATH}-worktrees/{ISSUE_ID}',
      branchTemplate: 'fix/{ISSUE_ID}',
      cleanupOnComplete: false,
    },
    progress: {
      updateIntervalMs: 60000,
      includeToolCalls: true,
      includeFileChanges: true,
    },
    advanced: {
      enableTelemetry: true,
      enableMetrics: true,
      enableHealthCheck: true,
      enableInspector: false,
    },
  }
}
