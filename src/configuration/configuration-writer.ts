import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { sanitizeValue, sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';
import { isProduction, isSensitiveProperty, readConfigurations } from './configuration-reader.js';
import type { ConfigurationScan, ConfigurationProposal, ConfigurationChange, ConfigurationContext } from './models.js';

function literal(proposal: ConfigurationProposal): string {
  const { entry, change } = proposal;
  if (entry.format === 'json' || entry.literal.startsWith('"')) return JSON.stringify(change.newValue);
  if (entry.literal.startsWith("'")) return `'${change.newValue.replace(/'/g, "''")}'`;
  if (entry.format === 'yaml' && /[:#{}[\],&*!|>]/.test(change.newValue)) return JSON.stringify(change.newValue);
  return change.newValue;
}
async function safePath(root: string, file: string): Promise<string> {
  const path = resolve(root, file);
  const local = relative(root, path);
  if (local === '..' || local.startsWith(`..${sep}`) || local === '' || local.startsWith(sep)) throw new Error('Arquivo fora do repositório selecionado.');
  let current = root;
  if ((await lstat(current)).isSymbolicLink()) throw new Error('Repositório simbólico não será alterado.');
  for (const segment of local.split(sep)) { current = join(current, segment); if ((await lstat(current)).isSymbolicLink()) throw new Error('Links simbólicos não serão alterados.'); }
  return path;
}
export async function applyConfiguration(scan: ConfigurationScan, proposals: ConfigurationProposal[], beforeWrite?: (changes: ConfigurationChange[]) => Promise<void>): Promise<number> {
  const grouped = new Map<string, ConfigurationProposal[]>();
  for (const proposal of proposals) {
    if (isProduction(proposal.change.environment) || isProduction(proposal.entry.environment ?? '') || isProduction(proposal.entry.file) || isSensitiveProperty(proposal.entry.property)) throw new Error('Configuração de produção/sensível bloqueada.');
    if (sanitizeSensitiveData(proposal.change.previousValue) !== proposal.change.previousValue || sanitizeSensitiveData(proposal.change.newValue) !== proposal.change.newValue) throw new Error('Valores sensíveis não serão alterados nem armazenados.');
    grouped.set(proposal.entry.file, [...grouped.get(proposal.entry.file) ?? [], proposal]);
  }
  const pending: { path: string; original: string; content: string; proposals: ConfigurationProposal[] }[] = [];
  for (const [file, changes] of grouped) {
    const original = scan.contents.get(file);
    if (original === undefined) throw new Error('Arquivo não analisado.');
    const path = await safePath(scan.root, file);
    if (await readFile(path, 'utf8') !== original) throw new Error('Arquivo alterado depois do preview; execute novamente.');
    const unique = [...new Map(changes.map((proposal) => [`${proposal.entry.start}:${proposal.entry.end}`, proposal])).values()].sort((a, b) => b.entry.start - a.entry.start);
    let content = original;
    for (const proposal of unique) {
      if (original.slice(proposal.entry.start, proposal.entry.end) !== proposal.entry.literal) throw new Error('Posição de configuração inconsistente.');
      content = content.slice(0, proposal.entry.start) + literal(proposal) + content.slice(proposal.entry.end);
    }
    pending.push({ path, original, content, proposals: changes });
  }
  // Save logical rollback values before touching configuration files.
  await beforeWrite?.(proposals.map((proposal) => proposal.change));
  for (const file of pending) {
    if (await readFile(file.path, 'utf8') !== file.original) throw new Error('Arquivo alterado depois do preview; execute novamente.');
    await writeFile(file.path, file.content);
    for (const proposal of file.proposals) proposal.change.applied = true;
  }
  return pending.length;
}

/** Logical rollback: restore only an applied property still containing its new value. */
export async function rollbackConfiguration(root: string, changes: ConfigurationChange[]): Promise<number> {
  const scan = await readConfigurations(root);
  const proposals: ConfigurationProposal[] = [];
  for (const change of changes.filter((change) => change.applied)) {
    const matches = scan.entries.filter((entry) => entry.file === change.file && entry.property === change.property && entry.document === change.document && entry.value === change.newValue);
    if (matches.length !== 1) throw new Error('Rollback bloqueado: configuração não corresponde ao valor aplicado.');
    proposals.push({ entry: matches[0], change: { ...change, previousValue: change.newValue, newValue: change.previousValue, applied: false } });
  }
  return applyConfiguration(scan, proposals);
}

export async function saveConfigurationMetadata(context: ConfigurationContext, applicationRepository: string, configurationRepository: string, environment: string, changes: ConfigurationChange[], warnings: string[], dryRun: boolean): Promise<string> {
  const path = join(context.flowDirectory, 'configuration.json');
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('configuration.json não pode ser um link simbólico.'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const metadata = { application: context.application, flow: context.flow, applicationRepository, configurationRepository, environment,
    configuredAt: new Date().toISOString(), dryRun, changes, warnings };
  await writeFile(path, JSON.stringify(sanitizeValue(metadata), null, 2) + '\n');
  return path;
}
