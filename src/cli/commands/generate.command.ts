import type { Command } from 'commander';
import { analyzeRepository } from '../../repository/index.js';
import { analyzeLogs } from '../../logs/log-parser.js';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';

interface GenerateOptions {
  application: string;
  repository: string;
  flow: string;
  logs?: string;
  traceId?: string;
}

export function registerGenerateCommand(program: Command): void {
  program.command('generate')
    .description('Analyze a local Java/Spring Boot repository')
    .requiredOption('--application <name>', 'Application name')
    .requiredOption('--repository <path>', 'Path to the cloned repository')
    .requiredOption('--flow <name>', 'Flow name')
    .option('--logs <path>', 'Path to a TXT or LOG file')
    .option('--trace-id <id>', 'Analyze only the selected trace in the log')
    .action(async (options: GenerateOptions, command: Command) => {
      let stage: 'repository' | 'log' = 'repository';
      try {
        const analysis = await analyzeRepository(options.repository);
        const endpoints = analysis.controllers.flatMap((controller) => controller.endpoints);
        console.log(sanitizeSensitiveData([
          'Repository analyzed',
          '',
          `Application: ${options.application}`,
          `Controllers: ${analysis.controllers.length}`,
          `Endpoints: ${endpoints.length}`,
          `Feign clients: ${analysis.feignClients.length}`,
          '',
          'Endpoints encontrados:',
          ...endpoints.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path}`),
          '',
          'External clients:',
          ...analysis.feignClients.map((client) => client.clientName ?? client.name),
        ].join('\n')));
        if (options.logs) {
          stage = 'log';
          const logs = await analyzeLogs(options.logs, options.traceId);
          console.log([
            'Log analyzed',
            '',
            `Lines processed: ${logs.linesProcessed}`,
            `Relevant lines: ${logs.relevantLines}`,
            `Trace IDs found: ${logs.traceIdsFound}`,
            `HTTP calls found: ${logs.httpCallsFound}`,
            `Context reduction: ${logs.contextReduction}%`,
          ].join('\n'));
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const reason = code === 'ENOENT'
          ? stage === 'repository' ? 'Repository does not exist' : 'Log file does not exist'
          : error instanceof Error ? error.message : String(error);
        command.error(sanitizeSensitiveData(`Unable to analyze ${stage} "${stage === 'repository' ? options.repository : options.logs}": ${reason}`), {
          code: stage === 'repository' ? 'perf-ai.repositoryAnalysisFailed' : 'perf-ai.logAnalysisFailed',
        });
      }
    });
}
