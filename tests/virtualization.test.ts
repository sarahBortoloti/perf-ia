import { mkdtemp, readFile, readdir, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import type { FlowContext } from '../src/flow/flow-context.js';
import type { ExternalCall } from '../src/flow/external-call.js';
import { createVirtualizationTemplate } from '../src/virtualization/virtualization-template.js';
import { validateVirtualization } from '../src/virtualization/virtualization-validator.js';
import { VirtualizationGenerator } from '../src/virtualization/virtualization-generator.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'perf-ai-output-')); temporary.push(path); return path;
}
function call(patch: Partial<ExternalCall> = {}): ExternalCall {
  return { order: 1, client: 'customer', method: 'POST', path: '/cws/v1/fwrk/flow/system', status: 200, source: 'LOG', responseBody: { fixture: true }, body: { fixture: true }, bodySource: 'LOG', confidence: 'HIGH', ...patch };
}
function context(calls: ExternalCall[] = [call()]): FlowContext {
  return { application: 'demo-api', flow: 'aceite', entrypoint: { method: 'POST', path: '/termo/aceite' }, externalCalls: calls };
}

describe('VirtualizationTemplate and Validator', () => {
  it('produces exactly the EasyPerf contract with metadata kept outside', () => {
    const template = createVirtualizationTemplate(call({ body: {} }));
    expect(template).toEqual({ response: { metodo: 'POST', path: '/cws/v1/fwrk/flow/system', status: 200, header: { 'Content-Type': 'application/json' }, body: {} } });
    expect(() => validateVirtualization(template)).not.toThrow();
    expect(JSON.stringify(template)).not.toContain('confidence');
    expect(JSON.stringify(template)).not.toContain('bodySource');
  });

  it.each([
    ['metodo', undefined], ['metodo', 'ANY'], ['path', 'relative/path'], ['path', ''], ['status', '200'],
    ['status', NaN], ['status', 999], ['header', []], ['header', null], ['body', undefined],
  ])('rejects invalid %s=%s', (key, value) => {
    const template = createVirtualizationTemplate(call());
    const response = { ...template.response, [key]: value };
    expect(() => validateVirtualization({ response })).toThrow('Invalid virtualization');
  });
  it('rejects missing response and extra fields, and permits null/array response bodies', () => {
    expect(() => validateVirtualization({})).toThrow('response');
    expect(() => validateVirtualization({ ...createVirtualizationTemplate(call()), metadata: {} })).toThrow('top-level');
    expect(() => validateVirtualization({ response: { ...createVirtualizationTemplate(call()).response, method: 'POST' } })).toThrow('exactly');
    expect(() => validateVirtualization(createVirtualizationTemplate(call({ body: null })))).not.toThrow();
    expect(() => validateVirtualization(createVirtualizationTemplate(call({ body: [] })))).not.toThrow();
  });
});

describe('VirtualizationGenerator', () => {
  it('writes sanitized context and contracts with unique names and confidence', async () => {
    const root = await directory();
    const generated = await new VirtualizationGenerator().generate(context([
      call({ body: { secret: 'fictional-secret', cpf: '123.456.789-00' }, responseHeaders: { Authorization: 'Bearer fictional-auth', 'Content-Type': 'application/json' } }),
      call({ order: 2, body: {}, responseBody: undefined, bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' }),
    ]), root);
    expect(generated.files).toEqual([{ fileName: 'customer.json', confidence: 'HIGH' }, { fileName: 'customer-2.json', confidence: 'REVIEW_REQUIRED' }]);
    expect(generated.errors).toEqual([]);
    expect(relative(root, generated.directory)).toBe(join('demo-api', 'aceite', 'virtualization'));
    const savedContext = await readFile(join(generated.directory, '..', 'flow-context.json'), 'utf8');
    expect(JSON.parse(savedContext).externalCalls[0].bodySource).toBe('LOG');
    for (const file of generated.files) {
      const text = await readFile(join(generated.directory, file.fileName), 'utf8');
      const value = JSON.parse(text);
      validateVirtualization(value);
      expect(text).not.toContain('fictional-secret');
      expect(text).not.toContain('fictional-auth');
      expect(text).not.toContain('123.456.789-00');
      expect(savedContext).not.toContain('fictional-secret');
      expect(savedContext).not.toContain('fictional-auth');
    }
    expect(await readdir(join(root, 'demo-api', 'aceite'))).toEqual(['flow-context.json', 'virtualization']);
  });

  it('never overwrites existing virtualization files and adds suffixes across runs', async () => {
    const root = await directory();
    const generator = new VirtualizationGenerator();
    const first = await generator.generate(context(), root);
    const original = await readFile(join(first.directory, 'customer.json'), 'utf8');
    const second = await generator.generate(context([call({ body: { changed: true } })]), root);
    expect(second.files[0].fileName).toBe('customer-2.json');
    expect(await readFile(join(first.directory, 'customer.json'), 'utf8')).toBe(original);
  });

  it('reports validation errors and skips invalid files', async () => {
    const root = await directory();
    const result = await new VirtualizationGenerator().generate(context([call({ method: undefined }), call({ order: 2 })]), root);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('response.metodo');
    expect(result.files).toHaveLength(1);
  });

  it('uses filesystem-safe directory/file names and avoids traversal', async () => {
    const root = await directory();
    const unsafe = context([call({ client: 'CON' })]);
    unsafe.application = '../../outside'; unsafe.flow = 'C:\\unsafe:*?';
    const result = await new VirtualizationGenerator().generate(unsafe, root);
    expect(relative(root, result.directory)).not.toMatch(/^\.\./);
    expect(result.files[0].fileName).toBe('con-flow.json');
  });

  it('rejects symlinked output directories and context files', async () => {
    const root = await directory();
    const elsewhere = await directory();
    await symlink(elsewhere, join(root, 'demo-api'), 'dir');
    await expect(new VirtualizationGenerator().generate(context(), root)).rejects.toThrow('symbolic link');
    await rm(join(root, 'demo-api'));
    await mkdir(join(root, 'demo-api', 'aceite'), { recursive: true });
    const target = join(elsewhere, 'context.json'); await writeFile(target, 'original');
    await symlink(target, join(root, 'demo-api', 'aceite', 'flow-context.json'));
    await expect(new VirtualizationGenerator().generate(context(), root)).rejects.toThrow('symbolic link');
    expect(await readFile(target, 'utf8')).toBe('original');
  });
});
