export interface TraceIdentifiers {
  traceId?: string;
  correlationId?: string;
}

function identifier(line: string, key: string): string | undefined {
  return new RegExp(`\\b(?:${key})["']?\\s*[:=]\\s*["']?([\\w.-]+)`, 'i').exec(line)?.[1];
}

export function extractTraceIdentifiers(line: string): TraceIdentifiers {
  return {
    traceId: identifier(line, 'trace[-_]?id|x-b3-traceid')
      ?? /\btraceparent["']?\s*[:=]\s*["']?[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}\b/i.exec(line)?.[1],
    correlationId: identifier(line, '(?:x-)?correlation[-_]?id'),
  };
}
