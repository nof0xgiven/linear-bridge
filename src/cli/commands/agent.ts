import { Command } from 'commander'
import { clearConfigCache, getConfig } from '../../config'
import { testSandboxConnection } from '../../sandbox'

interface AgentOptions {
  config?: string
}

export function agentCommand(program: Command): void {
  const agent = program.command('agent').description('Sandbox agent utilities')

  agent
    .command('test')
    .description('Test sandbox agent connectivity')
    .option('-c, --config <path>', 'Config file path')
    .action(async (options: AgentOptions) => {
      clearConfigCache()
      const configPaths = options.config ? [options.config] : undefined
      const config = getConfig({ configPaths })
      try {
        await testSandboxConnection(config.sandbox)
        console.log('Sandbox agent is reachable.')
      } catch (error) {
        console.error(`Sandbox agent test failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}
