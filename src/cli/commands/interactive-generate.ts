import { input, select } from '@inquirer/prompts';
import { access, stat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname } from 'node:path';
import { analyzeRepository } from '../../repository/index.js';
import type { RepositoryAnalysis } from '../../repository/types.js';
import type { Entrypoint } from '../../flow/models.js';
import { safeName } from '../../shared/safe-name.js';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';
import { formatRepositoryDiagnostics, formatEndpointWarning } from '../../repository/repository-diagnostics.js';

export async function validateRepositoryPath(path: string): Promise<true | string> {
  try {
    if (!(await stat(path)).isDirectory()) return 'O caminho deve ser um diretório.';
    await access(path, constants.R_OK);
    await readdir(path);
    return true;
  } catch { return 'Repositório inexistente ou sem permissão de leitura.'; }
}
export async function validateLogPath(path: string): Promise<true | string> {
  if (!['.txt', '.log'].includes(extname(path).toLowerCase())) return 'Informe um arquivo .txt ou .log.';
  try {
    if (!(await stat(path)).isFile()) return 'O caminho deve ser um arquivo.';
    await access(path, constants.R_OK);
    return true;
  } catch { return 'Arquivo de logs inexistente ou sem permissão de leitura.'; }
}
export function repositoryEndpoints(repository: RepositoryAnalysis): Entrypoint[] {
  return [...new Map(repository.controllers.flatMap((controller) => controller.endpoints)
    .map((endpoint) => [`${endpoint.httpMethod} ${endpoint.path}`, { method: endpoint.httpMethod, path: endpoint.path }])).values()];
}
export function normalizeOptionalTraceId(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}
export async function promptGenerate(debug = false): Promise<{
  application: string; repository: string; flow: string; logs: string; traceId?: string;
  entrypoint: Entrypoint; analysis: RepositoryAnalysis;
}> {
  const application = (await input({ message: 'Qual o nome da aplicação?', validate: (value) => value.trim() ? true : 'Informe o nome da aplicação.' })).trim();
  const repository = (await input({ message: 'Informe o caminho do repositório:', validate: validateRepositoryPath })).trim();
  const analysis = await analyzeRepository(repository);
  console.log(formatRepositoryDiagnostics(analysis));
  if (debug) console.log('[generate] repository complete');
  const endpoints = repositoryEndpoints(analysis);
  if (!endpoints.length) throw new Error('Nenhum endpoint encontrado no repositório.');
  const entrypoint = await select<Entrypoint>({
    message: 'Qual endpoint deseja virtualizar?',
    choices: endpoints.map((endpoint) => ({ name: sanitizeSensitiveData(`${endpoint.method} ${endpoint.path}`), value: endpoint })),
  });
  if (debug) console.log('[generate] endpoint selected');
  const warning = formatEndpointWarning(analysis, entrypoint);
  if (warning) console.warn(warning);
  const logs = (await input({ message: 'Informe o caminho do arquivo de logs (.txt ou .log):', validate: validateLogPath })).trim();
  if (debug) console.log('[generate] log path received');
  const traceId = normalizeOptionalTraceId(await input({ message: 'Possui Trace ID? (opcional)' }));
  if (debug) console.log(`[generate] traceId: ${traceId ? 'provided' : 'not provided'}`);
  return { application, repository, flow: safeName(entrypoint.path), logs, traceId, entrypoint, analysis };
}
