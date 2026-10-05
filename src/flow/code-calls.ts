import type { RepositoryAnalysis, JavaType } from '../repository/types.js';
import type { Entrypoint } from './models.js';
import type { ExternalCall } from './external-call.js';

export function pathMatches(template: string, path: string): boolean {
  const expression = template.split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${expression}/?$`).test(path.split('?')[0]);
}

/** Follow explicit controller -> service -> Feign invocations; ambiguous types are skipped. */
export function findCodeCalls(repository: RepositoryAnalysis, entrypoint: Entrypoint): ExternalCall[] {
  const calls: ExternalCall[] = [];
  const types = repository.javaTypes ?? [];
  const active = new Set<string>();
  function walk(type: JavaType, methodName: string): void {
    const key = `${type.filePath}:${type.name}:${methodName}`;
    if (active.has(key)) return;
    const methods = type.methods.filter((method) => method.name === methodName);
    if (methods.length !== 1) return;
    active.add(key);
    for (const invocation of methods[0].invocations) {
      const dependency = invocation.receiver && invocation.receiver !== 'this' ? type.fields[invocation.receiver] : type.name;
      if (!dependency) continue;
      const candidates = types.filter((candidate) => candidate.name === dependency || `${candidate.packageName}.${candidate.name}` === dependency);
      if (candidates.length !== 1) continue;
      const target = candidates[0];
      const client = repository.feignClients.find((f) => f.filePath === target.filePath && f.name === target.name);
      if (client) {
        for (const endpoint of client.endpoints.filter((e) => e.methodName === invocation.method)) {
          const url = client.url && /^https?:\/\//.test(client.url) ? client.url.replace(/\/$/, '') + endpoint.path : undefined;
          calls.push({ order: calls.length + 1, client: client.clientName ?? client.name, clientMethod: invocation.method, method: endpoint.httpMethod, path: endpoint.path, url, codeUrl: url,
            source: 'CODE', body: {}, bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED', codePath: target.filePath,
            returnType: target.methods.find((m) => m.name === invocation.method)?.returnType });
        }
      } else walk(target, invocation.method);
    }
    active.delete(key);
  }
  for (const controller of repository.controllers) {
    const type = types.find((t) => t.filePath === controller.filePath && t.name === controller.name);
    if (!type) continue;
    for (const endpoint of controller.endpoints) {
      if (endpoint.httpMethod === entrypoint.method && endpoint.path === entrypoint.path) walk(type, endpoint.methodName);
    }
  }
  return calls;
}
