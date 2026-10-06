import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, it, expect } from 'vitest';
import { analyzeRepository } from '../src/repository/index.js';
import { readConfigurations } from '../src/configuration/configuration-reader.js';
import { planConfiguration } from '../src/configuration/configuration-planner.js';
import { applyConfiguration, rollbackConfiguration, saveConfigurationMetadata } from '../src/configuration/configuration-writer.js';
import { discoverPublications, readConfigurationContext } from '../src/configuration/configuration-context.js';
import { relevantGitDiff } from '../src/configuration/git-diff.js';
import type { ConfigurationContext } from '../src/configuration/models.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const execute = promisify(execFile);
async function fixture(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'perf-ai-configuration-')); temporary.push(root);
  const merged = { 'ProposalClient.java': '@FeignClient(name="proposal", url="${proposal.url}") interface ProposalClient { @PostMapping("/proposal") String create(); }', ...files };
  for (const [file, content] of Object.entries(merged)) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), content); }
  return root;
}
function context(directory: string): ConfigurationContext {
  return { application: 'demo', flow: 'flow', publicationPath: join(directory, 'publication.json'), flowDirectory: directory,
    services: [{ method: 'POST', path: '/proposal', url: 'http://virtual.example.test/proposal' }],
    externalCalls: [{ client: 'proposal', clientMethod: 'create', method: 'POST', path: '/proposal', url: 'https://old.example.test/proposal', codePath: 'ProposalClient.java' }] };
}
async function plan(root: string, environment = 'HOM', other?: string) {
  const app = await readConfigurations(root); const target = other ? await readConfigurations(other) : app;
  return { plan: planConfiguration(context(root), await analyzeRepository(root), other ? [app, target] : [target], target.root, environment), scan: target };
}

describe('configuration reader and planner', () => {
  it.each([
    ['application.properties', 'proposal.url=https://old.example.test\r\npassword=fictional-secret\r\n'],
    ['application.yml', 'proposal:\n  url: "https://old.example.test" # keep comment\npassword: fictional-secret\n'],
    ['application.yaml', 'proposal:\n  url: https://old.example.test\n'],
    ['bootstrap.properties', 'proposal.url=https://old.example.test\n'],
    ['bootstrap.yml', 'proposal:\n  url: https://old.example.test\n'],
    ['bootstrap.yaml', 'proposal:\n  url: https://old.example.test\n'],
  ])('plans only the explicitly linked URL in %s', async (file, content) => {
    const root = await fixture({ [file]: content, 'unrelated.properties': 'other.url=https://unrelated.example.test\n' });
    const { plan: result, scan } = await plan(root);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].change).toMatchObject({ integration: 'ProposalClient', property: 'proposal.url', previousValue: 'https://old.example.test', newValue: 'http://virtual.example.test', environment: 'HOM', applied: false });
    expect(scan.entries.some((entry) => entry.property === 'password')).toBe(false);
    expect(await applyConfiguration(scan, result.proposals)).toBe(1);
    const changed = await readFile(join(root, file), 'utf8');
    expect(changed).toContain('http://virtual.example.test');
    if (content.includes('fictional-secret')) expect(changed).toContain('fictional-secret');
    if (content.includes('# keep comment')) expect(changed).toContain('# keep comment');
    if (content.includes('\r\n')) expect(changed).toContain('\r\n');
    expect(await readFile(join(root, 'unrelated.properties'), 'utf8')).toBe('other.url=https://unrelated.example.test\n');
  });

  it.each([
    ['hom/values.yaml', 'env:\n  API_PROPOSAL_URL: https://old.example.test\n'],
    ['values-hom.yml', 'env:\n  - name: API_PROPOSAL_URL\n    value: https://old.example.test\n'],
    ['.env.hom', 'API_PROPOSAL_URL="https://old.example.test" # keep comment\n'],
  ])('follows property -> environment variable -> %s', async (file, content) => {
    const root = await fixture({ 'application.properties': 'proposal.url=${API_PROPOSAL_URL}\n', [file]: content });
    const { plan: result, scan } = await plan(root);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].entry.file).toBe(file);
    expect(result.proposals[0].change.chain.join(' → ')).toContain('API_PROPOSAL_URL');
    await applyConfiguration(scan, result.proposals);
    expect(await readFile(join(root, 'application.properties'), 'utf8')).toBe('proposal.url=${API_PROPOSAL_URL}\n');
    expect(await readFile(join(root, file), 'utf8')).toContain('http://virtual.example.test');
  });

  it('prefers selected-environment deployment values over neutral/profile defaults', async () => {
    const root = await fixture({
      'application.properties': 'proposal.url=${API_PROPOSAL_URL:https://default.example.test}\n',
      'values.yaml': 'env:\n  API_PROPOSAL_URL: https://neutral.example.test\n',
      'hom/values.yaml': 'env:\n  API_PROPOSAL_URL: https://hom.example.test\n',
      'prod/values.yaml': 'env:\n  API_PROPOSAL_URL: https://prod.example.test\n',
      '.env.example': 'API_PROPOSAL_URL=https://example.example.test\n',
    });
    expect((await plan(root)).plan.proposals[0].entry.file).toBe(join('hom', 'values.yaml'));
  });

  it('uses the selected YAML profile document', async () => {
    const root = await fixture({ 'application.yml': 'spring:\n  config:\n    activate:\n      on-profile: dev\nproposal:\n  url: https://dev.example.test\n---\nspring:\n  config:\n    activate:\n      on-profile: hom\nproposal:\n  url: https://hom.example.test\n' });
    const { plan: result, scan } = await plan(root);
    expect(result.proposals[0].entry.document).toBe(1);
    await applyConfiguration(scan, result.proposals);
    expect(await readFile(join(root, 'application.yml'), 'utf8')).toContain('https://dev.example.test');
  });

  it('rewrites only a default fallback when no variable definition is found', async () => {
    const root = await fixture({ 'application.properties': 'proposal.url=${API_PROPOSAL_URL:https://default.example.test}\n' });
    const { plan: result, scan } = await plan(root);
    expect(result.proposals[0].change).toMatchObject({ newValue: '${API_PROPOSAL_URL:http://virtual.example.test}', defaultFallback: true });
    await applyConfiguration(scan, result.proposals);
    expect(await readFile(join(root, 'application.properties'), 'utf8')).toBe('proposal.url=${API_PROPOSAL_URL:http://virtual.example.test}\n');
  });

  it('follows configuration chains into a separate selected repository', async () => {
    const app = await fixture({ 'application.properties': 'proposal.url=${API_PROPOSAL_URL}\n' });
    const external = await fixture({ 'hom/values.yaml': 'env:\n  API_PROPOSAL_URL: https://external.example.test\n' });
    const { plan: result, scan } = await plan(app, 'HOM', external);
    expect(result.proposals).toHaveLength(1);
    await applyConfiguration(scan, result.proposals);
    expect(await readFile(join(app, 'application.properties'), 'utf8')).toBe('proposal.url=${API_PROPOSAL_URL}\n');
    expect(await readFile(join(external, 'hom', 'values.yaml'), 'utf8')).toContain('http://virtual.example.test');
  });

  it('does not write to the application when an external repository was selected', async () => {
    const app = await fixture({ 'application.properties': 'proposal.url=https://old.example.test\n' });
    const external = await fixture();
    const { plan: result } = await plan(app, 'HOM', external);
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings.join('\n')).toContain('outro repositório');
  });

  it.each([
    ['missing', { 'application.properties': 'proposal.url=${MISSING}\n' }, 'não encontrada'],
    ['ambiguous', { 'one.properties': 'proposal.url=https://one.example.test\n', 'two.properties': 'proposal.url=https://two.example.test\n' }, 'ambígua'],
    ['cycle', { 'application.properties': 'proposal.url=${LOOP}\nLOOP=${proposal.url}\n' }, 'Ciclo'],
    ['sensitive', { 'application.properties': 'proposal.url=${API_SECRET}\nAPI_SECRET=https://old.example.test\n' }, 'sensível'],
    ['credentials', { 'application.properties': 'proposal.url=https://fictional:fictional-password@old.example.test\n' }, 'sensíveis'],
  ])('reports %s without making any proposal', async (_name, files, warning) => {
    const result = (await plan(await fixture(files))).plan;
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings.join('\n')).toContain(warning);
    expect(result.warnings.join('\n')).not.toContain('fictional-password');
  });

  it.each(['PROD', 'Produção', 'production', 'PRD', 'live'])('blocks production %s', async (environment) => {
    const root = await fixture({ 'application.properties': 'proposal.url=https://old.example.test\n' });
    expect((await plan(root, environment)).plan.proposals).toHaveLength(0);
    expect((await plan(root, environment)).plan.warnings.join('\n')).toContain('PRODUÇÃO');
  });

  it('supports a custom environment without selecting a different custom profile', async () => {
    const root = await fixture({ 'application-qa.properties': 'proposal.url=https://qa.example.test\n', 'application-local.properties': 'proposal.url=https://local.example.test\n' });
    expect((await plan(root, 'QA')).plan.proposals[0].entry.file).toBe('application-qa.properties');
  });

  it('handles multiple integrations and changes only approved properties', async () => {
    const root = await fixture({ 'application.properties': 'proposal.url=https://old.example.test\ncustomer.url=https://customer.example.test\n' });
    const scan = await readConfigurations(root); const repository = await analyzeRepository(root);
    const ctx = context(root);
    ctx.services.push({ method: 'GET', path: '/customer', url: 'http://virtual.example.test/customer' });
    ctx.externalCalls.push({ client: 'RestTemplate', method: 'GET', path: '/customer', url: 'https://customer.example.test', configurationProperty: 'customer.url' });
    const result = planConfiguration(ctx, repository, [scan], root, 'HOM');
    expect(result.proposals).toHaveLength(2);
    await applyConfiguration(scan, [result.proposals[0]]);
    expect(await readFile(join(root, 'application.properties'), 'utf8')).toContain('customer.url=https://customer.example.test');
    expect(result.proposals.map((proposal) => proposal.change.applied)).toEqual([true, false]);
  });
  it('rejects integrations requiring different targets for the same property', async () => {
    const root = await fixture({ 'application.properties': 'proposal.url=https://old.example.test\n' });
    const scan = await readConfigurations(root); const ctx = context(root);
    ctx.services.push({ method: 'GET', path: '/customer', url: 'http://other-virtual.example.test/customer' });
    ctx.externalCalls.push({ client: 'RestTemplate', method: 'GET', path: '/customer', configurationProperty: 'proposal.url' });
    const result = planConfiguration(ctx, await analyzeRepository(root), [scan], root, 'HOM');
    expect(result.proposals).toHaveLength(0); expect(result.warnings.join('\n')).toContain('valores diferentes');
  });
});

describe('logical rollback, metadata and Git diff', () => {
  it('records only safe old/new values and restores a property without changing secrets', async () => {
    const root = await fixture({ 'application.properties': 'proposal.url=https://old.example.test\npassword=fictional-secret\n' });
    const { plan: result, scan } = await plan(root);
    let metadataBeforeWrite = false;
    await applyConfiguration(scan, result.proposals, async () => {
      await saveConfigurationMetadata(context(root), root, root, 'HOM', result.proposals.map((proposal) => proposal.change), [], false);
      metadataBeforeWrite = (await readFile(join(root, 'application.properties'), 'utf8')).includes('https://old.example.test');
    });
    expect(metadataBeforeWrite).toBe(true);
    const changes = result.proposals.map((proposal) => proposal.change);
    await saveConfigurationMetadata(context(root), root, root, 'HOM', changes, [], false);
    const metadata = await readFile(join(root, 'configuration.json'), 'utf8');
    expect(metadata).not.toContain('fictional-secret');
    expect(JSON.parse(metadata).changes[0]).toMatchObject({ previousValue: 'https://old.example.test', newValue: 'http://virtual.example.test', applied: true });
    expect(await rollbackConfiguration(root, changes)).toBe(1);
    expect(await readFile(join(root, 'application.properties'), 'utf8')).toBe('proposal.url=https://old.example.test\npassword=fictional-secret\n');
  });
  it('detects edits made after the preview', async () => {
    const root = await fixture({ 'application.properties': 'proposal.url=https://old.example.test\n' });
    const { plan: result, scan } = await plan(root);
    await writeFile(join(root, 'application.properties'), 'proposal.url=https://someone-else.example.test\n');
    await expect(applyConfiguration(scan, result.proposals)).rejects.toThrow('depois do preview');
  });
  it('runs Git diff but displays only approved properties', async () => {
    const root = await fixture({ 'application.properties': 'proposal.url=https://old.example.test\npassword=fictional-secret\n' });
    await execute('git', ['init', '-q'], { cwd: root });
    await execute('git', ['add', '--', 'application.properties'], { cwd: root });
    const { plan: result, scan } = await plan(root); await applyConfiguration(scan, result.proposals);
    const diff = await relevantGitDiff(root, result.proposals.map((proposal) => proposal.change));
    expect(diff.isGit).toBe(true); expect(diff.diff).toContain('+proposal.url=http://virtual.example.test');
    expect(diff.diff).not.toContain('fictional-secret');
    expect(diff.diff).not.toContain('password');
  });
  it('loads publication and context, including a saved configuration repository', async () => {
    const root = await fixture({ 'publication.json': JSON.stringify({ application: 'demo', flow: 'flow', services: context('unused').services }), 'flow-context.json': JSON.stringify({ application: 'demo', flow: 'flow', externalCalls: context('unused').externalCalls, configurationRepository: 'fictitious-config' }) });
    const loaded = await readConfigurationContext(join(root, 'publication.json'));
    expect(loaded.configurationRepository).toBe('fictitious-config');
    expect(await discoverPublications(root)).toEqual([join(root, 'publication.json')]);
    await writeFile(join(root, 'publication.json'), '{invalid');
    await expect(readConfigurationContext(join(root, 'publication.json'))).rejects.toThrow('inválido');
  });
});
