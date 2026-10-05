import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/index.js';
import * as repository from '../src/repository/index.js';
import * as logParser from '../src/logs/log-parser.js';

afterEach(() => { vi.restoreAllMocks(); });

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
      'Repository analyzed', '', 'Application: demo-api', 'Controllers: 1', 'Endpoints: 4', 'Feign clients: 1',
      '', 'Endpoints encontrados:', 'GET /products', 'POST /products', 'PUT /products/{id}', 'DELETE /products/{id}',
      '', 'External clients:', 'inventory',
    ].join('\n'));
  });

  it.each([undefined, 'trace-123'])('analyzes logs with trace filter %s', async (traceId) => {
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
    expect(logAnalyzer).toHaveBeenCalledExactlyOnceWith('./examples/logs/aceite.log', traceId);
    expect(output).toHaveBeenLastCalledWith([
      'Log analyzed', '', 'Lines processed: 6', 'Relevant lines: 5', 'Trace IDs found: 1',
      'HTTP calls found: 2', 'Context reduction: 16.67%',
    ].join('\n'));
    expect(output.mock.calls.flat().join('\n')).not.toContain('fictional-demo-token');
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
    expect(errors.join('')).toContain(missing);
    expect(output).not.toHaveBeenCalled();
  });
});
