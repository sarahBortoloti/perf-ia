import { basename } from 'node:path';
import type { RepositoryAnalysis, JavaType, SkippedJavaFile } from './types.js';
import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';

interface Entrypoint { method: string; path: string }
export interface EndpointAnalysisStatus {
  incomplete: boolean;
  relevantSkippedFiles: SkippedJavaFile[];
  uncertain: boolean;
}

export function formatRepositoryDiagnostics(repository: RepositoryAnalysis): string {
  const skipped = repository.skippedJavaFiles ?? [];
  return sanitizeSensitiveData([
    'Repository analyzed',
    `✓ ${repository.javaFilesAnalyzed ?? 0} Java files analyzed`,
    `${skipped.length ? '⚠' : '✓'} ${skipped.length} Java files skipped`,
    ...(skipped.length ? ['', 'Skipped files:', ...skipped.map((file) => `- ${file.filePath} — ${file.reason}`)] : []),
  ].join('\n'));
}

/** Check the selected method's explicit dependencies without changing flow artifacts. */
export function getEndpointAnalysisStatus(repository: RepositoryAnalysis, entrypoint: Entrypoint): EndpointAnalysisStatus {
  const skipped = repository.skippedJavaFiles ?? [];
  const relevant = new Set<SkippedJavaFile>();
  const visited = new Set<string>();
  const types = repository.javaTypes ?? [];
  let uncertain = false;
  function resolveType(reference: string): JavaType | undefined {
    const names = reference.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [];
    for (const name of names) {
      const simple = name.split('.').at(-1);
      for (const file of skipped) {
        const declared = file.declaredTypes.length ? file.declaredTypes : [basename(file.filePath, '.java')];
        if (simple && declared.includes(simple)) relevant.add(file);
      }
    }
    const candidates = types.filter((type) => type.name === reference || `${type.packageName}.${type.name}` === reference);
    if (candidates.length > 1) uncertain = true;
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  function walk(type: JavaType, methodName: string): void {
    const key = `${type.filePath}:${type.name}:${methodName}`;
    if (visited.has(key)) return;
    visited.add(key);
    const methods = type.methods.filter((method) => method.name === methodName);
    if (methods.length !== 1) { uncertain = true; return; }
    resolveType(methods[0].returnType);
    for (const parameter of methods[0].parameterTypes ?? []) resolveType(parameter);
    for (const invocation of methods[0].invocations) {
      const reference = invocation.receiver && invocation.receiver !== 'this' ? type.fields[invocation.receiver] : type.name;
      if (!reference) { uncertain = true; continue; }
      const target = resolveType(reference);
      if (target) walk(target, invocation.method);
    }
  }
  let selected = false;
  for (const controller of repository.controllers) {
    for (const endpoint of controller.endpoints) {
      if (endpoint.httpMethod !== entrypoint.method || endpoint.path !== entrypoint.path) continue;
      selected = true;
      const type = types.find((candidate) => candidate.name === controller.name && candidate.filePath === controller.filePath);
      if (type) walk(type, endpoint.methodName);
      else uncertain = true;
    }
  }
  if (!selected) uncertain = true;
  // Unknown declarations cannot establish that a skipped file is unrelated.
  if (skipped.some((file) => !file.declaredTypes.length)) uncertain = true;
  return { incomplete: relevant.size > 0 || (skipped.length > 0 && uncertain), relevantSkippedFiles: [...relevant], uncertain: skipped.length > 0 && uncertain };
}

export function formatEndpointWarning(repository: RepositoryAnalysis, entrypoint: Entrypoint): string | undefined {
  const status = getEndpointAnalysisStatus(repository, entrypoint);
  if (!status.incomplete) return undefined;
  const files = status.relevantSkippedFiles.length ? status.relevantSkippedFiles : repository.skippedJavaFiles ?? [];
  return sanitizeSensitiveData([
    `⚠ Repository analysis incomplete for endpoint ${entrypoint.method} ${entrypoint.path}.`,
    status.relevantSkippedFiles.length ? 'Skipped files referenced by this endpoint:' : 'Cannot rule out dependencies on skipped files:',
    ...files.map((file) => `- ${file.filePath} — ${file.reason}`),
  ].join('\n'));
}
