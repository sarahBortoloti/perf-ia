import { sanitizeSensitiveData, sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import { readLogLines } from './log-reader.js';
import { extractTraceIdentifiers, type TraceIdentifiers } from './trace-extractor.js';
import { extractHttpCall, extractHttpDetails, type HttpCall } from './http-call-extractor.js';
import { extractResponse } from './response-extractor.js';

export interface ParsedLogLine extends TraceIdentifiers {
  text: string;
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
}

export interface LogPatterns {
  request?: RegExp; requestBody?: RegExp; response?: RegExp; responseBody?: RegExp;
}
export function parseLogLine(input: string, patterns: LogPatterns = {}): ParsedLogLine {
  const text = sanitizeSensitiveData(input);
  // Metadata inside payloads is data, never HTTP/trace identity evidence.
  const metadata = text.split(/\b(?:request|response)[-_ ]?(?:body|headers)["']?\s*[:=-]/i)[0];
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
  const event = matches(patterns.responseBody ?? /\bresponse[-_ ]?body\b/i) ? 'RESPONSE_BODY'
    : matches(patterns.requestBody ?? /\brequest[-_ ]?body\b/i) ? 'REQUEST_BODY'
    : matches(patterns.response ?? /\b(?:API[ _-]+RESPONSE|response)\b|<---/i) ? 'RESPONSE'
    : matches(patterns.request ?? /\bAPI[ _-]+REQUEST\b|--->/i) ? 'REQUEST' : undefined;
  let bodyFragment: string | undefined;
  if (event === 'REQUEST_BODY' || event === 'RESPONSE_BODY') {
    const marker = event === 'REQUEST_BODY' ? patterns.requestBody ?? /\brequest[-_ ]?body\b/i : patterns.responseBody ?? /\bresponse[-_ ]?body\b/i;
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
  const metrics: LogAnalysis = { linesProcessed: 0, relevantLines: 0, traceIdsFound: 0, httpCallsFound: 0, externalHttpCallsFound: 0, contextReduction: 0 };
  const traces = new Set<string>();
  let selectedContinuation = false;
  for await (const rawLine of readLogLines(filePath)) {
    metrics.linesProcessed++;
    const line = parseLogLine(rawLine, patterns);
    if (line.traceId) traces.add(line.traceId);
    const continuation = !line.traceId && !line.timestamp && (/^\s*(?:at\s|Caused by:|Suppressed:|\.\.\. \d+ more)/.test(line.text) || line.payload !== undefined || line.jsonFragment !== undefined || line.event !== undefined);
    const selected: boolean = traceId === undefined ? line.relevant || (selectedContinuation && continuation) : line.traceId === traceId || (selectedContinuation && continuation);
    if (!continuation) selectedContinuation = selected;
    if (!selected) continue;
    metrics.relevantLines++;
    onRelevantLine?.(line);
    if (line.httpCall) {
      metrics.httpCallsFound++;
      if (line.httpCall.external) metrics.externalHttpCallsFound++;
    }
  }
  metrics.traceIdsFound = traces.size;
  metrics.contextReduction = metrics.linesProcessed === 0 ? 0 : Number(((1 - metrics.relevantLines / metrics.linesProcessed) * 100).toFixed(2));
  return metrics;
}
