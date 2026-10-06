import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from '../src/repository/index.js';
import { FlowBuilder } from '../src/flow/flow-builder.js';
import { findCodeCalls } from '../src/flow/code-calls.js';
import { HttpInteractionReconstructor } from '../src/logs/http-interaction-reconstructor.js';
import { parseLogLine } from '../src/logs/log-parser.js';
import { groupInteractions } from '../src/flow/interaction-groups.js';
import { VirtualizationGenerator } from '../src/virtualization/virtualization-generator.js';
import type { ExternalCall } from '../src/flow/external-call.js';
import { configurationReferences } from '../src/flow/configuration-references.js';

const temporary: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), 'perf-ai-integrations-')); temporary.push(root); return root; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function reconstruct(lines: string[]) {
  const reconstructor = new HttpInteractionReconstructor(); lines.forEach((line) => reconstructor.consume(parseLogLine(line)));
  return { calls: reconstructor.finish(), diagnostics: reconstructor.diagnostics };
}
async function fixtureFlow() {
  return new FlowBuilder().build({ application: 'fictional', flow: 'flow', repository: await analyzeRepository('examples/integrations-fixture/app'),
    entrypoint: { method: 'GET', path: '/flow' }, logPath: 'examples/integrations-fixture/logs/flow.log', traceId: 'fixture-trace' });
}
describe('independent CODE and LOG integration discovery', () => {
  it('discovers Feign and a reachable Gateway by HTTP evidence, resolving YAML references', async () => {
    const repository = await analyzeRepository('examples/integrations-fixture/app');
    const calls = findCodeCalls(repository, { method: 'GET', path: '/flow' });
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ client: 'login', method: 'POST', url: 'https://login.example.test/login', source: 'CODE' }),
      expect.objectContaining({ client: 'PaymentGateway', method: 'POST', path: '/gateway', source: 'CODE' })]));
  });
  it('discovers runtime-only mainframe calls, matching responses and preserving the source contract', async () => {
    const { context } = await fixtureFlow();
    const mainframe = context.externalCalls.find((call) => call.client === 'MainframeClient');
    expect(mainframe).toMatchObject({ method: 'POST', path: '/mainframe/execute', source: 'LOG', status: 200, traceId: 'fixture-trace', spanId: 'mainframe-1', requestId: 'mf-1',
      requestBody: { operation: 'fictional-query', cpf: '[REDACTED]', apiKey: '[REDACTED]' }, responseBody: { result: 'fictional-mainframe', secret: '[REDACTED]' }, bodySource: 'LOG', confidence: 'HIGH' });
    expect(context.externalCalls.find((call) => call.client === 'login')).toMatchObject({ source: 'CODE_AND_LOG', confidence: 'HIGH' });
    expect(context.externalCalls.find((call) => call.client === 'archive')).toMatchObject({ source: 'CODE', bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' });
    expect(context.externalCalls.every((call) => !('body' in call))).toBe(true);
    const serialized = JSON.stringify(context);
    for (const secret of ['fictional-password', 'fictional-auth', 'fictional-token', 'fictional-cookie', 'fictional-key', 'fictional-signature', 'fictional-secret', '123.456.789-00']) expect(serialized).not.toContain(secret);
  });
  it('records runtime metrics and keeps differing concurrent behaviors without guessing', async () => {
    const { context } = await fixtureFlow();
    expect(context.runtimeAnalysis).toEqual({ interactionsFound: 9, uniqueExternalEndpoints: 7, duplicateOccurrencesCollapsed: 1, responseBodiesCaptured: 8, responseBodiesMissing: 1 });
    const repeat = context.externalCalls.find((call) => call.path === '/repeat');
    expect(repeat).toMatchObject({ occurrences: 2, distinctBehaviors: 1, collapseDuplicates: true, confidence: 'HIGH', responseBody: { accepted: true, id: 'fictional' } });
    const conflict = context.externalCalls.find((call) => call.path === '/proposal/status');
    expect(conflict).toMatchObject({ occurrences: 2, distinctBehaviors: 2, conflict: 'VIRTUALIZATION_CONFLICT', confidence: 'REVIEW_REQUIRED' });
    expect(conflict?.behaviors?.map((item) => item.responseBody)).toEqual([{ accepted: true }, { accepted: false }]);
    expect(conflict?.responseBody).toBeUndefined();
    expect(context.externalCalls.find((call) => call.path === '/missing')).toMatchObject({ bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' });
    expect(context.externalCalls.find((call) => call.path === '/orphan')).toMatchObject({ source: 'LOG', confidence: 'REVIEW_REQUIRED', responseBody: { orphan: true } });
  });
  it('writes captured responseBody to EasyPerf, emits one duplicate file and skips conflicts', async () => {
    const { context } = await fixtureFlow();
    const generated = await new VirtualizationGenerator().generate(context, await directory());
    expect(generated.files).toHaveLength(7); expect(generated.errors).toEqual([]); expect(generated.warnings.join('\n')).toContain('VIRTUALIZATION_CONFLICT');
    const mainframe = generated.files.find((file) => file.fileName.startsWith('mainframeclient'));
    expect(mainframe).toBeDefined();
    const value = JSON.parse(await readFile(join(generated.directory, mainframe!.fileName), 'utf8'));
    expect(value.response.body).toEqual({ result: 'fictional-mainframe', secret: '[REDACTED]' });
    const metadata = await readFile(join(generated.directory, '..', 'flow-context.json'), 'utf8');
    expect(metadata).toContain('distinctBehaviors'); expect(metadata).not.toContain('fictional-secret');
    expect(generated.files.filter((file) => file.fileName.startsWith('remoteclient'))).toHaveLength(1);
  });
  it.each([
    ['RestTemplate', 'return http.getForObject(address, String.class);', 'GET'],
    ['RestClient', 'return http.post().uri(address).retrieve().body(String.class);', 'POST'],
    ['WebClient', 'return http.put().uri(address).retrieve().bodyToMono(String.class);', 'PUT'],
    ['HttpClient', 'return http.send(HttpRequest.newBuilder().uri(URI.create(address)).GET().build());', 'GET'],
    ['RestTemplate', 'return http.exchange(address, HttpMethod.DELETE, request, String.class);', 'DELETE'],
  ])('follows Controller → Adapter → %s without class-name-only discovery', async (httpType, expression, method) => {
    const root = await directory();
    await writeFile(join(root, 'Demo.java'), `@RestController class Demo { TransportAdapter adapter; @GetMapping("/flow") String run() { return adapter.invoke(); } } class TransportAdapter { ${httpType} http; @Value("\u0024{remote.url}") String address; String invoke() { ${expression} } }`);
    await writeFile(join(root, 'application.properties'), 'remote.url=${HOST:https://transport.example.test/remote}\n');
    const calls = findCodeCalls(await analyzeRepository(root), { method: 'GET', path: '/flow' });
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ method, path: '/remote', source: 'CODE', client: 'TransportAdapter' });
  });
  it('ignores Client/Gateway names and URL configuration without an HTTP operation', async () => {
    const root = await directory();
    await writeFile(join(root, 'Demo.java'), '@RestController class Demo { FakeClient client; @GetMapping("/flow") String run() { return client.read(); } } class FakeClient { String url="https://fictional.example.test"; String read() { return url; } }');
    expect(findCodeCalls(await analyzeRepository(root), { method: 'GET', path: '/flow' })).toEqual([]);
  });
  it('rejects ambiguous and cyclic property chains instead of assuming a host', async () => {
    const repository = await analyzeRepository('examples/integrations-fixture/app');
    repository.configurationFiles = [{ filePath: 'application.properties', format: 'properties', content: 'a=${b}\nb=${a}\nu=https://one.example.test\nu=https://two.example.test' }];
    const resolve = configurationReferences(repository);
    expect(resolve('${a}')).toBeUndefined(); expect(resolve('${u}')).toBeUndefined(); expect(resolve('${MISSING:https://default.example.test}')).toBe('https://default.example.test');
  });
});
describe('HTTP occurrence correlation', () => {
  it.each(['spanId', 'requestId', 'correlationId'])('isolates two simultaneous calls with traceId + %s', (identifier) => {
    const { calls } = reconstruct([
      `traceId=t ${identifier}=a API REQUEST POST https://fictional.test/a`, `traceId=t ${identifier}=b API REQUEST POST https://fictional.test/b`,
      `traceId=t ${identifier}=b API REQUEST BODY: {"request":"b"}`, `traceId=t ${identifier}=a API REQUEST BODY: {"request":"a"}`,
      `traceId=t ${identifier}=b API RESPONSE status=201`, `traceId=t ${identifier}=a API RESPONSE status=200`,
      `traceId=t ${identifier}=b API RESPONSE BODY: {"response":"b"}`, `traceId=t ${identifier}=a API RESPONSE BODY: {"response":"a"}`,
    ]);
    expect(calls).toHaveLength(2); expect(calls[0]).toMatchObject({ status: 200, requestBody: { request: 'a' }, responseBody: { response: 'a' }, confidence: 'HIGH' });
    expect(calls[1]).toMatchObject({ status: 201, requestBody: { request: 'b' }, responseBody: { response: 'b' }, confidence: 'HIGH' });
  });
  it('rejects ambiguous responses and does not fall back from a mismatched request ID', () => {
    const { calls, diagnostics } = reconstruct(['traceId=t requestId=a API REQUEST GET https://fictional.test/a', 'traceId=t requestId=b API REQUEST GET https://fictional.test/b',
      'traceId=t API RESPONSE BODY: {"ambiguous":true}', 'traceId=t requestId=unknown API RESPONSE BODY: {"wrong":true}']);
    expect(calls.every((call) => call.responseBody === undefined && call.confidence === 'REVIEW_REQUIRED')).toBe(true);
    expect(diagnostics.join('\n')).toContain('Ambiguous'); expect(diagnostics.join('\n')).toContain('orphan');
  });
  it('uses client and method/path before temporal fallback', () => {
    const { calls } = reconstruct(['traceId=t client=First API REQUEST GET https://fictional.test/a', 'traceId=t client=Second API REQUEST GET https://fictional.test/b',
      'traceId=t client=First API RESPONSE status=200 responseBody={"a":true}', 'traceId=t API RESPONSE method=GET path=/b status=201 responseBody={"b":true}']);
    expect(calls[0].responseBody).toEqual({ a: true }); expect(calls[1].responseBody).toEqual({ b: true });
  });
  it('uses unique thread/time fallback and rejects stale or cross-thread bodies', () => {
    const { calls } = reconstruct(['2026-10-06T10:00:00Z thread=worker-a API REQUEST GET https://fictional.test/a',
      '2026-10-06T10:00:00Z thread=worker-b API REQUEST GET https://fictional.test/b',
      '2026-10-06T10:00:01Z thread=worker-a API RESPONSE status=200 responseBody={"a":true}',
      '2026-10-06T10:00:30Z thread=worker-b API RESPONSE BODY: {"stale":true}']);
    expect(calls[0].responseBody).toEqual({ a: true }); expect(calls[1].responseBody).toBeUndefined();
  });
  it('captures separate multiline request and response JSON without exposing secrets', () => {
    const { calls } = reconstruct(['traceId=t spanId=a API REQUEST POST https://fictional.test/a', 'traceId=t spanId=a API REQUEST BODY:', '{', '"password":"fictional-password",', '"ordinary":true', '}',
      'traceId=t spanId=a API RESPONSE status=200', 'traceId=t spanId=a API RESPONSE BODY:', '{', '"cpf":"123.456.789-00",', '"ordinary":true', '}']);
    expect(calls[0]).toMatchObject({ requestBody: { password: '[REDACTED]', ordinary: true }, responseBody: { cpf: '[REDACTED]', ordinary: true }, confidence: 'HIGH' });
  });
  it('supports custom message patterns independently of API markers', () => {
    const runtime = new HttpInteractionReconstructor(); const patterns = { request: /SEND EVENT/, response: /RECEIVE EVENT/ };
    ['traceId=t spanId=a SEND EVENT method=POST URL=https://fictional.test/custom', 'traceId=t spanId=a RECEIVE EVENT status=200 responseBody={"custom":true}'].forEach((line) => runtime.consume(parseLogLine(line, patterns)));
    expect(runtime.finish()[0]).toMatchObject({ source: 'LOG', path: '/custom', responseBody: { custom: true } });
  });
  it('supports configurable body markers and inline multiline starts', () => {
    const runtime = new HttpInteractionReconstructor(); const patterns = { requestBody: /INPUT PAYLOAD/, responseBody: /OUTPUT PAYLOAD/ };
    ['traceId=t spanId=a API REQUEST POST https://fictional.test/custom', 'traceId=t spanId=a INPUT PAYLOAD: {"password":"fictional-secret"}',
      'traceId=t spanId=a API RESPONSE status=200', 'traceId=t spanId=a OUTPUT PAYLOAD: {', '"value":"fictional"', '}'].forEach((line) => runtime.consume(parseLogLine(line, patterns)));
    expect(runtime.finish()[0]).toMatchObject({ requestBody: { password: '[REDACTED]' }, responseBody: { value: 'fictional' }, confidence: 'HIGH' });
  });
  it('never treats HTTP metadata or URLs inside payloads as identity evidence', () => {
    const { calls } = reconstruct(['traceId=t spanId=a API REQUEST POST https://fictional.test/a',
      'traceId=t spanId=a API REQUEST BODY: {"method":"DELETE","url":"https://payload.example.test/wrong","requestId":"wrong"}',
      'traceId=t spanId=a API RESPONSE status=200 responseBody={"method":"GET","url":"https://payload.example.test/other","traceId":"wrong"}']);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ method: 'POST', path: '/a', traceId: 't', spanId: 'a', status: 200, confidence: 'HIGH' });
  });
  it('merges separate request headers into one occurrence and sanitizes both directions', () => {
    const { calls } = reconstruct(['traceId=t requestId=a API REQUEST POST https://fictional.test/a',
      'traceId=t requestId=a API REQUEST requestHeaders={"Authorization":"Bearer fictional-auth","X-API-Key":"fictional-key","Cookie":"fictional-cookie"}',
      'traceId=t requestId=a API RESPONSE status=200 responseHeaders={"X-Signature":"fictional-signature","Set-Cookie":"fictional-cookie"} responseBody={"ok":true}']);
    expect(calls).toHaveLength(1); expect(calls[0].requestHeaders).toEqual({ Authorization: '[REDACTED]', 'X-API-Key': '[REDACTED]', Cookie: '[REDACTED]' });
    expect(calls[0].responseHeaders).toEqual({ 'X-Signature': '[REDACTED]', 'Set-Cookie': '[REDACTED]' });
  });
  it('discards incomplete HTTP identities with a diagnostic instead of inventing endpoints', () => {
    const { calls, diagnostics } = reconstruct(['traceId=t spanId=a API REQUEST BODY: {"fictional":true}', 'traceId=t spanId=a API RESPONSE BODY: {"fictional":true}']);
    expect(calls).toEqual([]); expect(diagnostics.join('\n')).toContain('HTTP method/path not established');
  });
  it('provides a sanitized debug explanation for found, correlated and discarded events', () => {
    const { diagnostics } = reconstruct(['traceId=t requestId=a API REQUEST POST https://fictional.test/a',
      'traceId=t requestId=a API RESPONSE status=200 responseBody={"password":"fictional-debug-secret"}',
      'traceId=t requestId=missing API RESPONSE BODY: {"token":"fictional-debug-token"}']);
    const debug = diagnostics.join('\n'); expect(debug).toContain('Found'); expect(debug).toContain('Correlated'); expect(debug).toContain('Discarded');
    expect(debug).not.toContain('fictional-debug-secret'); expect(debug).not.toContain('fictional-debug-token');
  });
  it('retains differences in requests, status, bodies and hosts as conflicts', () => {
    const base: ExternalCall = { order: 1, method: 'POST', path: '/endpoint/', source: 'LOG', bodySource: 'LOG', confidence: 'HIGH', status: 200, responseBody: { ok: true } };
    for (const difference of [{ requestBody: { changed: true } }, { status: 201 }, { responseBody: { ok: false } }, { url: 'https://other.example.test/endpoint' }]) {
      expect(groupInteractions([base, { ...base, order: 2, path: '/endpoint', ...difference }])[0]).toMatchObject({ occurrences: 2, distinctBehaviors: 2, conflict: 'VIRTUALIZATION_CONFLICT', confidence: 'REVIEW_REQUIRED' });
    }
  });
});
