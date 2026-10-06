import type { ParsedLogLine } from './log-parser.js';

export type LogEventType =
  | 'REQUEST_START' | 'REQUEST_HEADERS' | 'REQUEST_BODY' | 'REQUEST_END'
  | 'RESPONSE_START' | 'RESPONSE_HEADERS' | 'RESPONSE_BODY' | 'RESPONSE_END'
  | 'ERROR' | 'ERROR_END' | 'RETRY' | 'BODY_CHUNK' | 'OTHER';

export interface LogEvent {
  type: LogEventType;
  line: ParsedLogLine;
  sequence?: number;
  timestamp?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  correlationId?: string;
  threadName?: string;
  loggerName?: string;
}

export type HttpReadingPhase = 'REQUEST_HEADERS' | 'REQUEST_BODY' | 'RESPONSE_HEADERS' | 'RESPONSE_BODY';

/** Normalize separators and punctuation without changing the original payload. */
export function normalizeHttpMessage(message: string): string {
  return message.normalize('NFKC').replace(/[_.:=-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

export function classifyHttpMarker(message: string): LogEventType {
  if (/--->\s+END\s+HTTP\b/i.test(message)) return 'REQUEST_END';
  if (/<---\s+END\s+HTTP\b/i.test(message)) return 'RESPONSE_END';
  if (/<---\s+END\s+ERROR\b/i.test(message)) return 'ERROR_END';
  if (/--->\s+RETRYING\b/i.test(message)) return 'RETRY';
  if (/<---\s+ERROR\b/i.test(message)) return 'ERROR';
  if (/--->\s+(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+https?:\/\/\S+\s+HTTP\/\d/i.test(message)) return 'REQUEST_START';
  if (/<---\s+[1-5]\d{2}\b/i.test(message)) return 'RESPONSE_START';
  const normalized = normalizeHttpMessage(message);
  if (/\b(?:API |HTTP )?REQUEST BODYS?\b/.test(normalized)) return 'REQUEST_BODY';
  if (/\b(?:API |HTTP )?RESPONSE BODYS?\b/.test(normalized)) return 'RESPONSE_BODY';
  if (/\b(?:API |HTTP )REQUEST\b/.test(normalized)) return 'REQUEST_START';
  if (/\b(?:API |HTTP )RESPONSE\b/.test(normalized)) return 'RESPONSE_START';
  return 'OTHER';
}

export function classifyLogEvent(line: ParsedLogLine, phase?: HttpReadingPhase): LogEvent {
  let type = classifyHttpMarker(line.text);
  if (type === 'OTHER') {
    if (line.event === 'REQUEST') type = 'REQUEST_START';
    else if (line.event === 'REQUEST_BODY') type = 'REQUEST_BODY';
    else if (line.event === 'RESPONSE') type = 'RESPONSE_START';
    else if (line.event === 'RESPONSE_BODY') type = 'RESPONSE_BODY';
    else if (line.requestBody !== undefined) type = 'REQUEST_BODY';
    else if (line.responseBody !== undefined) type = 'RESPONSE_BODY';
    else if (line.requestHeaders) type = 'REQUEST_HEADERS';
    else if (line.responseHeaders) type = 'RESPONSE_HEADERS';
    else if (line.httpCall?.external) type = 'REQUEST_START';
    else if (line.http.status !== undefined) type = 'RESPONSE_START';
    else if (line.payload !== undefined || line.jsonFragment !== undefined) type = 'BODY_CHUNK';
    else if (phase && /^\s*[!#$%&'*+.^_`|~\w-]+:\s*/.test(line.text)) type = phase.includes('REQUEST') ? 'REQUEST_HEADERS' : 'RESPONSE_HEADERS';
    else if (phase && line.text.trim()) type = 'BODY_CHUNK';
  }
  return { type, line, sequence: line.sequence, timestamp: line.timestamp, traceId: line.traceId, spanId: line.spanId,
    requestId: line.requestId, correlationId: line.correlationId, threadName: line.thread, loggerName: line.loggerName };
}

export function isHttpEventCandidate(event: LogEvent): boolean {
  return event.type !== 'OTHER' || Boolean(event.line.http.client || event.line.httpCall);
}
