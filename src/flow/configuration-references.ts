import { parse } from 'yaml';
import type { RepositoryAnalysis } from '../repository/types.js';

export function configurationReferences(repository: RepositoryAnalysis): (expression: string) => string | undefined {
  const entries = new Map<string, Set<string>>();
  const add = (key: string, value: string): void => { entries.set(key, new Set([...(entries.get(key) ?? []), value])); };
  function flatten(value: unknown, path: string[] = []): void {
    if (typeof value === 'string') add(path.join('.'), value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) flatten(child, [...path, key]);
  }
  for (const file of repository.configurationFiles) {
    if (file.format === 'properties') {
      for (const line of file.content.split(/\r?\n/)) {
        const match = /^\s*([\w.-]+)\s*[:=]\s*(.*?)\s*$/.exec(line);
        if (match) add(match[1], match[2]);
      }
    } else { try { flatten(parse(file.content)); } catch { /* Invalid or multi-profile YAML is not unique static evidence. */ } }
  }
  return (expression: string): string | undefined => {
    const visited = new Set<string>();
    let value = expression;
    for (let step = 0; step < 20 && value.includes('${'); step++) {
      let failed = false;
      value = value.replace(/\$\{([^:{}]+)(?::([^{}]*))?\}/g, (_match, key: string, fallback: string | undefined) => {
        const values = entries.get(key);
        if (visited.has(key) || values && values.size !== 1 || !values && fallback === undefined) { failed = true; return ''; }
        visited.add(key);
        return values ? [...values][0] : fallback ?? '';
      });
      if (failed) return undefined;
    }
    return value.includes('${') ? undefined : value;
  };
}
