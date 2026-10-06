import type { RepositoryAnalysis, FeignClient, Endpoint } from '../repository/types.js';
import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';
import { isProduction, isSensitiveProperty, normalizeEnvironment } from './configuration-reader.js';
import type { ConfigurationContext, ConfigurationScan, ConfigurationPlan, ConfigurationEntry, ConfigurationProposal, FlowIntegration, PublishedIntegration } from './models.js';

export function isSafeConfigurationUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && sanitizeSensitiveData(value) === value; } catch { return false; }
}
function canonical(key: string): string { return key.replace(/[._-]/g, '').toLowerCase(); }
function matchesKey(entry: ConfigurationEntry, key: string): boolean {
  return canonical(entry.property) === canonical(key) || canonical(entry.property.split('.').at(-1) ?? '') === canonical(key);
}
function environmentOf(entry: ConfigurationEntry, selected: string): string | undefined {
  if (entry.environment) return normalizeEnvironment(entry.environment);
  const tokens = [...entry.file.split(/[\\/._-]/), ...entry.property.split('.')].map(normalizeEnvironment);
  return tokens.includes(selected) ? selected : undefined;
}
function proposedBase(service: PublishedIntegration, endpoint: Endpoint): string | undefined {
  const url = new URL(service.url);
  const suffix = endpoint.path.split('/').filter(Boolean);
  const parts = url.pathname.split('/').filter(Boolean);
  if (suffix.length > parts.length) return undefined;
  const tail = parts.slice(-suffix.length);
  if (!suffix.every((part, index) => /^\{[^}]+\}$/.test(part) || part === tail[index])) return undefined;
  const prefix = parts.slice(0, parts.length - suffix.length);
  return url.origin + (prefix.length ? '/' + prefix.join('/') : '');
}
interface Located { entry: ConfigurationEntry; root: string }

export function planConfiguration(context: ConfigurationContext, repository: RepositoryAnalysis, scans: ConfigurationScan[], targetRoot: string, environment: string): ConfigurationPlan {
  const plan: ConfigurationPlan = { proposals: [], warnings: scans.flatMap((scan) => scan.warnings) };
  if (isProduction(environment)) { plan.warnings.push('PRODUÇÃO: alterações automáticas bloqueadas.'); return plan; }
  const selected = normalizeEnvironment(environment);
  const all = scans.flatMap((scan) => scan.entries.map((entry) => ({ entry, root: scan.root })));
  function lookup(key: string): Located | undefined {
    if (isSensitiveProperty(key)) throw new Error('Propriedade sensível bloqueada.');
    const candidates = all.filter(({ entry }) => matchesKey(entry, key) && !isProduction(entry.environment ?? '') && !isProduction(entry.file) && (!environmentOf(entry, selected) || environmentOf(entry, selected) === selected));
    const rank = ({ entry, root }: Located): number => (environmentOf(entry, selected) ? 100 : 0) + (root === targetRoot ? 40 : 0) + (entry.deployment ? 20 : 0);
    const max = Math.max(...candidates.map(rank));
    const best = candidates.filter((candidate) => rank(candidate) === max);
    if (best.length > 1) throw new Error(`Configuração ambígua para ${key}: ${best.map(({ entry }) => `${entry.file} (${entry.property})`).join(', ')}`);
    return best[0];
  }
  function resolve(expression: string, desired: string, chain: string[], visited: Set<string>, owner?: Located): { leaf: Located; newValue: string; chain: string[]; defaultFallback?: boolean } {
    const reference = /^(.*?)\$\{([^:{}]+)(?::([^{}]*))?\}(.*?)$/.exec(expression);
    if (reference) {
      const [, prefix, variable, fallback, suffix] = reference;
      if (prefix.includes('${') || suffix.includes('${') || !desired.startsWith(prefix) || !desired.endsWith(suffix)) throw new Error('Expressão de configuração composta não resolvida com segurança.');
      const nextDesired = desired.slice(prefix.length, suffix ? -suffix.length : undefined);
      if (isSensitiveProperty(variable)) throw new Error('Variável sensível bloqueada.');
      if (visited.has(variable)) throw new Error('Ciclo na cadeia de configuração.');
      const nextVisited = new Set(visited).add(variable);
      const next = lookup(variable);
      if (next) return resolve(next.entry.value, nextDesired, [...chain, `${next.entry.file} → ${next.entry.property}`], nextVisited, next);
      if (fallback !== undefined && owner && isSafeConfigurationUrl(fallback) && isSafeConfigurationUrl(nextDesired)) {
        return { leaf: owner, newValue: `${prefix}\u0024{${variable}:${nextDesired}}${suffix}`, chain: [...chain, `${variable}: default (pode ser sobrescrito fora do repositório)`], defaultFallback: true };
      }
      throw new Error(`Configuração não encontrada para ${variable}; variável externa não será presumida.`);
    }
    if (!owner || !isSafeConfigurationUrl(expression) || !isSafeConfigurationUrl(desired)) throw new Error('Configuração não encontrada ou URL contém dados sensíveis/não suportados.');
    return { leaf: owner, newValue: desired, chain };
  }
  function clientFor(call: FlowIntegration): FeignClient | undefined {
    const clients = repository.feignClients.filter((client) => (call.codePath && client.filePath === call.codePath.replace(/\\/g, '/')) || (call.client !== undefined && (client.name === call.client || client.clientName === call.client)));
    return clients.length === 1 ? clients[0] : undefined;
  }
  for (const service of context.services) {
    const calls = context.externalCalls.filter((call) => call.method === service.method && call.path === service.path);
    if (!calls.length) { plan.warnings.push(`${service.method} ${service.path}: integração não encontrada no FlowContext.`); continue; }
    const call = calls[0];
    const identities = new Set(calls.map((item) => `${item.client ?? ''}:${item.codePath ?? ''}:${item.configurationProperty ?? ''}`));
    if (identities.size !== 1) { plan.warnings.push(`${service.method} ${service.path}: correlação de integração ambígua.`); continue; }
    const client = clientFor(call);
    const integration = client?.name ?? call.client ?? `${service.method} ${service.path}`;
    try {
      let expression: string;
      let desired: string;
      const chain = [integration];
      if (client) {
        const endpoints = client.endpoints.filter((endpoint) => (!call.clientMethod || endpoint.methodName === call.clientMethod) && endpoint.httpMethod === service.method);
        const bases = endpoints.map((endpoint) => proposedBase(service, endpoint)).filter((value) => value !== undefined);
        if (new Set(bases).size !== 1) throw new Error('Path publicado não permite correlacionar a base do FeignClient com segurança.');
        desired = bases[0];
        expression = call.configurationProperty ? `\u0024{${call.configurationProperty}}` : client.url ?? '';
        if (!expression.includes('${')) throw new Error('FeignClient usa URL literal; código Java não será alterado automaticamente.');
      } else if (call.configurationProperty) {
        expression = `\u0024{${call.configurationProperty}}`; desired = service.url;
      } else {
        const exact = all.filter(({ entry }) => entry.value === call.url && !isSensitiveProperty(entry.property));
        if (exact.length !== 1) throw new Error('Configuração não encontrada ou ambígua: sem vínculo estático, exige URL runtime exatamente igual a uma propriedade.');
        expression = `\u0024{${exact[0].entry.property}}`; desired = service.url;
      }
      const resolved = resolve(expression, desired, chain, new Set());
      if (resolved.leaf.root !== targetRoot) throw new Error('Ponto efetivo localizado em outro repositório; selecione esse repositório para alterar.');
      if (resolved.leaf.entry.value === resolved.newValue) { plan.warnings.push(`${integration}: configuração já aponta para a virtualização.`); continue; }
      const proposal: ConfigurationProposal = { entry: resolved.leaf.entry, change: {
        integration, file: resolved.leaf.entry.file, property: resolved.leaf.entry.property, environment,
        previousValue: resolved.leaf.entry.value, newValue: resolved.newValue, applied: false,
        document: resolved.leaf.entry.document, chain: resolved.chain, defaultFallback: resolved.defaultFallback,
      } };
      plan.proposals.push(proposal);
    } catch (error) { plan.warnings.push(`${integration}: ${error instanceof Error ? error.message : 'Configuração não resolvida.'}`); }
  }
  const conflicting = new Set<string>();
  const grouped = new Map<string, ConfigurationProposal[]>();
  for (const proposal of plan.proposals) {
    const key = `${proposal.entry.file}:${proposal.entry.document}:${proposal.entry.property}`;
    grouped.set(key, [...grouped.get(key) ?? [], proposal]);
  }
  for (const [key, proposals] of grouped) {
    if (new Set(proposals.map((proposal) => proposal.change.newValue)).size > 1) { conflicting.add(key); plan.warnings.push(`Configuração ambígua: integrações exigem valores diferentes para ${key}.`); }
  }
  plan.proposals = plan.proposals.filter((proposal) => !conflicting.has(`${proposal.entry.file}:${proposal.entry.document}:${proposal.entry.property}`));
  plan.warnings = plan.warnings.map(sanitizeSensitiveData);
  return plan;
}
