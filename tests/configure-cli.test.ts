import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { select, input, confirm } from '@inquirer/prompts';
import { runConfigure } from '../src/cli/commands/configure-workflow.js';
import { createProgram } from '../src/cli/index.js';

vi.mock('@inquirer/prompts', () => ({ select: vi.fn(), input: vi.fn(), confirm: vi.fn() }));
const temporary: string[] = [];
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(select).mockReset(); vi.mocked(input).mockReset(); vi.mocked(confirm).mockReset(); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'perf-ai-configure-cli-')); temporary.push(root);
  await writeFile(join(root, 'ProposalClient.java'), '@FeignClient(name="proposal", url="${proposal.url}") interface ProposalClient { @PostMapping("/proposal") String create(); }');
  await writeFile(join(root, 'application.properties'), 'proposal.url=https://old.example.test\npassword=fictional-secret\n');
  await writeFile(join(root, 'publication.json'), JSON.stringify({ application: 'demo', flow: 'flow', services: [{ method: 'POST', path: '/proposal', url: 'http://virtual.example.test/proposal' }] }));
  await writeFile(join(root, 'flow-context.json'), JSON.stringify({ application: 'demo', flow: 'flow', applicationRepository: root, configurationRepository: root, externalCalls: [{ client: 'proposal', clientMethod: 'create', method: 'POST', path: '/proposal', codePath: 'ProposalClient.java' }] }));
  return root;
}
describe('configure CLI', () => {
  it('recognizes dry-run/publication, previews the chain and never writes or asks approval', async () => {
    const root = await fixture();
    vi.mocked(select).mockResolvedValueOnce('application').mockResolvedValueOnce('HOM');
    await createProgram().parseAsync(['configure', '--dry-run', '--publication', join(root, 'publication.json')], { from: 'user' });
    expect(confirm).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'application.properties'), 'utf8')).toContain('https://old.example.test');
    await expect(access(join(root, 'configuration.json'))).rejects.toThrow();
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('Integration: ProposalClient'); expect(output).toContain('Files changed: 0');
    expect(output).not.toContain('fictional-secret');
  });
  it.each([true, false])('applies only an approved configuration: %s', async (approved) => {
    const root = await fixture();
    vi.mocked(select).mockResolvedValueOnce('application').mockResolvedValueOnce('HOM'); vi.mocked(confirm).mockResolvedValueOnce(approved);
    await runConfigure({ publication: join(root, 'publication.json') });
    expect(confirm).toHaveBeenCalledWith({ message: 'Aplicar alteração?', default: false });
    expect(await readFile(join(root, 'application.properties'), 'utf8')).toContain(approved ? 'http://virtual.example.test' : 'https://old.example.test');
    const metadata = await readFile(join(root, 'configuration.json'), 'utf8');
    expect(JSON.parse(metadata).changes[0].applied).toBe(approved); expect(metadata).not.toContain('fictional-secret');
  });
  it('offers the saved configuration repository and allows selecting it', async () => {
    const root = await fixture(); vi.mocked(select).mockResolvedValueOnce('saved').mockResolvedValueOnce('DEV');
    await runConfigure({ publication: join(root, 'publication.json'), dryRun: true });
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: 'Qual repositório deseja configurar?', choices: expect.arrayContaining([expect.objectContaining({ value: 'saved' })]) }));
    expect(input).not.toHaveBeenCalled();
  });
  it('blocks production even when entered as a custom environment', async () => {
    const root = await fixture(); vi.mocked(select).mockResolvedValueOnce('application').mockResolvedValueOnce('Outro'); vi.mocked(input).mockResolvedValueOnce('Produção');
    await runConfigure({ publication: join(root, 'publication.json') });
    expect(confirm).not.toHaveBeenCalled(); await expect(access(join(root, 'configuration.json'))).rejects.toThrow();
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('PRODUÇÃO');
  });
  it('reports a missing publication without opening prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perf-ai-configure-empty-')); temporary.push(root);
    await runConfigure({ outputRoot: root }); expect(select).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Execute publish');
  });
});
