import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseJavaSource } from './java-parser.js';
import { JavaParseError } from './java-parse-error.js';
import type { RepositoryAnalysis, JavaType, SkippedJavaFile } from './types.js';

const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);
export async function analyzeRepository(repositoryPath: string): Promise<RepositoryAnalysis> {
  const root = resolve(repositoryPath);
  if (!(await stat(root)).isDirectory()) throw new Error(`Repository path is not a directory: ${root}`);
  const javaTypes: JavaType[] = [];
  const skippedJavaFiles: SkippedJavaFile[] = [];
  let javaFilesAnalyzed = 0;
  const result: RepositoryAnalysis = { repositoryPath: root, controllers: [], services: [], feignClients: [], configurationFiles: [], javaTypes, skippedJavaFiles, javaFilesAnalyzed, incomplete: false };
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(absolutePath);
      else if (entry.isFile()) {
        const filePath = relative(root, absolutePath).split('\\').join('/');
        if (entry.name.endsWith('.java')) {
          const source = await readFile(absolutePath, 'utf8');
          try {
            const parsed = parseJavaSource(source, filePath);
            result.controllers.push(...parsed.controllers);
            result.services.push(...parsed.services);
            result.feignClients.push(...parsed.feignClients);
            javaTypes.push(...parsed.javaTypes);
            javaFilesAnalyzed++;
          } catch (error) {
            skippedJavaFiles.push({ filePath, reason: error instanceof Error ? error.message : 'Java parsing failed', declaredTypes: error instanceof JavaParseError ? error.declaredTypes : [] });
          }
        } else if (/^application(?:-[\w.-]+)?\.(properties|ya?ml)$/.test(entry.name)) {
          result.configurationFiles.push({ filePath, format: entry.name.endsWith('.properties') ? 'properties' : 'yaml', content: await readFile(absolutePath, 'utf8') });
        }
      }
    }
  }
  await visit(root);
  result.javaFilesAnalyzed = javaFilesAnalyzed;
  result.incomplete = skippedJavaFiles.length > 0;
  return result;
}
