import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, basename } from 'node:path';
import { parseAllDocuments, isMap, isSeq, isScalar } from 'yaml';
import type { ConfigurationEntry, ConfigurationScan } from './models.js';

export function isSensitiveProperty(property: string): boolean {
  return /password|passwd|pwd|senha|token|secret|certificate|certificat|certificado|private[-_. ]?key|api[-_. ]?key|authorization|cookie|signature|credential|keystore|truststore|\.pem$|\.p12$/i.test(property);
}
export function isProduction(environment: string): boolean {
  return /(?:^|[^a-z])(?:prod(?:uction)?|produ[cç][aã]o|prd|live)(?:$|[^a-z])/i.test(environment);
}
export function normalizeEnvironment(environment: string): string { return environment.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function inferEnvironment(file: string, path: string[] = []): string | undefined {
  const candidates = [...file.split(/[\\/._-]/), ...path];
  return candidates.find((part) => /^(dev|t1|hom|sandbox|prod|production|producao|produção|prd|live)$/i.test(part))
    ?? /^(?:application|bootstrap|values)[.-](.+)\.(?:properties|ya?ml)$/i.exec(basename(file))?.[1]
    ?? /^\.env[.-](.+)$/i.exec(basename(file))?.[1];
}
const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea', 'output']);

export async function readConfigurations(repositoryPath: string): Promise<ConfigurationScan> {
  const scan: ConfigurationScan = { root: resolve(repositoryPath), entries: [], contents: new Map(), warnings: [] };
  function add(entry: ConfigurationEntry): void {
    if (!isSensitiveProperty(entry.property) && !isSensitiveProperty(entry.file)) scan.entries.push(entry);
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) { await visit(absolute); continue; }
      if (!entry.isFile() || !(/\.(?:properties|ya?ml)$/i.test(entry.name) || /^\.env(?:[.-].+)?$/i.test(entry.name) || /(?:config|settings).*\.json$/i.test(entry.name) || /\.env$/i.test(entry.name))) continue;
      if (/\.(?:example|sample|template)$/i.test(entry.name)) continue;
      const file = relative(scan.root, absolute);
      if (isSensitiveProperty(file)) continue;
      const source = await readFile(absolute, 'utf8'); scan.contents.set(file, source);
      const format = /\.properties$/i.test(entry.name) ? 'properties' : /^\.env|\.env$/i.test(entry.name) ? 'env' : /\.json$/i.test(entry.name) ? 'json' : 'yaml';
      if (format === 'properties' || format === 'env') {
        let offset = 0;
        for (const line of source.split(/(?<=\n)/)) {
          const match = /^(\s*(?:export\s+)?([\w.-]+)\s*[:=]\s*)([^\r\n]*)(?:\r?\n)?$/.exec(line);
          if (match && !/^\s*[#!]/.test(line)) {
            const raw = match[3];
            if (/\\\s*$/.test(raw)) { scan.warnings.push(`${file}: propriedade multilinha não alterada automaticamente.`); offset += line.length; continue; }
            const quoted = /^("(?:\\.|[^"\\])*"|'[^']*')/.exec(raw)?.[0];
            const literal = quoted ?? raw.replace(format === 'env' ? /\s+#.*$/ : /\s+$/, '');
            const value = quoted ? literal.slice(1, -1) : literal;
            add({ file, property: match[2], value, start: offset + match[1].length, end: offset + match[1].length + literal.length, literal, format, document: 0, environment: inferEnvironment(file), deployment: format === 'env' });
          }
          offset += line.length;
        }
        continue;
      }
      const documents = parseAllDocuments(source, { uniqueKeys: true });
      for (const [documentIndex, document] of documents.entries()) {
        if (document.errors.length) { scan.warnings.push(`${file}: YAML/JSON inválido; nenhuma propriedade desse documento será alterada.`); continue; }
        const activation = document.getIn(['spring', 'config', 'activate', 'on-profile']) ?? document.getIn(['spring', 'profiles']);
        const documentEnvironment = typeof activation === 'string' ? activation : undefined;
        function walk(node: unknown, path: string[]): void {
          if (isMap(node)) {
            const name = node.get('name'); const value = node.get('value', true);
            if (typeof name === 'string' && isScalar(value) && typeof value.value === 'string' && value.range) {
              const [start, end] = value.range;
              add({ file, property: [...path, name].join('.'), value: value.value, start, end, literal: source.slice(start, end), format, document: documentIndex,
                environment: documentEnvironment ?? inferEnvironment(file, path), deployment: true });
              return;
            }
            for (const item of node.items) if (isScalar(item.key) && typeof item.key.value === 'string') walk(item.value, [...path, item.key.value]);
          } else if (isSeq(node)) node.items.forEach((item, index) => walk(item, [...path, String(index)]));
          else if (isScalar(node) && typeof node.value === 'string' && node.range) {
            const [start, end] = node.range;
            add({ file, property: path.join('.'), value: node.value, start, end, literal: source.slice(start, end), format, document: documentIndex,
              environment: documentEnvironment ?? inferEnvironment(file, path), deployment: /values|configmap/i.test(basename(file)) || path.includes('env') || path.includes('data') });
          }
        }
        walk(document.contents, []);
      }
    }
  }
  await visit(scan.root);
  return scan;
}
