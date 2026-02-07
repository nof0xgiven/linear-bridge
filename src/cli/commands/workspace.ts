import { Command } from 'commander'
import { clearConfigCache, getConfig } from '../../config'

interface WorkspaceOptions {
  config?: string
}

export function workspaceCommand(program: Command): void {
  const workspace = program.command('workspace').description('Workspace management')

  workspace
    .command('list')
    .description('List configured workspaces')
    .option('-c, --config <path>', 'Config file path')
    .action((options: WorkspaceOptions) => {
      clearConfigCache()
      const configPaths = options.config ? [options.config] : undefined
      const config = getConfig({ configPaths })
      for (const entry of config.linear.workspaces) {
        console.log(`${entry.name} | teamId=${entry.teamId} | path=${entry.localPath}`)
      }
    })
}
