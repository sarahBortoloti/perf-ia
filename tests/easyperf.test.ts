import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverVirtualizations, validateSelectedFiles, savePublications } from '../src/easyperf/virtualization-files.js';
import { parseEasyPerfConfig } from '../src/easyperf/easyperf-config.js';
import { normalizeBaseUrl, parseEasyPerfResult } from '../src/easyperf/easyperf-result-parser.js';
import type { SelectedVirtualization } from '../src/easyperf/types.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
export function selected(path = '/customer', method = 'POST'): SelectedVirtualization {
  return { filePath: 'fictional.json', fileName: 'fictional.json', application: 'demo', flow: 'flow', flowDirectory: 'unused', reviewRequired: false,
    template: { response: { metodo: method, path, status: 200, header: {}, body: {} } } };
}
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'perf-ai-publish-')); temporary.push(root);
  await mkdir(join(root, 'demo', 'aceite', 'virtualization'), { recursive: true });
  await writeFile(join(root, 'demo', 'aceite', 'virtualization', 'customer.json'), JSON.stringify(selected().template));
  return root;
}

describe('EasyPerf configuration', () => {
  const environment = { EASYPERF_BASE_URL: 'https://easyperf.example.test/', EASYPERF_PROJECT: 'Fictitious project', EASYPERF_SQUAD: 'Fictitious squad' };
  it('defaults to manual login and supports automatic credentials without printing them', () => {
    expect(parseEasyPerfConfig(environment)).toMatchObject({ manualLogin: true, project: 'Fictitious project', squad: 'Fictitious squad' });
    expect(parseEasyPerfConfig({ ...environment, EASYPERF_MANUAL_LOGIN: 'false', EASYPERF_USERNAME: 'fictional-user', EASYPERF_PASSWORD: 'fictional-password' })).toMatchObject({ manualLogin: false });
  });
  it.each(['EASYPERF_BASE_URL', 'EASYPERF_PROJECT', 'EASYPERF_SQUAD'])('requires %s', (field) => {
    expect(() => parseEasyPerfConfig({ ...environment, [field]: '' })).toThrow(field);
  });
  it.each(['file:///private', 'ftp://example.test', 'https://fictional-user:fictional-password@example.test', 'https://example.test?token=fictional-token'])('rejects unsafe base URL %s without exposing its contents', (url) => {
    expect(() => parseEasyPerfConfig({ ...environment, EASYPERF_BASE_URL: url })).toThrow('EASYPERF_BASE_URL');
    try { parseEasyPerfConfig({ ...environment, EASYPERF_BASE_URL: url }); } catch (error) {
      expect(String(error)).not.toContain('fictional-password'); expect(String(error)).not.toContain('fictional-token');
    }
  });
  it('requires credentials for automatic login and a valid boolean', () => {
    expect(() => parseEasyPerfConfig({ ...environment, EASYPERF_MANUAL_LOGIN: 'false' })).toThrow('requires');
    expect(() => parseEasyPerfConfig({ ...environment, EASYPERF_MANUAL_LOGIN: 'invalid' })).toThrow('EASYPERF_MANUAL_LOGIN');
  });
});

describe('virtualization discovery, validation and publication persistence', () => {
  it('discovers only virtualization JSONs, with origins and review metadata', async () => {
    const root = await fixture();
    await writeFile(join(root, 'demo', 'aceite', 'flow-context.json'), JSON.stringify({ externalCalls: [{ method: 'POST', path: '/customer', confidence: 'REVIEW_REQUIRED' }] }));
    await mkdir(join(root, 'other', 'flow', 'virtualization'), { recursive: true });
    await writeFile(join(root, 'other', 'flow', 'virtualization', 'other.json'), JSON.stringify(selected('/other').template));
    await writeFile(join(root, 'ignored.json'), '{}');
    await symlink(join(root, 'demo'), join(root, 'linked'), 'dir');
    const files = await discoverVirtualizations(root);
    expect(files.map((file) => `${file.application}/${file.flow}/${file.fileName}`)).toEqual(['demo/aceite/customer.json', 'other/flow/other.json']);
    expect(files.map((file) => file.reviewRequired)).toEqual([true, false]);
    expect(await validateSelectedFiles(files)).toHaveLength(2);
  });
  it('returns no files for absent output and treats unreadable metadata conservatively', async () => {
    const root = await fixture();
    expect(await discoverVirtualizations(join(root, 'missing'))).toEqual([]);
    await writeFile(join(root, 'demo', 'aceite', 'flow-context.json'), '{invalid');
    expect((await discoverVirtualizations(root))[0].reviewRequired).toBe(true);
  });
  it('reports every invalid selected file and never includes raw JSON excerpts', async () => {
    const root = await fixture();
    await writeFile(join(root, 'demo', 'aceite', 'virtualization', 'invalid.json'), '{"password":"fictional-secret", invalid');
    await writeFile(join(root, 'demo', 'aceite', 'virtualization', 'wrong-contract.json'), '{}');
    const files = await discoverVirtualizations(root);
    await expect(validateSelectedFiles(files)).rejects.toThrow('invalid.json');
    await expect(validateSelectedFiles(files)).rejects.toThrow('wrong-contract.json');
    try { await validateSelectedFiles(files); } catch (error) { expect(String(error)).not.toContain('fictional-secret'); }
  });
  it('sanitizes upload buffers without rewriting source files', async () => {
    const root = await fixture();
    const path = join(root, 'demo', 'aceite', 'virtualization', 'customer.json');
    const template = selected().template;
    template.response.header.Authorization = 'Bearer fictional-token';
    template.response.body = { password: 'fictional-secret' };
    const original = JSON.stringify(template); await writeFile(path, original);
    const validated = await validateSelectedFiles(await discoverVirtualizations(root));
    expect(JSON.stringify(validated)).not.toContain('fictional-token');
    expect(JSON.stringify(validated)).not.toContain('fictional-secret');
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('saves per-flow results with only selected endpoints and no session data', async () => {
    const root = await fixture();
    await mkdir(join(root, 'other', 'flow', 'virtualization'), { recursive: true });
    await writeFile(join(root, 'other', 'flow', 'virtualization', 'other.json'), JSON.stringify(selected('/other', 'GET').template));
    const files = await validateSelectedFiles(await discoverVirtualizations(root));
    const result = parseEasyPerfResult({ baseUrl: 'http://virtual.example.test/', endpoints: [{ method: 'POST', path: '/customer' }, { method: 'GET', path: '/other' }] }, files);
    const paths = await savePublications(files, result, '2026-01-01T00:00:00.000Z');
    expect(paths).toHaveLength(2);
    const first = JSON.parse(await readFile(paths[0], 'utf8'));
    expect(first).toEqual({ application: 'demo', flow: 'aceite', publishedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'http://virtual.example.test/', services: [{ method: 'POST', path: '/customer', url: 'http://virtual.example.test/customer' }] });
    expect(JSON.parse(await readFile(paths[1], 'utf8')).services).toHaveLength(1);
  });
});

describe('publication result parser', () => {
  it.each([
    ['http://virtual.example.test///', 'http://virtual.example.test/'],
    ['virtual.example.test:8080', 'http://virtual.example.test:8080/'],
    ['https://virtual.example.test/base//', 'https://virtual.example.test/base/'],
  ])('normalizes %s', (raw, expected) => { expect(normalizeBaseUrl(raw)).toBe(expected); });
  it('combines multiple endpoints and deduplicates matching result rows', () => {
    expect(parseEasyPerfResult({ baseUrl: 'http://virtual.example.test/base///', endpoints: [{ method: 'POST', path: '/customer' }, { path: '/proposal//read' }, { method: 'POST', path: '/customer' }] }, [selected(), selected('/proposal/read', 'GET')])).toEqual({
      baseUrl: 'http://virtual.example.test/base/', services: [{ method: 'POST', path: '/customer', url: 'http://virtual.example.test/base/customer' }, { method: 'GET', path: '/proposal/read', url: 'http://virtual.example.test/base/proposal/read' }],
    });
  });
  it.each(['', 'ftp://example.test', 'http://user:password@example.test', 'https://example.test?token=secret'])('rejects unsafe base %s', (value) => { expect(() => normalizeBaseUrl(value)).toThrow(); });
  it('rejects incomplete, unknown and ambiguous endpoints', () => {
    expect(() => parseEasyPerfResult({ baseUrl: 'http://virtual.test', endpoints: [] }, [selected()])).toThrow('all selected');
    expect(() => parseEasyPerfResult({ baseUrl: 'http://virtual.test', endpoints: [{ path: '/unknown' }] }, [selected()])).toThrow('unrecognized');
    expect(() => parseEasyPerfResult({ baseUrl: 'http://virtual.test', endpoints: [{ path: '/customer' }] }, [selected(), selected('/customer', 'GET')])).toThrow('ambiguous');
    expect(() => parseEasyPerfResult({ baseUrl: 'http://virtual.test', endpoints: [{ path: '//attacker.test/path' }] }, [selected()])).toThrow('unsafe');
  });
});
