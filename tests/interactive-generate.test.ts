import { input, select } from '@inquirer/prompts';
import * as fs from 'node:fs/promises';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { promptGenerate, validateRepositoryPath, validateLogPath, repositoryEndpoints, normalizeOptionalTraceId } from '../src/cli/commands/interactive-generate.js';
import { selectArgumentEntrypoint } from '../src/cli/commands/generate-workflow.js';
import { analyzeRepository } from '../src/repository/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeName } from '../src/shared/safe-name.js';

vi.mock('@inquirer/prompts', () => ({ input: vi.fn(), select: vi.fn() }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn(actual.access) };
});
const temporary: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(temporary.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
async function log(text: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'perf-ai-prompt-'));
  temporary.push(directory);
  const path = join(directory, 'input.log');
  await fs.writeFile(path, text);
  return path;
}

describe('interactive generation', () => {
  it.each([
    ['', undefined], ['   ', undefined], [undefined, undefined], [null, undefined], [' trace-test-123 ', 'trace-test-123'],
  ])('normalizes optional trace input %j to %j', (input, expected) => {
    expect(normalizeOptionalTraceId(input)).toBe(expected);
  });
  it.each(['', 'trace-123'])('asks in order, selects a discovered endpoint and allows trace %s', async (trace) => {
    vi.mocked(input).mockResolvedValueOnce('demo-api').mockResolvedValueOnce('./examples/spring-app').mockResolvedValueOnce('./examples/logs/aceite.log').mockResolvedValueOnce(trace);
    vi.mocked(select).mockResolvedValueOnce({ method: 'GET', path: '/products' });
    const result = await promptGenerate();
    expect(result).toMatchObject({ application: 'demo-api', flow: 'products', logs: './examples/logs/aceite.log', traceId: trace || undefined, entrypoint: { method: 'GET', path: '/products' } });
    expect(vi.mocked(input).mock.calls.map(([options]) => options.message)).toEqual([
      'Qual o nome da aplicação?', 'Informe o caminho do repositório:', 'Informe o caminho do arquivo de logs (.txt ou .log):', 'Possui Trace ID? (opcional)',
    ]);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Qual endpoint deseja virtualizar?', choices: expect.arrayContaining([expect.objectContaining({ name: 'GET /products', value: { method: 'GET', path: '/products' } })]),
    }));
    const nameValidate = vi.mocked(input).mock.calls[0][0].validate;
    expect(await nameValidate?.('  ')).not.toBe(true);
    expect(await nameValidate?.('demo-api')).toBe(true);
  });

  it('reports an empty repository without asking for a manual endpoint', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'perf-ai-empty-'));
    temporary.push(directory);
    vi.mocked(input).mockResolvedValueOnce('demo-api').mockResolvedValueOnce(directory);
    await expect(promptGenerate()).rejects.toThrow('Nenhum endpoint');
    expect(select).not.toHaveBeenCalled();
  });

  it('shows skipped-file diagnostics before selection and warns when the selected endpoint depends on a skipped type', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'perf-ai-partial-repository-'));
    temporary.push(root);
    await fs.writeFile(join(root, 'Controller.java'), '@RestController class Controller { private final BrokenService service; @GetMapping("/partial") String partial() { return service.read(); } }');
    await fs.writeFile(join(root, 'BrokenService.java'), '@Service class BrokenService {');
    vi.mocked(input).mockResolvedValueOnce('demo-api').mockResolvedValueOnce(root).mockResolvedValueOnce('./examples/logs/aceite.log').mockResolvedValueOnce('');
    vi.mocked(select).mockImplementationOnce(() => {
      const report = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(report).toContain('✓ 1 Java files analyzed');
      expect(report).toContain('⚠ 1 Java files skipped');
      expect(report).toContain('BrokenService.java — Unbalanced Java delimiters');
      return Object.assign(Promise.resolve({ method: 'GET', path: '/partial' }), { cancel: () => {} });
    });
    const result = await promptGenerate();
    expect(result.analysis.incomplete).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Repository analysis incomplete for endpoint GET /partial'));
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('BrokenService.java');
  });

  it('reports malformed files even when no endpoint remains selectable', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'perf-ai-malformed-repository-'));
    temporary.push(root);
    await fs.writeFile(join(root, 'BrokenController.java'), '@RestController class BrokenController {');
    vi.mocked(input).mockResolvedValueOnce('demo-api').mockResolvedValueOnce(root);
    await expect(promptGenerate()).rejects.toThrow('Nenhum endpoint');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('BrokenController.java — Unbalanced Java delimiters');
    expect(select).not.toHaveBeenCalled();
  });

  it('validates readable repositories and rejects missing paths and files', async () => {
    expect(await validateRepositoryPath('examples/spring-app')).toBe(true);
    expect(await validateRepositoryPath('examples/logs/aceite.log')).not.toBe(true);
    expect(await validateRepositoryPath('examples/fictional-missing')).not.toBe(true);
    vi.mocked(fs.access).mockRejectedValueOnce(new Error('EACCES'));
    expect(await validateRepositoryPath('examples/spring-app')).not.toBe(true);
  });

  it('validates logs as readable TXT/LOG files', async () => {
    expect(await validateLogPath('examples/logs/aceite.log')).toBe(true);
    expect(await validateLogPath('examples/spring-app/pom.xml')).not.toBe(true);
    expect(await validateLogPath('examples/logs/nonexistent.log')).not.toBe(true);
    const directory = join(temporary[0] ?? await fs.mkdtemp(join(tmpdir(), 'perf-ai-dir-')), 'directory.log');
    if (!temporary.length) temporary.push(join(directory, '..'));
    await fs.mkdir(directory);
    expect(await validateLogPath(directory)).not.toBe(true);
    vi.mocked(fs.access).mockRejectedValueOnce(new Error('EACCES'));
    expect(await validateLogPath('examples/logs/aceite.log')).not.toBe(true);
  });
});

describe('argument endpoint selection and safe names', () => {
  it('infers the entrypoint from inbound log evidence and filters by trace', async () => {
    const repository = await analyzeRepository('examples/spring-app');
    expect(repositoryEndpoints(repository)).toHaveLength(4);
    expect(await selectArgumentEntrypoint(repository, 'examples/logs/aceite.log', 'trace-123')).toEqual({ method: 'GET', path: '/products' });
    const path = await log('traceId=one HTTP GET /products\ntraceId=two HTTP POST /products\n');
    await expect(selectArgumentEntrypoint(repository, path)).rejects.toThrow('--endpoint');
    expect(await selectArgumentEntrypoint(repository, path, 'two')).toEqual({ method: 'POST', path: '/products' });
    expect(await selectArgumentEntrypoint(repository, path, undefined, 'GET /products')).toEqual({ method: 'GET', path: '/products' });
    await expect(selectArgumentEntrypoint(repository, path, undefined, 'GET /unknown')).rejects.toThrow('not found');
  });
  it.each([
    ['/termo/aceite', 'termo-aceite'], ['../..', 'flow'], ['CON', 'con-flow'], ['LPT1', 'lpt1-flow'],
    ['C:\\invalid:<path>?*', 'c-invalid-path'], ['propostas/{cpf}', 'propostas-cpf'], ['aceitação', 'aceitacao'],
  ])('makes %s filesystem-safe', (value, expected) => {
    expect(safeName(value)).toBe(expected);
    expect(safeName(value)).not.toMatch(/[<>:"/\\|?*]/);
  });
});
