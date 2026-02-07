import { Command } from 'commander'
import { initCommand } from './commands/init'
import { validateCommand } from './commands/validate'
import { testTriggerCommand } from './commands/test-trigger'
import { workspaceCommand } from './commands/workspace'
import { agentCommand } from './commands/agent'
import { linearCommand } from './commands/linear'

const program = new Command()

program
  .name('enhance-ticket')
  .description('Automation tool for Linear label/mention workflows')
  .version('1.0.0')

initCommand(program)
validateCommand(program)
testTriggerCommand(program)
workspaceCommand(program)
agentCommand(program)
linearCommand(program)

program.parseAsync(process.argv)
