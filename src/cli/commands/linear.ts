import { Command } from 'commander'
import { clearConfigCache, getConfig } from '../../config'
import { listTeamWorkflowStates } from '../../linear'

interface WorkflowStatesOptions {
  config?: string
  refresh?: boolean
}

export function linearCommand(program: Command): void {
  const linear = program.command('linear').description('Linear helpers')

  linear
    .command('workflow-states')
    .description('List workflow states for a Linear team (name, id, type)')
    .requiredOption('--teamId <id>', 'Linear team ID (UUID)')
    .option('-c, --config <path>', 'Config file path')
    .option('--refresh', 'Force refresh (ignore local cache)', false)
    .action(async (options: WorkflowStatesOptions & { teamId: string }) => {
      clearConfigCache()
      const configPaths = options.config ? [options.config] : undefined
      const config = getConfig({ configPaths })

      const states = await listTeamWorkflowStates(config.linear, options.teamId, { forceRefresh: Boolean(options.refresh) })
      const sorted = states.slice().sort((a, b) => a.name.localeCompare(b.name))

      for (const state of sorted) {
        const type = state.type ? ` | type=${state.type}` : ''
        console.log(`${state.name} | id=${state.id}${type}`)
      }
    })
}

