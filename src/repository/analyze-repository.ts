import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseJavaSource } from './java-parser.js';
import type { RepositoryAnalysis } from './types.js';

const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);
export async function analyzeRepository(repositoryPath: string): Promise<RepositoryAnalysis> {
  const root = resolve(repositoryPath);
  if (!(await stat(root)).isDirectory()) throw new Error(`Repository path is not a directory: ${root}`);
  const result: RepositoryAnalysis = { repositoryPath: root, controllers: [], services: [], feignClients: [], configurationFiles: [] };
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(absolutePath);
      else if (entry.isFile()) {
        const filePath = relative(root, absolutePath).split('\\').join('/');
        if (entry.name.endsWith('.java')) {
          const parsed = parseJavaSource(await readFile(absolutePath, 'utf8'), filePath);
          result.controllers.push(...parsed.controllers);
          result.services.push(...parsed.services);
          result.feignClients.push(...parsed.feignClients);
        } else if (/^application(?:-[\w.-]+)?\.(properties|ya?ml)$/.test(entry.name)) {
          result.configurationFiles.push({ filePath, format: entry.name.endsWith('.properties') ? 'properties' : 'yaml', content: await readFile(absolutePath, 'utf8') });
        }
      }
    }
  }
  await visit(root);
  return result;
}
