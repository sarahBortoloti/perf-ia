import { readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateVirtualization } from '../virtualization/virtualization-validator.js';
import { sanitizeValue, sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';
import type { VirtualizationFile, SelectedVirtualization, PublicationResult, Publication } from './types.js';
import { normalizeEndpointPath } from './easyperf-result-parser.js';

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
async function reviewMetadata(directory: string): Promise<{ paths: Set<string>; all: boolean }> {
  let text: string;
  try { text = await readFile(join(directory, 'flow-context.json'), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { paths: new Set(), all: false };
    return { paths: new Set(), all: true };
  }
  try {
    const context: unknown = JSON.parse(text);
    if (!object(context) || !Array.isArray(context.externalCalls)) return { paths: new Set(), all: true };
    const paths = new Set<string>();
    for (const call of context.externalCalls) {
      if (!object(call)) return { paths, all: true };
      if (call.confidence === 'REVIEW_REQUIRED' || (Array.isArray(call.reviewReasons) && call.reviewReasons.length)) {
        if (typeof call.path !== 'string' || typeof call.method !== 'string') return { paths, all: true };
        paths.add(`${call.method} ${call.path}`);
      }
    }
    return { paths, all: false };
  } catch { return { paths: new Set(), all: true }; }
}

export async function discoverVirtualizations(outputRoot = 'output'): Promise<VirtualizationFile[]> {
  const root = resolve(outputRoot);
  const files: VirtualizationFile[] = [];
  async function visit(directory: string, segments: string[]): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (segments.at(-1) === 'virtualization') {
      const flowDirectory = join(directory, '..');
      const metadata = await reviewMetadata(flowDirectory);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
        const filePath = join(directory, entry.name);
        let reviewRequired = metadata.all;
        if (metadata.paths.size) {
          try {
            const data: unknown = JSON.parse(await readFile(filePath, 'utf8'));
            if (object(data) && object(data.response)) reviewRequired ||= metadata.paths.has(`${data.response.metodo} ${data.response.path}`);
          } catch { /* Validation reports invalid JSON after selection. */ }
        }
        files.push({ filePath, fileName: entry.name, application: segments[0] ?? '', flow: segments.slice(1, -1).join('/'), flowDirectory, reviewRequired });
      }
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) await visit(join(directory, entry.name), [...segments, entry.name]);
  }
  try { if ((await lstat(root)).isSymbolicLink()) throw new Error('Output directory cannot be a symbolic link'); await visit(root, []); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  return files;
}

export async function validateSelectedFiles(files: VirtualizationFile[]): Promise<SelectedVirtualization[]> {
  const selected: SelectedVirtualization[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      if (!(await lstat(file.filePath)).isFile()) throw new Error('Selected JSON is not a regular file');
      const raw: unknown = JSON.parse(await readFile(file.filePath, 'utf8'));
      validateVirtualization(raw);
      const clean = sanitizeValue(raw);
      validateVirtualization(clean);
      normalizeEndpointPath(clean.response.path);
      selected.push({ ...file, template: clean });
    } catch (error) {
      // Do not expose JSON parser excerpts: they can contain secrets from the input.
      const reason = error instanceof SyntaxError ? 'Invalid JSON syntax' : error instanceof Error ? error.message : 'Unable to validate file';
      errors.push(`${file.application}/${file.flow}/${file.fileName}: ${reason}`);
    }
  }
  if (errors.length) throw new Error(sanitizeSensitiveData(`Publication cancelled; invalid files:\n${errors.map((error) => `- ${error}`).join('\n')}`));
  return selected;
}

export async function savePublications(files: SelectedVirtualization[], result: PublicationResult, publishedAt = new Date().toISOString()): Promise<string[]> {
  const groups = new Map<string, SelectedVirtualization[]>();
  for (const file of files) groups.set(file.flowDirectory, [...groups.get(file.flowDirectory) ?? [], file]);
  const saved: string[] = [];
  for (const [directory, group] of groups) {
    const publication: Publication = {
      application: group[0].application, flow: group[0].flow, publishedAt, baseUrl: result.baseUrl,
      services: result.services.filter((service) => group.some((file) => file.template.response.metodo === service.method && normalizeEndpointPath(file.template.response.path) === service.path)),
    };
    const path = join(directory, 'publication.json');
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('publication.json cannot be a symbolic link'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await writeFile(path, JSON.stringify(sanitizeValue(publication), null, 2) + '\n');
    saved.push(path);
  }
  return saved;
}
