import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/index.js';
import * as repository from '../src/repository/index.js';
import * as logParser from '../src/logs/log-parser.js';
import * as interactive from '../src/cli/commands/interactive-generate.js';
import { VirtualizationGenerator } from '../src/virtualization/virtualization-generator.js';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function isolateOutput(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'perf-ai-cli-'));
  temporary.push(root);
  const generate = VirtualizationGenerator.prototype.generate;
  vi.spyOn(VirtualizationGenerator.prototype, 'generate').mockImplementation(function(this: VirtualizationGenerator, context) { return generate.call(this, context, root); });
}

const requiredArgs = ['generate', '--application', 'demo-api', '--repository', './examples/spring-app', '--flow', 'aceite'];

function testProgram() {
  const program = createProgram().exitOverride();
  const errors: string[] = [];
  program.configureOutput({ writeErr: (message) => errors.push(message) });
  for (const command of program.commands) {
    command.exitOverride().configureOutput({ writeErr: (message) => errors.push(message) });
  }
  return { program, errors };
}

describe('CLI', () => {
  it('registers generate, publish and virtualize', () => {
    const names = createProgram().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(['generate', 'publish', 'virtualize']));
  });

  it('accepts required options and analyzes the repository with the expected summary', async () => {
    const analyzer = vi.spyOn(repository, 'analyzeRepository');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { program } = testProgram();
    await program.parseAsync(requiredArgs, { from: 'user' });
    expect(analyzer).toHaveBeenCalledExactlyOnceWith('./examples/spring-app');
    expect(program.commands.find((command) => command.name() === 'generate')?.opts()).toEqual({
      application: 'demo-api', repository: './examples/spring-app', flow: 'aceite',
    });
    expect(output).toHaveBeenCalledExactlyOnceWith([
      'Repository analyzed', '✓ 5 Java files analyzed', '✓ 0 Java files skipped', '', 'Application: demo-api', 'Controllers: 1', 'Endpoints: 4', 'Feign clients: 2',
      '', 'Endpoints encontrados:', 'GET /products', 'POST /products', 'PUT /products/{id}', 'DELETE /products/{id}',
      '', 'External clients:', 'inventory', 'shipping',
    ].join('\n'));
  });

  it.each([undefined, 'trace-123'])('analyzes logs with trace filter %s', async (traceId) => {
    await isolateOutput();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const analyzer = vi.spyOn(repository, 'analyzeRepository');
    const logAnalyzer = vi.spyOn(logParser, 'analyzeLogs');
    const { program } = testProgram();
    const args = [...requiredArgs, '--logs', './examples/logs/aceite.log'];
    if (traceId) args.push('--trace-id', traceId);
    await program.parseAsync(args, { from: 'user' });
    expect(program.commands.find((command) => command.name() === 'generate')?.opts()).toMatchObject({
      logs: './examples/logs/aceite.log',
    });
    expect(analyzer).toHaveBeenCalledExactlyOnceWith('./examples/spring-app');
    expect(logAnalyzer).toHaveBeenCalledExactlyOnceWith('./examples/logs/aceite.log', traceId, expect.any(Function), undefined);
    const report = output.mock.calls.flat().join('\n');
    for (const text of ['Log analyzed', 'Lines processed: 9', 'Relevant lines: 7', 'Trace IDs found: 1', 'HTTP calls found: 3', 'Context reduction: 22.22%', '2 virtualization files generated.']) expect(report).toContain(text);
    expect(output.mock.calls.flat().join('\n')).not.toContain('fictional-demo-token');
  });

  it('starts interactive generation when invoked without options', async () => {
    await isolateOutput();
    const analysis = await repository.analyzeRepository('examples/spring-app');
    const prompt = vi.spyOn(interactive, 'promptGenerate').mockResolvedValueOnce({
      application: 'demo-api', repository: './examples/spring-app', flow: 'products', logs: './examples/logs/aceite.log',
      entrypoint: { method: 'GET', path: '/products' }, analysis,
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { program } = testProgram();
    await program.parseAsync(['generate'], { from: 'user' });
    expect(prompt).toHaveBeenCalledOnce();
    expect(output.mock.calls.flat().join('\n')).toContain('2 virtualization files generated.');
  });

  it('lists a malformed Java file and keeps the repository-only command successful', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perf-ai-partial-cli-'));
    temporary.push(root);
    await writeFile(join(root, 'ValidController.java'), '@RestController class ValidController { @GetMapping("/valid") String valid() { return "{}"; } }');
    await writeFile(join(root, 'Broken.java'), 'class Broken {');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { program } = testProgram();
    const args = [...requiredArgs];
    args[args.indexOf('--repository') + 1] = root;
    await program.parseAsync(args, { from: 'user' });
    const report = output.mock.calls.flat().join('\n');
    expect(report).toContain('✓ 1 Java files analyzed');
    expect(report).toContain('⚠ 1 Java files skipped');
    expect(report).toContain('Broken.java — Unbalanced Java delimiters');
    expect(report).toContain('GET /valid');
  });

  it('reports log errors without printing sensitive data', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { program, errors } = testProgram();
    const missing = join(tmpdir(), `missing-${randomUUID()}-password=fictional-secret.log`);
    await expect(program.parseAsync([...requiredArgs, '--logs', missing], { from: 'user' })).rejects.toMatchObject({
      code: 'perf-ai.logAnalysisFailed', exitCode: 1,
    });
    expect(errors.join('')).toContain('Log file does not exist');
    expect(errors.join('')).not.toContain('fictional-secret');
    expect(output.mock.calls.flat().join('\n')).not.toContain('Log analyzed');
  });

  it.each(['--application', '--repository', '--flow'])('requires %s before analyzing', async (option) => {
    const analyzer = vi.spyOn(repository, 'analyzeRepository');
    const { program, errors } = testProgram();
    const args = [...requiredArgs];
    args.splice(args.indexOf(option), 2);
    await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({
      code: 'commander.missingMandatoryOptionValue', exitCode: 1,
    });
    expect(errors.join('')).toContain(option);
    expect(analyzer).not.toHaveBeenCalled();
  });

  it('reports an understandable error for a nonexistent repository', async () => {
    const { program, errors } = testProgram();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const missing = join(tmpdir(), `perf-ai-missing-${randomUUID()}`);
    const args = [...requiredArgs];
    args[args.indexOf('--repository') + 1] = missing;
    await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({
      code: 'perf-ai.repositoryAnalysisFailed', exitCode: 1,
    });
    expect(errors.join('')).toContain('Repository does not exist');
    expect(output).not.toHaveBeenCalled();
  });
});
