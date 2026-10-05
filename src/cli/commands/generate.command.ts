import type { Command } from 'commander';
import { analyzeRepository } from '../../repository/index.js';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';
import { promptGenerate, validateRepositoryPath, validateLogPath } from './interactive-generate.js';
import { generateWorkflow, selectArgumentEntrypoint } from './generate-workflow.js';

interface GenerateOptions {
  application?: string;
  repository?: string;
  flow?: string;
  logs?: string;
  traceId?: string;
  endpoint?: string;
}

export function registerGenerateCommand(program: Command): void {
  program.command('generate')
    .description('Analyze a local repository and generate virtualization files')
    .option('--application <name>', 'Application name')
    .option('--repository <path>', 'Path to the cloned repository')
    .option('--flow <name>', 'Flow name')
    .option('--logs <path>', 'Path to a TXT or LOG file')
    .option('--trace-id <id>', 'Analyze only the selected trace in the log')
    .option('--endpoint <method-path>', 'Select an endpoint when logs are ambiguous, e.g. "POST /items"')
    .action(async (options: GenerateOptions, command: Command) => {
      const interactive = Object.keys(options).length === 0;
      if (!interactive) {
        for (const name of ['application', 'repository', 'flow'] as const) {
          if (!options[name]?.trim()) command.error(`error: required option '--${name} <${name === 'repository' ? 'path' : 'name'}>' not specified`, { code: 'commander.missingMandatoryOptionValue' });
        }
      }
      let stage: 'repository' | 'log' | 'generation' = 'repository';
      try {
        if (interactive) {
          const input = await promptGenerate();
          stage = 'generation';
          await generateWorkflow({ application: input.application, flow: input.flow, entrypoint: input.entrypoint, repository: input.analysis, logPath: input.logs, traceId: input.traceId });
          return;
        }
        const validRepository = await validateRepositoryPath(options.repository!);
        if (validRepository !== true) throw new Error(`Repository does not exist or cannot be read: ${validRepository}`);
        const analysis = await analyzeRepository(options.repository!);
        const endpoints = analysis.controllers.flatMap((controller) => controller.endpoints);
        if (options.logs) {
          stage = 'log';
          const validLog = await validateLogPath(options.logs);
          if (validLog !== true) throw new Error(`Log file does not exist, cannot be read, or is invalid: ${validLog}`);
          const entrypoint = await selectArgumentEntrypoint(analysis, options.logs, options.traceId, options.endpoint);
          stage = 'generation';
          await generateWorkflow({ application: options.application!, flow: options.flow!, entrypoint, repository: analysis, logPath: options.logs, traceId: options.traceId });
        } else {
          // Preserve the previous repository-only invocation.
          console.log(sanitizeSensitiveData([
            'Repository analyzed', '', `Application: ${options.application}`, `Controllers: ${analysis.controllers.length}`,
            `Endpoints: ${endpoints.length}`, `Feign clients: ${analysis.feignClients.length}`, '', 'Endpoints encontrados:',
            ...endpoints.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path}`), '', 'External clients:',
            ...analysis.feignClients.map((client) => client.clientName ?? client.name),
          ].join('\n')));
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        command.error(sanitizeSensitiveData(`Unable to complete ${stage}: ${reason}`), {
          code: stage === 'repository' ? 'perf-ai.repositoryAnalysisFailed' : stage === 'log' ? 'perf-ai.logAnalysisFailed' : 'perf-ai.generationFailed',
        });
      }
    });
}
