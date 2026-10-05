import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';

/** Parse a single balanced JSON value after a log field without retaining raw data. */
function jsonField(line: string, field: string): unknown {
  const match = new RegExp(`\\b${field}["']?\\s*[:=]\\s*`, 'i').exec(line);
  if (!match) return undefined;
  const remaining = line.slice(match.index + match[0].length).trim();
  const first = remaining[0];
  if (first !== '{' && first !== '[') {
    const scalar = /^("(?:\\.|[^"\\])*"|null|true|false|-?\d+(?:\.\d+)?)/.exec(remaining)?.[0];
    if (!scalar) return undefined;
    try { return sanitizeValue(JSON.parse(scalar)); } catch { return undefined; }
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < remaining.length; i++) {
    const character = remaining[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      depth--;
      if (depth === 0) {
        try { return sanitizeValue(JSON.parse(remaining.slice(0, i + 1))); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

export function extractResponse(line: string): { responseBody?: unknown; responseHeaders?: Record<string, unknown>; payload?: unknown } {
  const responseBody = jsonField(line, 'response[-_]?body');
  const headers = jsonField(line, 'response[-_]?headers');
  let payload: unknown;
  // Feign FULL logging may emit a JSON body as a separate line.
  if (/^\s*[[{]/.test(line)) {
    try { payload = sanitizeValue(JSON.parse(line)); } catch { /* Not a standalone JSON payload. */ }
  }
  return { responseBody, responseHeaders: headers && typeof headers === 'object' && !Array.isArray(headers) ? headers as Record<string, unknown> : undefined, payload };
}
