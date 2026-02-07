import { Command } from 'commander'
import { getConfig, clearConfigCache } from '../../config'

interface ValidateOptions {
  config?: string
}

export function validateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate the configuration file')
    .option('-c, --config <path>', 'Config file path')
    .action((options: ValidateOptions) => {
      try {
        clearConfigCache()
        const configPaths = options.config ? [options.config] : undefined
        getConfig({ configPaths })
        console.log('Config is valid.')
      } catch (error) {
        console.error(`Config validation failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}
