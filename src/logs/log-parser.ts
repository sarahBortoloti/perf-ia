import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';
import { readLogLines } from './log-reader.js';
import { extractTraceIdentifiers, type TraceIdentifiers } from './trace-extractor.js';
import { extractHttpCall, extractHttpDetails, type HttpCall } from './http-call-extractor.js';

export interface ParsedLogLine extends TraceIdentifiers {
  text: string;
  timestamp?: string;
  http: HttpCall;
  httpCall?: HttpCall;
  exception?: string;
  relevant: boolean;
}
export interface LogAnalysis {
  linesProcessed: number;
  relevantLines: number;
  traceIdsFound: number;
  httpCallsFound: number;
  externalHttpCallsFound: number;
  contextReduction: number;
}

export function parseLogLine(input: string): ParsedLogLine {
  const text = sanitizeSensitiveData(input);
  const identifiers = extractTraceIdentifiers(text);
  const timestamp = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/.exec(text)?.[0];
  const http = extractHttpDetails(text);
  const httpCall = extractHttpCall(text);
  const exception = /\b(?:[\w$]+\.)*[\w$]*(?:Exception|Error)\b(?:[^\r\n]*)/.exec(text)?.[0];
  return {
    text, ...identifiers, timestamp, http, httpCall, exception,
    relevant: Boolean(identifiers.traceId || identifiers.correlationId || httpCall || http.status || http.durationMs !== undefined || http.client || exception),
  };
}

/** Aggregate only counters and distinct trace IDs, never the file or its records. */
export async function analyzeLogs(filePath: string, traceId?: string): Promise<LogAnalysis> {
  const metrics: LogAnalysis = { linesProcessed: 0, relevantLines: 0, traceIdsFound: 0, httpCallsFound: 0, externalHttpCallsFound: 0, contextReduction: 0 };
  const traces = new Set<string>();
  let selectedContinuation = false;
  for await (const rawLine of readLogLines(filePath)) {
    metrics.linesProcessed++;
    const line = parseLogLine(rawLine);
    if (line.traceId) traces.add(line.traceId);
    const continuation = !line.traceId && !line.timestamp && /^\s*(?:at\s|Caused by:|Suppressed:|\.\.\. \d+ more)/.test(line.text);
    const selected: boolean = traceId === undefined ? line.relevant || (selectedContinuation && continuation) : line.traceId === traceId || (selectedContinuation && continuation);
    if (!continuation) selectedContinuation = selected;
    if (!selected) continue;
    metrics.relevantLines++;
    if (line.httpCall) {
      metrics.httpCallsFound++;
      if (line.httpCall.external) metrics.externalHttpCallsFound++;
    }
  }
  metrics.traceIdsFound = traces.size;
  metrics.contextReduction = metrics.linesProcessed === 0 ? 0 : Number(((1 - metrics.relevantLines / metrics.linesProcessed) * 100).toFixed(2));
  return metrics;
}
