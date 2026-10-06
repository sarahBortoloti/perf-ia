import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLogLine, analyzeLogs } from '../src/logs/log-parser.js';
import { HttpInteractionReconstructor } from '../src/logs/http-interaction-reconstructor.js';
import { HttpMultilineMachine } from '../src/logs/http-multiline-machine.js';
import { VirtualizationGenerator } from '../src/virtualization/virtualization-generator.js';
import { sanitizeSensitiveData, sanitizeValue } from '../src/security/sensitive-data-sanitizer.js';
import { generateWorkflow } from '../src/cli/commands/generate-workflow.js';
import { analyzeRepository } from '../src/repository/index.js';
import { classifyHttpMarker, normalizeHttpMessage } from '../src/logs/log-event.js';
import { groupInteractions } from '../src/flow/interaction-groups.js';
import { FlowBuilder } from '../src/flow/flow-builder.js';

const temporary: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), 'perf-ai-http-formats-')); temporary.push(root); return root; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(name: string, traceId?: string) {
  const parser = new HttpInteractionReconstructor();
  await analyzeLogs(`examples/http-format-fixture/${name}.log`, traceId, (line) => parser.consume(line));
  return { calls: parser.finish(), metrics: parser.debugMetrics, diagnostics: parser.diagnostics };
}
function envelope(message: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({ message, loggerName: 'com.example.Client', level: 'INFO', timestamp: '2026-10-06T10:00:00Z', sequence: 10, threadName: 'worker', traceId: 't', ...fields });
}
function lines(messages: string[]) { const runtime = new HttpInteractionReconstructor(); messages.forEach((line) => runtime.consume(parseLogLine(line))); return { calls: runtime.finish(), metrics: runtime.debugMetrics, diagnostics: runtime.diagnostics }; }
describe('NDJSON messages', () => {
  it.each([
    ['API REQUEST', 'REQUEST_START'], ['API REQUEST BODY', 'REQUEST_BODY'], ['API REQUEST BODYS', 'REQUEST_BODY'], ['REQUEST BODY', 'REQUEST_BODY'], ['HTTP REQUEST', 'REQUEST_START'],
    ['API RESPONSE', 'RESPONSE_START'], ['API RESPONSE BODY', 'RESPONSE_BODY'], ['API RESPONSE BODYS', 'RESPONSE_BODY'], ['RESPONSE BODY', 'RESPONSE_BODY'], ['HTTP RESPONSE', 'RESPONSE_START'],
  ] as const)('normalizes and classifies %s as %s', (message, type) => {
    expect(classifyHttpMarker(`  ${message.toLowerCase().replaceAll(' ', ' . ')} : `)).toBe(type);
    expect(normalizeHttpMessage(message)).toBe(message);
  });
  it.each(['API RESPONSE BODY', 'API RESPONSE BODYS', 'api response bodys', 'RESPONSE BODY', 'API RESPONSE'])('decodes %s and envelope identifiers before HTTP interpretation', (marker) => {
    const line = parseLogLine(envelope(`${marker}: {"status":"UP","password":"fictional-password"}`, { spanId: 's', requestId: 'r', correlationId: 'c' }));
    expect(line).toMatchObject({ format: 'JSON_LINES', loggerName: 'com.example.Client', level: 'INFO', timestamp: '2026-10-06T10:00:00Z', sequence: 10, thread: 'worker', traceId: 't', spanId: 's', requestId: 'r', correlationId: 'c', responseBody: { status: 'UP', password: '[REDACTED]' } });
    expect(line.http.status).toBeUndefined(); expect(line.text).not.toContain('fictional-password');
  });
  it('parses mixed NDJSON API events and NDJSON-wrapped HTTP dumps', async () => {
    const { calls, metrics } = await fixture('structured');
    expect(calls).toHaveLength(2); expect(calls[0]).toMatchObject({ path: '/api/mainframe', status: 200, responseBody: { result: 'fictional-success', token: '[REDACTED]' }, confidence: 'HIGH' });
    expect(calls[1]).toMatchObject({ path: '/mainframe/proposal', requestBody: { proposal: '123', status: 'ACCEPTED' }, responseBody: { code: '00', result: 'SUCCESS' }, confidence: 'HIGH' });
    expect(metrics).toMatchObject({ formats: ['JSON_LINES', 'HTTP_MULTILINE'], httpBlocksDetected: 1, requestsDetected: 2, responsesDetected: 2, uncorrelatedResponseBodies: 1 });
    expect(JSON.stringify(calls)).not.toContain('"UP"');
  });
  it('never assigns an unscoped health response to the last API request', () => {
    const { calls, metrics } = lines(['API REQUEST POST https://example.test/customer', 'API RESPONSE BODYS: {"status":"UP"}']);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED' }); expect(calls[0].responseBody).toBeUndefined();
    expect(metrics.uncorrelatedResponseBodies).toBe(1);
  });
  it('ignores an unrelated health logger while an HTTP block is open', () => {
    const dump = ['---> POST https://example.test/customer HTTP/1.1', '', '{"request":true}', '---> END HTTP'];
    const events = [...dump.map((message) => envelope(message, { spanId: 'call' })), envelope('API RESPONSE BODYS: {"status":"UP"}', { loggerName: 'HealthCheck', spanId: undefined }),
      ...['<--- 200', '', '{"response":true}', '<--- END HTTP'].map((message) => envelope(message, { spanId: 'call' }))];
    const { calls, metrics } = lines(events);
    expect(calls[0].responseBody).toEqual({ response: true }); expect(metrics.uncorrelatedResponseBodies).toBe(1);
  });
});
describe('HTTP multiline state machine', () => {
  it('reconstructs request headers/body and response headers/body independently', async () => {
    const { calls, metrics } = await fixture('mainframe');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://example.test/mainframe/proposal', path: '/mainframe/proposal', source: 'LOG', status: 200,
      requestBody: { proposal: '123', status: 'ACCEPTED', password: '[REDACTED]' }, responseBody: { code: '00', result: 'SUCCESS', access_token: '[REDACTED]', refresh_token: '[REDACTED]' },
      bodySource: 'LOG', confidence: 'HIGH', attempts: [expect.objectContaining({ order: 1, outcome: 'SUCCESS' })] });
    expect(metrics).toMatchObject({ httpBlocksDetected: 1, requestsDetected: 1, responsesDetected: 1, successfulInteractions: 1, requestBodiesCaptured: 1, responseBodiesCaptured: 1 });
    expect(calls[0].requestHeaders).toMatchObject({ 'api-key': '[REDACTED]', assertion: '[REDACTED]', Authorization: '[REDACTED]', 'Proxy-Authorization': '[REDACTED]', cookie: '[REDACTED]' });
    expect(calls[0].responseHeaders).toMatchObject({ 'set-cookie': '[REDACTED]', 'X-Signature': '[REDACTED]' });
  });
  it('sanitizes headers at ingestion, before finish or persistence', () => {
    const machine = new HttpMultilineMachine();
    ['---> POST https://example.test/a HTTP/1.1', 'api-key: fictional-key', 'assertion: fictional-jwt', 'Authorization: Bearer fictional-auth'].forEach((text) => machine.consume(parseLogLine(text)));
    expect(machine.calls[0].attempts?.[0].requestHeaders).toEqual({ 'api-key': '[REDACTED]', assertion: '[REDACTED]', Authorization: '[REDACTED]' });
    expect(JSON.stringify(machine.calls)).not.toContain('fictional-jwt');
  });
  it('collapses three SSL retries and a fourth successful attempt into one usable interaction', async () => {
    const { calls, metrics } = await fixture('retries');
    expect(calls).toHaveLength(1); expect(calls[0].attempts).toHaveLength(4);
    expect(calls[0].attempts?.map((attempt) => attempt.outcome)).toEqual(['ERROR', 'ERROR', 'ERROR', 'SUCCESS']);
    expect(calls[0].attempts?.[0].error).toContain('SSLHandshakeException');
    expect(calls[0]).toMatchObject({ responseBody: { login: 'fictional-success' }, status: 200, confidence: 'HIGH' });
    expect(metrics).toMatchObject({ requestsDetected: 4, responsesDetected: 1, errorsDetected: 3, retriesDetected: 3, interactionsReconstructed: 1, successfulInteractions: 1 });
    const output = await new VirtualizationGenerator().generate({ application: 'fictional', flow: 'retry', entrypoint: { method: 'POST', path: '/entry' }, externalCalls: calls }, await directory());
    expect(output.files).toHaveLength(1); expect(output.warnings).toEqual([]);
    const saved = JSON.parse(await readFile(join(output.directory, '..', 'flow-context.json'), 'utf8'));
    expect(saved.externalCalls[0].attempts).toHaveLength(4);
  });
  it('records failed-only retries without inventing a response or generating a virtualization', async () => {
    const { calls, metrics } = await fixture('failed-retries');
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ confidence: 'REVIEW_REQUIRED', virtualizationStatus: 'NO_SUCCESSFUL_RESPONSE', bodySource: 'EMPTY' });
    expect(calls[0].status).toBeUndefined(); expect(calls[0].responseBody).toBeUndefined();
    expect(metrics).toMatchObject({ errorsDetected: 2, retriesDetected: 1, failedOnlyInteractions: 1, successfulInteractions: 0 });
    const output = await new VirtualizationGenerator().generate({ application: 'fictional', flow: 'failed', entrypoint: { method: 'POST', path: '/entry' }, externalCalls: calls }, await directory());
    expect(output.files).toEqual([]); expect(output.errors).toEqual([]); expect(output.warnings.join('\n')).toContain('NO_SUCCESSFUL_RESPONSE');
  });
  it('preserves non-JSON bodies as sanitized strings until their block terminators', () => {
    const { calls } = lines(['---> POST https://example.test/a HTTP/1.1', 'Content-Type: text/plain', '', 'hello fictional-user', '---> END HTTP',
      '<--- 200', 'Content-Type: text/plain', '', 'password=fictional-secret', 'fictional-response', '<--- END HTTP']);
    expect(calls[0].requestBody).toBe('hello fictional-user'); expect(calls[0].responseBody).toBe('password=[REDACTED]\nfictional-response');
    expect(calls[0].confidence).toBe('HIGH');
  });
  it('writes responseBody to EasyPerf, never requestBody', async () => {
    const { calls } = lines(['---> POST https://example.test/mainframe/proposal HTTP/1.1', 'Content-Type: application/json', '', '{"proposal":"123","status":"ACCEPTED"}', '---> END HTTP',
      '<--- 200', 'Content-Type: application/json', '', '{"code":"00","result":"SUCCESS"}', '<--- END HTTP']);
    const output = await new VirtualizationGenerator().generate({ application: 'fictional', flow: 'mainframe', entrypoint: { method: 'POST', path: '/entry' }, externalCalls: calls }, await directory());
    expect(JSON.parse(await readFile(join(output.directory, output.files[0].fileName), 'utf8'))).toEqual({ response: { metodo: 'POST', path: '/mainframe/proposal', status: 200, header: { 'Content-Type': 'application/json' }, body: { code: '00', result: 'SUCCESS' } } });
  });
  it.each(['spanId', 'requestId', 'threadName'])('isolates concurrent NDJSON HTTP blocks with %s', (key) => {
    const metaA = { [key]: 'a' }, metaB = { [key]: 'b' };
    const events = [envelope('---> POST https://example.test/a HTTP/1.1', metaA), envelope('---> POST https://example.test/b HTTP/1.1', metaB),
      envelope('', metaB), envelope('{"request":"b"}', metaB), envelope('---> END HTTP', metaB), envelope('', metaA), envelope('{"request":"a"}', metaA), envelope('---> END HTTP', metaA),
      envelope('<--- 201', metaB), envelope('', metaB), envelope('{"response":"b"}', metaB), envelope('<--- END HTTP', metaB),
      envelope('<--- 200', metaA), envelope('', metaA), envelope('{"response":"a"}', metaA), envelope('<--- END HTTP', metaA)];
    const { calls } = lines(events);
    expect(calls).toHaveLength(2); expect(calls[0]).toMatchObject({ status: 200, requestBody: { request: 'a' }, responseBody: { response: 'a' }, confidence: 'HIGH' });
    expect(calls[1]).toMatchObject({ status: 201, requestBody: { request: 'b' }, responseBody: { response: 'b' }, confidence: 'HIGH' });
  });
  it('marks unidentifiable concurrent blocks for review instead of assigning a body', () => {
    const { calls, metrics } = lines(['---> POST https://example.test/a HTTP/1.1', '---> POST https://example.test/b HTTP/1.1', '<--- 200', '', '{"ambiguous":true}', '<--- END HTTP']);
    expect(calls.every((call) => call.responseBody === undefined && call.confidence === 'REVIEW_REQUIRED')).toBe(true);
    expect(metrics.uncorrelatedResponseBodies).toBe(1);
  });
  it('does not consider an unterminated response a confirmed success', () => {
    const { calls } = lines(['---> GET https://example.test/a HTTP/1.1', '---> END HTTP', '<--- 200', '', '{"incomplete":true}']);
    expect(calls[0]).toMatchObject({ virtualizationStatus: 'NO_SUCCESSFUL_RESPONSE', confidence: 'REVIEW_REQUIRED' }); expect(calls[0].responseBody).toBeUndefined();
  });
  it('streams raw HTTP headers, blank lines and text bodies with a trace filter', async () => {
    const root = await directory(); const file = join(root, 'trace.log');
    await writeFile(file, 'traceId=t ---> POST https://example.test/a HTTP/1.1\nContent-Type: text/plain\n\nfictional request\n---> END HTTP\n<--- 200\nContent-Type: text/plain\n\nfictional response\n<--- END HTTP\n');
    const runtime = new HttpInteractionReconstructor(); await analyzeLogs(file, 't', (line) => runtime.consume(line));
    expect(runtime.finish()[0]).toMatchObject({ requestBody: 'fictional request', responseBody: 'fictional response', confidence: 'HIGH' });
  });
  it('keeps NDJSON header/body continuations scoped when only the request has a trace ID', async () => {
    const root = await directory(); const file = join(root, 'scope.log');
    const messages = ['---> POST https://example.test/a HTTP/1.1', 'Content-Type: application/json', '', '{"request":true}', '---> END HTTP', '<--- 200', '', '{"response":true}', '<--- END HTTP'];
    await writeFile(file, messages.map((message, index) => envelope(message, index === 0 ? {} : { traceId: undefined })).join('\n'));
    const runtime = new HttpInteractionReconstructor(); await analyzeLogs(file, 't', (line) => runtime.consume(line));
    expect(runtime.finish()[0]).toMatchObject({ responseBody: { response: true }, confidence: 'HIGH' });
  });
  it('bounds HTTP body buffers and requires review on overflow', () => {
    const { calls } = lines(['---> POST https://example.test/a HTTP/1.1', '', 'x'.repeat(1024 * 1024 + 1), '---> END HTTP', '<--- 200', '', '{"ok":true}', '<--- END HTTP']);
    expect(calls[0].requestBody).toBeUndefined(); expect(calls[0].confidence).toBe('REVIEW_REQUIRED'); expect(calls[0].reviewReasons?.join('\n')).toContain('1 MiB');
  });
  it('collapses five equivalent endpoint occurrences into one behavior', () => {
    const messages: string[] = [];
    for (let index = 1; index <= 5; index++) messages.push(`traceId=t requestId=r${index} API REQUEST GET https://example.test/repeated`,
      `traceId=t requestId=r${index} API RESPONSE status=200 responseBody={"ok":true}`);
    const calls = groupInteractions(lines(messages).calls);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ occurrences: 5, distinctBehaviors: 1, collapseDuplicates: true, responseBody: { ok: true } });
  });
  it('keeps two semantic responses as a virtualization conflict', () => {
    const calls = groupInteractions(lines(['requestId=a API REQUEST GET https://example.test/conflict', 'requestId=a API RESPONSE status=200 responseBody={"value":"a"}',
      'requestId=b API REQUEST GET https://example.test/conflict', 'requestId=b API RESPONSE status=200 responseBody={"value":"b"}']).calls);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ occurrences: 2, distinctBehaviors: 2, conflict: 'VIRTUALIZATION_CONFLICT', confidence: 'REVIEW_REQUIRED' });
  });
  it('ignores Kafka records in a mixed JSON Lines and HTTP multiline stream', () => {
    const events = [envelope('Kafka consumer received topic=fictional payload={"event":"ignored"}', { loggerName: 'org.example.KafkaConsumer' }),
      envelope('API REQUEST method=GET URL=https://example.test/json', { requestId: 'json' }), envelope('API RESPONSE status=200 responseBody={"json":true}', { requestId: 'json' }),
      '---> GET https://example.test/multiline HTTP/1.1', '---> END HTTP', '<--- 200', '', '{"multiline":true}', '<--- END HTTP'];
    const result = lines(events);
    expect(result.calls.map((call) => call.path)).toEqual(['/json', '/multiline']);
    expect(JSON.stringify(result.calls)).not.toContain('Kafka');
  });
});
describe('security and debug', () => {
  it.each(['api-key', 'assertion', 'Authorization', 'Proxy-Authorization', 'cookie', 'set-cookie', 'X-Signature', 'token', 'access_token', 'refresh_token'])('sanitizes %s in text and structured values', (key) => {
    expect(sanitizeSensitiveData(`${key}: fictional-secret`)).not.toContain('fictional-secret');
    expect(sanitizeValue({ [key]: 'fictional-secret' })).toEqual({ [key]: '[REDACTED]' });
  });
  it('shows format/counters in --debug and never dumps payloads or credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); const root = await directory();
    await generateWorkflow({ application: 'fictional', flow: 'formats', repository: await analyzeRepository('examples/spring-app'),
      entrypoint: { method: 'GET', path: '/products' }, logPath: 'examples/http-format-fixture/structured.log', outputRoot: root, debug: true });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Log format: JSON_LINES + HTTP_MULTILINE');
    for (const counter of ['Lines read: 17', 'JSON lines parsed: 17', 'Text lines parsed: 0', 'HTTP event candidates: 17', 'Request starts: 2', 'Request bodies: 2', 'Response starts: 2', 'Response bodies: 2', 'Errors: 0', 'Retries: 0', 'Interactions reconstructed: 2', 'Successful interactions: 2', 'Failed interactions: 0', 'Uncorrelated requests: 0', 'Uncorrelated responses: 1', 'Unique external endpoints: 2', 'Duplicates collapsed: 0', 'Conflicting behaviors: 0']) expect(output).toContain(counter);
    for (const secret of ['fictional-api-key', 'fictional-response-token', 'fictional-signature', '123.456.789-00', '"code":"00"']) expect(output).not.toContain(secret);
  });
  it('warns when HTTP evidence cannot produce an interaction', async () => {
    const root = await directory(); const file = join(root, 'unreconstructed.log');
    await writeFile(file, 'API REQUEST BODY: {"value":"orphan"}\nAPI RESPONSE BODYS: {"status":"UP"}\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await generateWorkflow({ application: 'fictional', flow: 'warning', repository: await analyzeRepository('examples/spring-app'),
      entrypoint: { method: 'GET', path: '/products' }, logPath: file, outputRoot: root, debug: true });
    expect(output.mock.calls.flat().join('\n')).toContain('HTTP evidence was found in the log, but no interaction could be reconstructed.');
  });
});

describe('local external HTTP pipeline', () => {
  it('runs repository → events → interaction → FlowContext → final EasyPerf JSON', async () => {
    const root = await directory();
    await writeFile(join(root, 'JourneyController.java'), '@RestController class JourneyController { JourneyService service; @PostMapping("/journey") String run() { return service.run(); } }');
    await writeFile(join(root, 'JourneyService.java'), '@Service class JourneyService { ProposalAdapter adapter; String run() { return adapter.send(); } }');
    await writeFile(join(root, 'ProposalAdapter.java'), 'class ProposalAdapter { RestTemplate http; @Value("${proposal.url}") String url; String send() { return http.postForObject(url, "fictional", String.class); } }');
    await writeFile(join(root, 'application.properties'), 'proposal.url=https://external.example.test/proposal\n');
    const logPath = join(root, 'journey.log');
    const external = { traceId: 'e2e', spanId: 'external', loggerName: 'ProposalAdapter' };
    await writeFile(logPath, ['traceId=e2e HTTP POST /journey',
      ...['---> POST https://external.example.test/proposal HTTP/1.1', 'Content-Type: application/json', '', '{"proposal":"fictional-123"}',
        '---> END HTTP', '<--- 200', 'Content-Type: application/json', '', '{"code":"00","result":"SUCCESS"}', '<--- END HTTP']
        .map((message) => envelope(message, external))].join('\n'));
    const repository = await analyzeRepository(root);
    const built = await new FlowBuilder().build({ application: 'journey', flow: 'accept', repository, entrypoint: { method: 'POST', path: '/journey' }, logPath, traceId: 'e2e' });
    expect(built.context.externalCalls).toHaveLength(1);
    expect(built.context.externalCalls[0]).toMatchObject({ source: 'CODE_AND_LOG', method: 'POST', path: '/proposal', requestBody: { proposal: 'fictional-123' }, status: 200,
      responseBody: { code: '00', result: 'SUCCESS' }, confidence: 'HIGH' });
    const generated = await new VirtualizationGenerator().generate(built.context, join(root, 'output'));
    expect(generated.files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(generated.directory, generated.files[0].fileName), 'utf8'))).toEqual({ response: {
      metodo: 'POST', path: '/proposal', status: 200, header: { 'Content-Type': 'application/json' }, body: { code: '00', result: 'SUCCESS' },
    } });
  });
});
