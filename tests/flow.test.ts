import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { analyzeRepository } from '../src/repository/index.js';
import { FlowBuilder } from '../src/flow/flow-builder.js';
import { findCodeCalls, pathMatches } from '../src/flow/code-calls.js';
import { ResponseBodyResolver } from '../src/flow/response-body-resolver.js';
import type { RepositoryAnalysis } from '../src/repository/types.js';
import type { ExternalCall } from '../src/flow/external-call.js';
import { sanitizeValue } from '../src/security/sensitive-data-sanitizer.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'perf-ai-flow-')); temporary.push(path); return path;
}
async function build(text?: string, traceId?: string) {
  const repository = await analyzeRepository('examples/spring-app');
  let logPath = 'examples/logs/aceite.log';
  if (text !== undefined) { logPath = join(await directory(), 'input.log'); await writeFile(logPath, text); }
  return new FlowBuilder().build({ application: 'demo-api', flow: 'aceite', entrypoint: { method: 'GET', path: '/products' }, repository, logPath, traceId });
}
const call = (patch: Partial<ExternalCall> = {}): ExternalCall => ({ order: 1, method: 'GET', path: '/remote/items', status: 200, source: 'CODE', bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED', ...patch });

async function resolverWith(files: Record<string, string>, types: RepositoryAnalysis['javaTypes'] = []) {
  const root = await directory();
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const repository: RepositoryAnalysis = { repositoryPath: root, controllers: [], services: [], feignClients: [], configurationFiles: [], javaTypes: types };
  const resolver = new ResponseBodyResolver(repository); await resolver.load(); return resolver;
}

describe('FlowBuilder', () => {
  it('correlates reachable code with runtime and captures real response evidence safely', async () => {
    const { context, logs } = await build(undefined, 'trace-123');
    expect(context).toMatchObject({ application: 'demo-api', flow: 'aceite', entrypoint: { method: 'GET', path: '/products' }, traceId: 'trace-123' });
    expect(context.externalCalls).toHaveLength(2);
    expect(context.externalCalls[0]).toMatchObject({ order: 1, client: 'inventory', method: 'GET', path: '/inventory/products', status: 200, source: 'CODE_AND_LOG', bodySource: 'LOG', confidence: 'HIGH' });
    expect(context.externalCalls[0].responseBody).toMatchObject({ items: [{ id: 'fictional-item', name: 'Example product', cpf: '[REDACTED]' }], secret: '[REDACTED]' });
    expect(context.externalCalls[0].responseHeaders?.['X-Signature']).toBe('[REDACTED]');
    expect(context.externalCalls[1]).toMatchObject({ order: 2, client: 'shipping', method: 'POST', status: 200, source: 'CODE_AND_LOG', bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' });
    expect(logs.httpCallsFound).toBe(3);
    for (const secret of ['fictional-demo-token', 'fictional-body-secret', 'fictional-signature', '123.456.789-00']) expect(JSON.stringify(context)).not.toContain(secret);
  });

  it('labels explicit unobserved invocations CODE and never assigns every client to other endpoints', async () => {
    const { context } = await build('traceId=trace-123 HTTP GET /products\n', 'trace-123');
    expect(context.externalCalls.map((c) => c.source)).toEqual(['CODE', 'CODE']);
    expect(context.externalCalls.every((c) => c.confidence === 'REVIEW_REQUIRED' && c.status === undefined)).toBe(true);
    const repository = await analyzeRepository('examples/spring-app');
    expect(findCodeCalls(repository, { method: 'POST', path: '/products' })).toEqual([]);
  });

  it('keeps runtime-only calls LOG and excludes traces of other entrypoints', async () => {
    const { context } = await build([
      'traceId=selected HTTP GET /products',
      'traceId=selected WebClient GET https://unknown.example.test/remote status=201 responseBody={"fixture":true}',
      'traceId=other HTTP POST /products',
      'traceId=other WebClient GET https://unrelated.example.test/leak status=200 responseBody={"unrelated":true}',
    ].join('\n'));
    expect(context.externalCalls[0]).toMatchObject({ source: 'LOG', bodySource: 'LOG', confidence: 'HIGH', status: 201, responseBody: { fixture: true } });
    expect(JSON.stringify(context)).not.toContain('unrelated');
    expect(context.externalCalls).toHaveLength(3);
  });

  it('does not guess which concurrent request owns an ambiguous response', async () => {
    const { context } = await build([
      'traceId=t HTTP GET /products',
      'traceId=t WebClient GET https://unknown.test/one',
      'traceId=t WebClient GET https://unknown.test/two',
      'traceId=t WebClient Response 200 responseBody={"ambiguous":true}',
    ].join('\n'), 't');
    expect(context.externalCalls.slice(0, 2).every((c) => c.responseBody === undefined && c.status === undefined && c.bodySource === 'EMPTY')).toBe(true);
  });

  it('matches response request IDs and Feign standalone JSON bodies', async () => {
    const { context } = await build([
      'traceId=t WebClient requestId=one GET https://unknown.test/one',
      'traceId=t WebClient requestId=two GET https://unknown.test/two',
      'traceId=t WebClient requestId=one Response 201 responseBody={"one":true}',
      'traceId=t Feign [OtherClient#read] ---> GET https://unknown.test/three',
      'traceId=t Feign [OtherClient#read] <--- 200',
      '{"three":true,"password":"fictional-secret"}',
    ].join('\n'), 't');
    expect(context.externalCalls[0]).toMatchObject({ status: 201, responseBody: { one: true }, bodySource: 'LOG' });
    expect(context.externalCalls[1].status).toBeUndefined();
    expect(context.externalCalls[2]).toMatchObject({ status: 200, responseBody: { three: true, password: '[REDACTED]' }, bodySource: 'LOG' });
  });

  it('matches path parameters without interpreting regex metacharacters', () => {
    expect(pathMatches('/items/{id}', '/items/123')).toBe(true);
    expect(pathMatches('/items/{id}', '/items/123/nested')).toBe(false);
    expect(pathMatches('/a.b', '/axb')).toBe(false);
  });

  it('captures bounded multiline JSON responses without retaining sensitive values', async () => {
    const { context } = await build([
      'traceId=t Feign [OtherClient#read] ---> GET https://unknown.test/multiline',
      'traceId=t Feign [OtherClient#read] <--- 200',
      '{', '  "id": "fictional-id",', '  "password": "fictional-multiline-secret",', '  "cpf": 12345678900', '}',
    ].join('\n'), 't');
    expect(context.externalCalls[0]).toMatchObject({ responseBody: { id: 'fictional-id', password: '[REDACTED]', cpf: '[REDACTED]' }, bodySource: 'LOG', confidence: 'HIGH' });
    expect(JSON.stringify(context)).not.toContain('fictional-multiline-secret');
  });
});

describe('response body evidence', () => {
  it('prioritizes LOG over OpenAPI and existing fixtures', async () => {
    const resolver = await resolverWith({});
    expect(resolver.resolve(call({ responseBody: { actual: 'fictional' } }))).toEqual({ responseBody: { actual: 'fictional' }, bodySource: 'LOG', confidence: 'HIGH' });
    expect(resolver.resolve(call({ responseBody: null }))).toMatchObject({ responseBody: null, bodySource: 'LOG' });
  });

  it.each(['json', 'yaml'])('uses matching OpenAPI %s response examples before mocks', async (format) => {
    const specification = { openapi: '3.0.3', paths: { '/remote/items': { get: { responses: { '200': { content: { 'application/json': { example: { fixture: 'swagger', token: 'fictional-token' } } } } } } } } };
    const text = format === 'json' ? JSON.stringify(specification) : 'openapi: 3.0.3\npaths:\n  /remote/items:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              example:\n                fixture: swagger\n                token: fictional-token\n';
    const resolver = await resolverWith({ [`openapi.${format === 'json' ? 'json' : 'yml'}`]: text, 'mocks/items.json': JSON.stringify({ request: { method: 'GET', urlPath: '/remote/items' }, response: { status: 200, jsonBody: { fixture: 'mock' } } }) });
    expect(resolver.resolve(call())).toMatchObject({ responseBody: { fixture: 'swagger', token: '[REDACTED]' }, bodySource: 'OPENAPI', confidence: 'HIGH' });
    expect(resolver.resolve(call({ status: undefined }))).toMatchObject({ bodySource: 'OPENAPI', confidence: 'MEDIUM' });
  });

  it('uses only matching mocks and ignores unrelated or malformed evidence', async () => {
    const resolver = await resolverWith({
      'mocks/items.json': JSON.stringify({ request: { method: 'GET', urlPath: '/remote/items' }, response: { status: 200, jsonBody: { fixture: 'mock' } } }),
      'fixtures/unrelated.json': JSON.stringify({ method: 'GET', path: '/other', responseBody: { wrong: true } }),
      'openapi-broken.json': '{invalid',
    });
    expect(resolver.resolve(call())).toMatchObject({ responseBody: { fixture: 'mock' }, bodySource: 'EXISTING_MOCK', confidence: 'HIGH' });
    expect(resolver.resolve(call({ status: 404 }))).toMatchObject({ bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' });
    expect(resolver.resolve(call({ method: 'POST' }))).toMatchObject({ bodySource: 'EMPTY' });
  });

  it('resolves local OpenAPI references and preserves explicit null examples', async () => {
    const resolver = await resolverWith({
      'api-spec.json': JSON.stringify({ openapi: '3.0.3', servers: [{ url: 'https://fictional.test/remote' }], paths: { '/items': { get: { responses: { '200': { $ref: '#/components/responses/Item' } } } } }, components: { responses: { Item: { content: { 'application/json': { examples: { nullable: { $ref: '#/components/examples/Nullable' } } } } } }, examples: { Nullable: { value: null } } } }),
    });
    expect(resolver.resolve(call())).toMatchObject({ responseBody: null, bodySource: 'OPENAPI', confidence: 'HIGH' });
  });

  it('creates only DTO field structure, and otherwise uses EMPTY', async () => {
    const resolver = await resolverWith({}, [{ name: 'ItemDto', packageName: 'demo', filePath: 'ItemDto.java', fields: { id: 'String', amount: 'BigDecimal', cpf: 'String' }, methods: [] }]);
    expect(resolver.resolve(call({ returnType: 'ResponseEntity<ItemDto>' }))).toMatchObject({ responseBody: { id: null, amount: null, cpf: '[REDACTED]' }, bodySource: 'DTO', confidence: 'REVIEW_REQUIRED' });
    expect(resolver.resolve(call({ returnType: 'String' }))).toEqual({ bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' });
  });

  it('recursively sanitizes nested bodies and preserves JSON structure', () => {
    expect(sanitizeValue({ nested: [{ Authorization: 'Bearer fictional', password: 'fictional', cpf: 12345678900 }], ordinary: 'safe' })).toEqual({ nested: [{ Authorization: '[REDACTED]', password: '[REDACTED]', cpf: '[REDACTED]' }], ordinary: 'safe' });
  });
});
