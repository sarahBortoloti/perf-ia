import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/index.js';
import * as repository from '../src/repository/index.js';

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

  it('accepts reserved logs and trace-id options without reading logs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const analyzer = vi.spyOn(repository, 'analyzeRepository');
    const { program } = testProgram();
    await program.parseAsync([...requiredArgs, '--logs', '/nonexistent/logs', '--trace-id', 'trace-123'], { from: 'user' });
    expect(program.commands.find((command) => command.name() === 'generate')?.opts()).toMatchObject({
      logs: '/nonexistent/logs', traceId: 'trace-123',
    });
    expect(analyzer).toHaveBeenCalledExactlyOnceWith('./examples/spring-app');
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
