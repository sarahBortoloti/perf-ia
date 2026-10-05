import type { Command } from 'commander';
import { analyzeRepository } from '../../repository/index.js';

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
    .option('--logs <path>', 'Reserved for future log processing')
    .option('--trace-id <id>', 'Reserved for future trace processing')
    .action(async (options: GenerateOptions, command: Command) => {
      try {
        const analysis = await analyzeRepository(options.repository);
        const endpoints = analysis.controllers.flatMap((controller) => controller.endpoints);
        console.log([
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
        ].join('\n'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const reason = code === 'ENOENT'
          ? 'Repository does not exist'
          : error instanceof Error ? error.message : String(error);
        command.error(`Unable to analyze repository "${options.repository}": ${reason}`, {
          code: 'perf-ai.repositoryAnalysisFailed',
        });
      }
    });
}
