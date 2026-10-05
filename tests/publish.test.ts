import { checkbox, confirm, input } from '@inquirer/prompts';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { runPublish } from '../src/cli/commands/publish-workflow.js';
import * as workflow from '../src/cli/commands/publish-workflow.js';
import { createProgram } from '../src/cli/index.js';
import { discoverVirtualizations } from '../src/easyperf/virtualization-files.js';
import { EasyPerfPublisher } from '../src/easyperf/easyperf-publisher.js';

vi.mock('@inquirer/prompts', () => ({ checkbox: vi.fn(), confirm: vi.fn(), input: vi.fn(), select: vi.fn() }));
vi.mock('dotenv', () => ({ config: vi.fn() }));
const temporary: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [key, value] of Object.entries({ EASYPERF_BASE_URL: 'http://easyperf.example.test/', EASYPERF_USERNAME: 'fictional-user', EASYPERF_PASSWORD: 'fictional-password', EASYPERF_MANUAL_LOGIN: 'false', EASYPERF_PROJECT: 'Fictitious project', EASYPERF_SQUAD: 'Fictitious squad' })) vi.stubEnv(key, value);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(review = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'perf-ai-publish-workflow-')); temporary.push(root);
  const flow = join(root, 'demo', 'flow');
  await mkdir(join(flow, 'virtualization'), { recursive: true });
  for (const name of ['customer', 'proposal']) await writeFile(join(flow, 'virtualization', `${name}.json`), JSON.stringify({ response: { metodo: 'POST', path: `/${name}`, status: 200, header: {}, body: {} } }));
  await writeFile(join(flow, 'flow-context.json'), JSON.stringify({ externalCalls: [{ method: 'POST', path: '/customer', confidence: review ? 'REVIEW_REQUIRED' : 'HIGH' }] }));
  return root;
}
function mockPublication() {
  return vi.spyOn(EasyPerfPublisher.prototype, 'publish').mockResolvedValue({ baseUrl: 'http://virtual.example.test/', services: [{ method: 'POST', path: '/customer', url: 'http://virtual.example.test/customer' }, { method: 'POST', path: '/proposal', url: 'http://virtual.example.test/proposal' }] });
}

describe('publish workflow', () => {
  it('selects multiple files, publishes once, and saves publication.json', async () => {
    const root = await fixture(); const files = await discoverVirtualizations(root);
    vi.mocked(checkbox).mockResolvedValueOnce(files);
    const publish = mockPublication();
    await runPublish({ outputRoot: root });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toHaveLength(2);
    expect(checkbox).toHaveBeenCalledWith(expect.objectContaining({ choices: expect.arrayContaining([expect.objectContaining({ name: 'demo/flow — customer.json' })]) }));
    const publication = JSON.parse(await readFile(join(root, 'demo', 'flow', 'publication.json'), 'utf8'));
    expect(publication.services).toHaveLength(2);
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).not.toContain('fictional-user'); expect(output).not.toContain('fictional-password');
  });
  it('cancels without error on an empty selection', async () => {
    const root = await fixture(); vi.mocked(checkbox).mockResolvedValueOnce([]);
    const publish = mockPublication();
    await runPublish({ outputRoot: root });
    expect(publish).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('nenhum arquivo selecionado');
  });
  it('dry run validates selection without browser, config, network or output writes', async () => {
    const root = await fixture(); vi.mocked(checkbox).mockResolvedValueOnce(await discoverVirtualizations(root));
    vi.stubEnv('EASYPERF_BASE_URL', '');
    const publish = mockPublication();
    await runPublish({ outputRoot: root, dryRun: true });
    expect(publish).not.toHaveBeenCalled();
    expect(await readdir(join(root, 'demo', 'flow'))).toEqual(['flow-context.json', 'virtualization']);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Dry run');
  });
  it('rejects invalid files before opening a browser', async () => {
    const root = await fixture();
    await writeFile(join(root, 'demo', 'flow', 'virtualization', 'customer.json'), '{}');
    vi.mocked(checkbox).mockResolvedValueOnce(await discoverVirtualizations(root));
    const publish = mockPublication();
    await expect(runPublish({ outputRoot: root })).rejects.toThrow('invalid files');
    expect(publish).not.toHaveBeenCalled();
  });
  it.each([false, true])('requires explicit REVIEW_REQUIRED confirmation (%s)', async (accepted) => {
    const root = await fixture(true);
    vi.mocked(checkbox).mockResolvedValueOnce(await discoverVirtualizations(root));
    vi.mocked(confirm).mockResolvedValueOnce(accepted);
    const publish = mockPublication();
    await runPublish({ outputRoot: root });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ default: false, message: expect.stringContaining('REVIEW_REQUIRED') }));
    expect(publish).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });
  it('validates missing base URL before browser access', async () => {
    const root = await fixture(); vi.mocked(checkbox).mockResolvedValueOnce(await discoverVirtualizations(root));
    vi.stubEnv('EASYPERF_BASE_URL', ''); const publish = mockPublication();
    await expect(runPublish({ outputRoot: root })).rejects.toThrow('EASYPERF_BASE_URL');
    expect(publish).not.toHaveBeenCalled();
  });
  it('asks for project and squad if absent from environment', async () => {
    const root = await fixture(); vi.mocked(checkbox).mockResolvedValueOnce(await discoverVirtualizations(root));
    vi.stubEnv('EASYPERF_PROJECT', ''); vi.stubEnv('EASYPERF_SQUAD', '');
    vi.mocked(input).mockResolvedValueOnce('Fictitious chosen project').mockResolvedValueOnce('Fictitious chosen squad');
    const publish = mockPublication();
    await runPublish({ outputRoot: root });
    expect(publish.mock.calls[0][1]).toMatchObject({ project: 'Fictitious chosen project', squad: 'Fictitious chosen squad' });
  });
});

describe('publish CLI', () => {
  it('accepts --dry-run', async () => {
    const run = vi.spyOn(workflow, 'runPublish').mockResolvedValueOnce();
    await createProgram().parseAsync(['publish', '--dry-run'], { from: 'user' });
    expect(run).toHaveBeenCalledExactlyOnceWith({ dryRun: true });
  });
  it('treats a cancelled prompt as a clean cancellation', async () => {
    vi.spyOn(workflow, 'runPublish').mockRejectedValueOnce(Object.assign(new Error('Cancelled'), { name: 'ExitPromptError' }));
    await createProgram().parseAsync(['publish'], { from: 'user' });
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Publicação cancelada');
  });
});
