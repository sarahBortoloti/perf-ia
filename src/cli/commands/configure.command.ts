import type { Command } from 'commander';
import { runConfigure } from './configure-workflow.js';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';

export function registerConfigureCommand(program: Command): void {
  program.command('configure').description('Configure approved integration URLs from an existing publication')
    .option('--dry-run', 'Preview configuration proposals without changing files')
    .option('--publication <path>', 'Path to the publication.json to configure')
    .action(async (options: { dryRun?: boolean; publication?: string }, command: Command) => {
      try { await runConfigure(options); }
      catch (error) {
        if (error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name)) { console.log('Configuração cancelada.'); return; }
        command.error(sanitizeSensitiveData(error instanceof Error ? error.message : 'Falha ao configurar aplicação.'), { code: 'perf-ai.configurationFailed' });
      }
    });
}
