import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';
import type { ConfigurationContext } from './models.js';

function safeUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && sanitizeSensitiveData(value) === value; } catch { return false; }
}
const publication = z.object({ application: z.string().min(1), flow: z.string().min(1), services: z.array(z.object({ method: z.string(), path: z.string().startsWith('/'), url: z.string().refine(safeUrl) })).min(1) });
const flow = z.object({
  application: z.string(), flow: z.string(), applicationRepository: z.string().optional(), repositoryPath: z.string().optional(), configurationRepository: z.string().optional(),
  externalCalls: z.array(z.object({ client: z.string().optional(), clientMethod: z.string().optional(), method: z.string().optional(), path: z.string().optional(), url: z.string().optional(), codePath: z.string().optional(), codeUrl: z.string().optional(), configurationProperty: z.string().optional() })),
});
export async function discoverPublications(outputRoot = 'output'): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'virtualization') await visit(path);
      else if (entry.isFile() && entry.name === 'publication.json') result.push(path);
    }
  }
  try { await visit(resolve(outputRoot)); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  return result;
}
export async function readConfigurationContext(publicationPath: string): Promise<ConfigurationContext> {
  const path = resolve(publicationPath);
  if (basename(path) !== 'publication.json') throw new Error('Selecione um arquivo publication.json.');
  let published: z.infer<typeof publication>;
  let context: z.infer<typeof flow>;
  try {
    published = publication.parse(JSON.parse(await readFile(path, 'utf8')));
    context = flow.parse(JSON.parse(await readFile(join(dirname(path), 'flow-context.json'), 'utf8')));
  } catch { throw new Error('publication.json ou flow-context.json ausente/inválido; nenhuma configuração alterada.'); }
  if (published.application !== context.application || published.flow !== context.flow) throw new Error('Publication e FlowContext pertencem a fluxos diferentes.');
  let saved: unknown;
  try { saved = JSON.parse(await readFile(join(dirname(path), 'configuration.json'), 'utf8')); } catch { /* First configuration run. */ }
  const previous = z.object({ applicationRepository: z.string().optional(), configurationRepository: z.string().optional() }).safeParse(saved);
  return { application: published.application, flow: published.flow, publicationPath: path, flowDirectory: dirname(path), services: published.services, externalCalls: context.externalCalls,
    applicationRepository: context.applicationRepository ?? context.repositoryPath ?? (previous.success ? previous.data.applicationRepository : undefined),
    configurationRepository: context.configurationRepository ?? (previous.success ? previous.data.configurationRepository : undefined) };
}
