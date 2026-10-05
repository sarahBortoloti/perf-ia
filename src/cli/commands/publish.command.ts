import type { Command } from 'commander';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';
import { runPublish } from './publish-workflow.js';

export function registerPublishCommand(program: Command): void {
  program.command('publish').description('Publish existing virtualization files to EasyPerf')
    .option('--dry-run', 'Select and validate files without opening a browser or contacting EasyPerf')
    .action(async (options: { dryRun?: boolean }, command: Command) => {
      try { await runPublish(options); }
      catch (error) {
        if (error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name)) { console.log('Publicação cancelada.'); return; }
        command.error(sanitizeSensitiveData(error instanceof Error ? error.message : 'Publication failed'), { code: 'perf-ai.publicationFailed' });
      }
    });
}
