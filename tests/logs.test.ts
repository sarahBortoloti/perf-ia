import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLogLines } from '../src/logs/log-reader.js';
import { parseLogLine, analyzeLogs } from '../src/logs/log-parser.js';
import { extractTraceIdentifiers } from '../src/logs/trace-extractor.js';
import { extractHttpCall, extractHttpDetails } from '../src/logs/http-call-extractor.js';
import { sanitizeSensitiveData } from '../src/security/sensitive-data-sanitizer.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(() => { throw new Error('Whole-file reads are forbidden in log analysis'); }) };
});

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(temporary.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
async function fixture(content: string, name = 'test.log'): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'perf-ai-logs-'));
  temporary.push(directory);
  const path = join(directory, name);
  await fs.writeFile(path, content);
  return path;
}

async function collect(path: string): Promise<string[]> {
  const result = [];
  for await (const line of readLogLines(path)) result.push(line);
  return result;
}

describe('log reader', () => {
  it.each(['sample.txt', 'sample.log', 'sample.LOG'])('streams %s with CRLF, blank lines and a final unterminated line', async (name) => {
    const path = await fixture('first\r\n\r\nlast', name);
    const readFile = vi.mocked(fs.readFile);
    expect(await collect(path)).toEqual(['first', '', 'last']);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('allows early termination and subsequent reads', async () => {
    const path = await fixture('a\nb\nc\n');
    for await (const line of readLogLines(path)) { expect(line).toBe('a'); break; }
    expect(await collect(path)).toEqual(['a', 'b', 'c']);
  });

  it('handles empty files and rejects invalid extensions, missing files and directories', async () => {
    const empty = await fixture('');
    expect(await collect(empty)).toEqual([]);
    await expect(collect(await fixture('a', 'invalid.json'))).rejects.toThrow('.txt or .log');
    await expect(collect(join(tmpdir(), 'perf-ai-missing-file.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    const dir = join(temporary[0], 'directory.log');
    await fs.mkdir(dir);
    await expect(collect(dir)).rejects.toThrow('must be a file');
  });

  it('processes many lines without whole-file reads', async () => {
    const path = await fixture('unrelated maintenance\n'.repeat(20000));
    const readFile = vi.mocked(fs.readFile);
    expect(await analyzeLogs(path)).toMatchObject({ linesProcessed: 20000, relevantLines: 0, contextReduction: 100 });
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('trace extractor', () => {
  it.each([
    ['traceId=trace-123 correlationId=c-1', 'trace-123', 'c-1'],
    ['{"trace_id":"trace-123","correlation-id":"c-1"}', 'trace-123', 'c-1'],
    ['[trace-id: trace-123] X-Correlation-Id: c-1', 'trace-123', 'c-1'],
    ['X-B3-TraceId: abc123', 'abc123', undefined],
    ['traceparent=00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', '0123456789abcdef0123456789abcdef', undefined],
  ])('extracts identifiers from %s', (line, traceId, correlationId) => {
    expect(extractTraceIdentifiers(line)).toEqual({ traceId, correlationId, spanId: line.startsWith('traceparent=') ? '0123456789abcdef' : undefined });
  });
  it('does not guess identifiers from ordinary messages', () => {
    expect(extractTraceIdentifiers('message mentions trace-123')).toEqual({ traceId: undefined, correlationId: undefined });
  });
});

describe('HTTP call extractor', () => {
  it.each(['Feign', 'RestTemplate', 'WebClient'])('detects external %s requests and metadata', (client) => {
    expect(extractHttpCall(`${client} POST https://remote.example.test/api/items?q=1 status=200 duration=1.5s`)).toEqual({
      method: 'POST', url: 'https://remote.example.test/api/items?q=1', path: '/api/items', status: 200, durationMs: 1500, client, external: true,
    });
  });
  it('recognizes Feign debug request and response without double counting', () => {
    expect(extractHttpCall('[InventoryClient#list] ---> GET /inventory')).toMatchObject({ client: 'Feign', path: '/inventory', external: true });
    const response = '[InventoryClient#list] <--- HTTP/1.1 200 OK (24ms)';
    expect(extractHttpDetails(response)).toMatchObject({ status: 200, durationMs: 24, client: 'Feign' });
    expect(extractHttpCall(response)).toBeUndefined();
  });
  it('distinguishes relative inbound paths and accepts structured HTTP fields', () => {
    expect(extractHttpCall('HTTP GET /products')).toMatchObject({ method: 'GET', path: '/products', external: false });
    expect(extractHttpCall('{"method":"PUT","path":"/products/1","statusCode":201,"durationMs":5}')).toMatchObject({ method: 'PUT', path: '/products/1', status: 201, durationMs: 5 });
    expect(extractHttpCall('maintenance completed')).toBeUndefined();
  });
  it('sanitizes sensitive URLs before returning them', () => {
    const call = extractHttpCall('WebClient GET https://remote.test/items?api_key=fake-key&password=fake-password');
    expect(JSON.stringify(call)).not.toContain('fake-key');
    expect(JSON.stringify(call)).not.toContain('fake-password');
  });
});

describe('sensitive data sanitizer', () => {
  it.each([
    ['Authorization: Bearer fake-authorization', 'fake-authorization'],
    ['{"Authorization":"Bearer fake-json-token"}', 'fake-json-token'],
    ['Authorization=Basic fake-basic-token', 'fake-basic-token'],
    ['Bearer fake-standalone-token', 'fake-standalone-token'],
    ['X-API-Key: fake-api-key', 'fake-api-key'],
    ['apiKey=fake-camel-key', 'fake-camel-key'],
    ['API Key: fake-spaced-key', 'fake-spaced-key'],
    ['Cookie: session=fake-cookie; theme=fake-theme', 'fake-cookie'],
    ['Cookie: first=fake-first, second=fake-second', 'fake-second'],
    ['Set-Cookie: session=fake-set-cookie; HttpOnly', 'fake-set-cookie'],
    ['X-Signature: fake-signature', 'fake-signature'],
    ['{"password":"fake password with spaces"}', 'fake password with spaces'],
    ['client_secret=fake-secret', 'fake-secret'],
    ['secretKey=fake-secret-key', 'fake-secret-key'],
    ['senha=fake-senha', 'fake-senha'],
    ['access_token=fake-access-token', 'fake-access-token'],
    ['refreshToken=fake-refresh-token', 'fake-refresh-token'],
    ['cpf=123.456.789-00', '123.456.789-00'],
    ['cpf=12345678900', '12345678900'],
    ['https://demo:fake-user-password@remote.test/path', 'fake-user-password'],
  ])('masks %s', (input, secret) => {
    expect(sanitizeSensitiveData(input)).not.toContain(secret);
    expect(sanitizeSensitiveData(input)).toContain('[REDACTED]');
  });
  it('preserves useful ordinary metadata and is idempotent', () => {
    const safe = 'traceId=trace-123 GET /items status=200 duration=12ms';
    expect(sanitizeSensitiveData(safe)).toBe(safe);
    const sanitized = sanitizeSensitiveData('Authorization: Bearer fake-value');
    expect(sanitizeSensitiveData(sanitized)).toBe(sanitized);
  });
});

describe('log parser and analysis', () => {
  it('extracts timestamps, exceptions, HTTP metadata and sanitized text', () => {
    const parsed = parseLogLine('2026-10-05T10:00:00.123Z traceId=trace-123 correlationId=c-1 RestTemplate GET https://remote.test/items status=500 duration=10ms java.lang.IllegalStateException: password=fake-password');
    expect(parsed).toMatchObject({ timestamp: '2026-10-05T10:00:00.123Z', traceId: 'trace-123', correlationId: 'c-1', relevant: true });
    expect(parsed.http).toMatchObject({ status: 500, durationMs: 10, client: 'RestTemplate' });
    expect(parsed.exception).toContain('IllegalStateException');
    expect(JSON.stringify(parsed)).not.toContain('fake-password');
    expect(parseLogLine('background maintenance')).toMatchObject({ relevant: false });
  });

  it('analyzes the fictional example with and without a trace filter', async () => {
    const expected = { linesProcessed: 9, relevantLines: 7, traceIdsFound: 1, httpCallsFound: 3, externalHttpCallsFound: 2, contextReduction: 22.22 };
    expect(await analyzeLogs('examples/logs/aceite.log')).toEqual(expected);
    expect(await analyzeLogs('examples/logs/aceite.log', 'trace-123')).toEqual(expected);
  });

  it('isolates exact traces and their stack continuations', async () => {
    const path = await fixture([
      'traceId=trace-123 WebClient GET https://remote.test/selected',
      'traceId=trace-123 java.lang.RuntimeException: failed',
      '  at demo.Service.run(Service.java:12)',
      'traceId=trace-1234 Feign GET https://remote.test/other',
      'traceId=other java.lang.IllegalStateException: failed',
      '  at other.Service.run(Service.java:10)',
      'RestTemplate GET https://remote.test/untagged',
      'irrelevant maintenance',
    ].join('\n'));
    expect(await analyzeLogs(path, 'trace-123')).toEqual({ linesProcessed: 8, relevantLines: 3, traceIdsFound: 3, httpCallsFound: 1, externalHttpCallsFound: 1, contextReduction: 62.5 });
    expect(await analyzeLogs(path, 'missing')).toMatchObject({ relevantLines: 0, httpCallsFound: 0, contextReduction: 100 });
    expect(await analyzeLogs(path)).toMatchObject({ relevantLines: 7, httpCallsFound: 3, externalHttpCallsFound: 3 });
  });

  it('handles empty input without invalid percentages', async () => {
    expect(await analyzeLogs(await fixture(''))).toEqual({ linesProcessed: 0, relevantLines: 0, traceIdsFound: 0, httpCallsFound: 0, externalHttpCallsFound: 0, contextReduction: 0 });
  });
});
