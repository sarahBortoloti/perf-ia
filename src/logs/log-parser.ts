import { sanitizeSensitiveData, sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import { readLogLines } from './log-reader.js';
import { extractTraceIdentifiers, type TraceIdentifiers } from './trace-extractor.js';
import { extractHttpCall, extractHttpDetails, type HttpCall } from './http-call-extractor.js';
import { extractResponse } from './response-extractor.js';
import { classifyHttpMarker, classifyLogEvent, isHttpEventCandidate } from './log-event.js';

export interface ParsedLogLine extends TraceIdentifiers {
  text: string;
  format?: 'JSON_LINES';
  loggerName?: string;
  level?: string;
  sequence?: number;
  timestamp?: string;
  http: HttpCall;
  httpCall?: HttpCall;
  exception?: string;
  relevant: boolean;
  clientName?: string;
  clientMethod?: string;
  requestId?: string;
  thread?: string;
  event?: 'REQUEST' | 'REQUEST_BODY' | 'RESPONSE' | 'RESPONSE_BODY';
  requestBody?: unknown;
  requestHeaders?: Record<string, unknown>;
  bodyFragment?: string;
  responseBody?: unknown;
  responseHeaders?: Record<string, unknown>;
  payload?: unknown;
  jsonFragment?: string;
}
export interface LogAnalysis {
  linesProcessed: number;
  relevantLines: number;
  traceIdsFound: number;
  httpCallsFound: number;
  externalHttpCallsFound: number;
  contextReduction: number;
  jsonLinesParsed: number;
  textLinesParsed: number;
  httpEventCandidates: number;
}

export interface LogPatterns {
  request?: RegExp; requestBody?: RegExp; response?: RegExp; responseBody?: RegExp;
}
/** Decode NDJSON before interpreting message so escaped bodies become actual JSON. */
export function parseLogLine(input: string, patterns: LogPatterns = {}): ParsedLogLine {
  let envelope: unknown;
  try { envelope = JSON.parse(input); } catch { /* Plain text or a multiline fragment. */ }
  if (envelope && typeof envelope === 'object' && 'message' in envelope && typeof envelope.message === 'string') {
    const fields = Object.fromEntries(Object.entries(envelope));
    const line = parseTextLine(envelope.message, patterns);
    const string = (key: string): string | undefined => typeof fields[key] === 'string' ? sanitizeSensitiveData(fields[key]) : undefined;
    line.format = 'JSON_LINES'; line.loggerName = string('loggerName'); line.level = string('level');
    line.timestamp = string('timestamp') ?? line.timestamp;
    line.sequence = typeof fields.sequence === 'number' ? fields.sequence : undefined;
    line.thread = string('threadName') ?? line.thread;
    for (const key of ['traceId', 'spanId', 'requestId', 'correlationId'] as const) line[key] = string(key) ?? line[key];
    line.relevant ||= Boolean(line.traceId || line.spanId || line.requestId || line.correlationId);
    return line;
  }
  return parseTextLine(input, patterns);
}
function parseTextLine(input: string, patterns: LogPatterns = {}): ParsedLogLine {
  const text = sanitizeSensitiveData(input);
  // Metadata inside payloads is data, never HTTP/trace identity evidence.
  const metadata = text.split(/\b(?:request|response)[-_ ]?(?:bodys?|headers)["']?\s*[:=-]/i)[0];
  const identifiers = extractTraceIdentifiers(metadata);
  const timestamp = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/.exec(text)?.[0];
  const http = extractHttpDetails(metadata);
  const httpCall = extractHttpCall(metadata);
  const exception = /\b(?:[\w$]+\.)*[\w$]*(?:Exception|Error)\b(?:[^\r\n]*)/.exec(text)?.[0];
  const response = extractResponse(input);
  const clientIdentity = /\[([\w.$]+)#([\w$]+)(?:\([^\]]*\))?\]/.exec(metadata);
  const requestId = /\brequest[-_]?id["']?\s*[:=]\s*["']?([\w.-]+)/i.exec(metadata)?.[1];
  const clientName = clientIdentity?.[1] ?? /\b(?:client|integration|gateway|adapter)["']?\s*[:=]\s*["']?([\w.$-]+)/i.exec(metadata)?.[1]
    ?? /\[([\w.$]*(?:Client|Gateway|Adapter))\]/.exec(metadata)?.[1];
  const thread = /\bthread["']?\s*[:=]\s*["']?([\w.-]+)/i.exec(text)?.[1] ?? /\[([\w-]*(?:exec|thread|pool)[\w-]*)\]/i.exec(text)?.[1];
  const matches = (pattern: RegExp): boolean => { pattern.lastIndex = 0; return pattern.test(text); };
  const classified = classifyHttpMarker(text);
  const event = matches(patterns.responseBody ?? /\bresponse[-_ .:-]*bodys?\b/i) || classified === 'RESPONSE_BODY' ? 'RESPONSE_BODY'
    : matches(patterns.requestBody ?? /\brequest[-_ .:-]*bodys?\b/i) || classified === 'REQUEST_BODY' ? 'REQUEST_BODY'
    : matches(patterns.response ?? /\b(?:API|HTTP)[ _.-]+RESPONSE\b|<---/i) || classified === 'RESPONSE_START' ? 'RESPONSE'
    : matches(patterns.request ?? /\b(?:API|HTTP)[ _.-]+REQUEST\b|--->/i) || classified === 'REQUEST_START' ? 'REQUEST' : undefined;
  let bodyFragment: string | undefined;
  const apiResponsePayload = /\b(?:API|HTTP)[ _.-]+RESPONSE\s*:\s*(?=[{["<])/i.test(text);
  if (event === 'REQUEST_BODY' || event === 'RESPONSE_BODY' || apiResponsePayload) {
    const marker = event === 'REQUEST_BODY' ? patterns.requestBody ?? /\brequest[-_ .:-]*bodys?\b/i : apiResponsePayload ? /\b(?:API|HTTP)[ _.-]+RESPONSE\b/i : patterns.responseBody ?? /\bresponse[-_ .:-]*bodys?\b/i;
    marker.lastIndex = 0;
    const match = marker.exec(text);
    const tail = match ? text.slice(match.index + match[0].length).replace(/^["']?\s*[:=-]?\s*/, '') : '';
    const key = event === 'REQUEST_BODY' ? 'requestBody' : 'responseBody';
    if (response[key] === undefined && tail) {
      try { response[key] = sanitizeValue(JSON.parse(tail)); }
      catch { if (/^[{[]/.test(tail)) bodyFragment = tail; else response[key] = sanitizeValue(tail); }
    }
  }
  const jsonFragment = !timestamp && !identifiers.traceId && /^\s*(?:\{|\}|\[|\]|"|true\b|false\b|null\b|\d)/.test(text) ? text : undefined;
  return {
    text, ...identifiers, timestamp, http, httpCall, exception,
    ...response, clientName, clientMethod: clientIdentity?.[2], requestId, thread, event, jsonFragment, bodyFragment,
    relevant: Boolean(identifiers.traceId || identifiers.correlationId || httpCall || http.status || http.durationMs !== undefined || http.client || exception || event || response.requestBody !== undefined || response.responseBody !== undefined || response.responseHeaders),
  };
}

/** Aggregate only counters and distinct trace IDs, never the file or its records. */
export async function analyzeLogs(filePath: string, traceId?: string, onRelevantLine?: (line: ParsedLogLine) => void, patterns?: LogPatterns): Promise<LogAnalysis> {
  const metrics: LogAnalysis = { linesProcessed: 0, relevantLines: 0, traceIdsFound: 0, httpCallsFound: 0, externalHttpCallsFound: 0, contextReduction: 0,
    jsonLinesParsed: 0, textLinesParsed: 0, httpEventCandidates: 0 };
  const traces = new Set<string>();
  let selectedContinuation = false;
  let selectedHttpDump: boolean = false;
  const dumpScopes: ParsedLogLine[] = [];
  for await (const rawLine of readLogLines(filePath)) {
    metrics.linesProcessed++;
    const line = parseLogLine(rawLine, patterns);
    if (line.format === 'JSON_LINES') metrics.jsonLinesParsed++; else metrics.textLinesParsed++;
    if (line.traceId) traces.add(line.traceId);
    const continuation: boolean = !line.traceId && !line.timestamp && (selectedHttpDump || /^\s*(?:at\s|Caused by:|Suppressed:|\.\.\. \d+ more)/.test(line.text) || line.payload !== undefined || line.jsonFragment !== undefined || line.event !== undefined || /^\s*$|^\s*[\w-]+:\s*/.test(line.text));
    const scopedContinuation = dumpScopes.some((scope) => {
      const keys = ['traceId', 'spanId', 'requestId', 'correlationId', 'loggerName', 'thread'] as const;
      return keys.some((key) => line[key] !== undefined) && keys.every((key) => line[key] === undefined || line[key] === scope[key]);
    });
    const selected: boolean = traceId === undefined ? line.relevant || scopedContinuation || (selectedContinuation && continuation) : line.traceId === traceId || scopedContinuation || (selectedContinuation && continuation);
    if (!continuation || line.httpCall) selectedContinuation = selected;
    if (/--->\s+\w+\s+https?:\/\/\S+\s+HTTP\//i.test(line.text)) {
      selectedHttpDump = selected;
      if (selected) dumpScopes.push(line);
    }
    if (!selected) continue;
    const event = classifyLogEvent(line);
    if (isHttpEventCandidate(event) || selectedHttpDump) metrics.httpEventCandidates++;
    metrics.relevantLines++;
    onRelevantLine?.(line);
    if (/<---\s+END HTTP/i.test(line.text)) {
      selectedHttpDump = false;
      const keys = ['traceId', 'spanId', 'requestId', 'correlationId', 'loggerName', 'thread'] as const;
      const matching = dumpScopes.map((scope, index) => ({ scope, index })).filter(({ scope }) => keys.every((key) => !line[key] || line[key] === scope[key]));
      if (matching.length === 1) dumpScopes.splice(matching[0].index, 1);
    }
    if (line.httpCall) {
      metrics.httpCallsFound++;
      if (line.httpCall.external) metrics.externalHttpCallsFound++;
    }
  }
  metrics.traceIdsFound = traces.size;
  metrics.contextReduction = metrics.linesProcessed === 0 ? 0 : Number(((1 - metrics.relevantLines / metrics.linesProcessed) * 100).toFixed(2));
  return metrics;
}
