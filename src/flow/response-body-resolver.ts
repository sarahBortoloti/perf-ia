import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import type { RepositoryAnalysis } from '../repository/types.js';
import type { ExternalCall } from './external-call.js';
import type { BodyEvidence } from './models.js';
import { pathMatches } from './code-calls.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
function firstDefined(...values: unknown[]): unknown { return values.find((value) => value !== undefined); }
function dereference(value: unknown, document: ObjectValue): ObjectValue {
  let result = object(value);
  const seen = new Set<string>();
  while (typeof result.$ref === 'string' && result.$ref.startsWith('#/') && !seen.has(result.$ref)) {
    seen.add(result.$ref);
    let resolved: unknown = document;
    for (const segment of result.$ref.slice(2).split('/')) resolved = object(resolved)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    result = object(resolved);
  }
  return result;
}
const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);

export class ResponseBodyResolver {
  private documents: { path: string; data: ObjectValue }[] = [];
  constructor(private readonly repository: RepositoryAnalysis) {}

  async load(): Promise<void> {
    this.documents = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !ignored.has(entry.name)) await visit(path);
        else if (entry.isFile() && /\.(json|ya?ml)$/i.test(entry.name)) {
          const local = relative(this.repository.repositoryPath, path);
          if (/^(?:package(?:-lock)?|tsconfig)\.json$/i.test(entry.name) || /^application(?:-.*)?\.ya?ml$/i.test(entry.name)) continue;
          const text = await readFile(path, 'utf8');
          try {
            this.documents.push({ path: local, data: object(entry.name.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) });
          } catch { /* Invalid artifacts are not evidence. */ }
        }
      }
    };
    await visit(this.repository.repositoryPath);
  }

  resolve(call: ExternalCall): BodyEvidence {
    if (call.responseBody !== undefined) return { body: sanitizeValue(call.responseBody), bodySource: 'LOG', confidence: 'HIGH' };
    for (const document of this.documents) {
      if (!document.data.openapi && !document.data.swagger) continue;
      for (const [path, operations] of Object.entries(object(document.data.paths))) {
        const serverPath = typeof document.data.basePath === 'string' ? document.data.basePath
          : (() => { try { return new URL(String(object((document.data.servers as unknown[] | undefined)?.[0]).url)).pathname.replace(/\/$/, ''); } catch { return ''; } })();
        if (!call.path || (!pathMatches(path, call.path) && !pathMatches(serverPath + path, call.path))) continue;
        const operation = dereference(dereference(operations, document.data)[call.method?.toLowerCase() ?? ''], document.data);
        const responses = object(operation.responses);
        const status = call.status !== undefined ? String(call.status) : Object.keys(responses).find((key) => /^2\d\d$/.test(key));
        const response = dereference(responses[status ?? ''], document.data);
        const content = object(object(response.content)['application/json']);
        const example = firstDefined(content.example, Object.values(object(content.examples)).map((item) => dereference(item, document.data).value).find((item) => item !== undefined),
          dereference(content.schema, document.data).example, object(response.examples)['application/json']);
        if (example !== undefined) return { body: sanitizeValue(example), bodySource: 'OPENAPI', confidence: call.status === undefined ? 'MEDIUM' : 'HIGH', evidence: document.path };
      }
    }
    for (const document of this.documents) {
      if (document.data.openapi || document.data.swagger) continue;
      const request = object(document.data.request);
      const response = object(document.data.response);
      const method = request.method ?? document.data.method ?? response.metodo;
      const path = request.urlPath ?? request.url ?? document.data.path ?? response.path;
      if (method !== call.method || typeof path !== 'string' || !call.path || !pathMatches(path, call.path)) continue;
      const status = response.status ?? document.data.status;
      if (call.status !== undefined && status !== undefined && status !== call.status) continue;
      let body = firstDefined(response.jsonBody, response.body, document.data.responseBody);
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* A literal text response is evidence too. */ } }
      if (body !== undefined) return { body: sanitizeValue(body), bodySource: 'EXISTING_MOCK', confidence: status === call.status && status !== undefined ? 'HIGH' : 'MEDIUM', evidence: document.path };
    }
    // DTOs describe fields, never business values: unknown scalar values become null.
    const typeName = call.returnType?.replace(/^(?:ResponseEntity|Optional)<(.+)>$/, '$1');
    const candidates = (this.repository.javaTypes ?? []).filter((type) => type.name === typeName || `${type.packageName}.${type.name}` === typeName);
    if (candidates.length === 1 && Object.keys(candidates[0].fields).length) {
      return { body: sanitizeValue(Object.fromEntries(Object.keys(candidates[0].fields).map((field) => [field, null]))), bodySource: 'DTO', confidence: 'REVIEW_REQUIRED', evidence: candidates[0].filePath };
    }
    return { body: {}, bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' };
  }
}
