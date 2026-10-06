import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';

export type HttpClient = 'Feign' | 'RestTemplate' | 'WebClient' | 'RestClient' | 'HttpClient';
export interface HttpCall {
  method?: string;
  url?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  client?: HttpClient;
  external: boolean;
}

export function extractHttpDetails(input: string): HttpCall {
  const line = sanitizeSensitiveData(input);
  const method = (/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)\s+(?:https?:\/\/|\/)/i.exec(line)?.[1]
    ?? /\b(?:method|httpMethod)["']?\s*[:=]\s*["']?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)\b/i.exec(line)?.[1])?.toUpperCase();
  const url = /https?:\/\/[^\s"'<>\])},]+/i.exec(line)?.[0];
  const explicitPath = /\b(?:path|uri)["']?\s*[:=]\s*["']?(\/[^\s"',}\]]*)/i.exec(line)?.[1];
  const requestPath = /\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)\s+(\/[^\s"',}\]]*)/i.exec(line)?.[1];
  let path = explicitPath ?? requestPath;
  if (url) {
    try { path = new URL(url).pathname; } catch { /* Keep other deterministic fields for malformed URLs. */ }
  }
  const client: HttpClient | undefined = /\bfeign\b|\[[\w.$]+#[\w$]+\]/i.test(line) ? 'Feign'
    : /\bRestTemplate\b/i.test(line) ? 'RestTemplate'
    : /\bWebClient\b/i.test(line) ? 'WebClient' : /\bRestClient\b/i.test(line) ? 'RestClient' : /\bHttpClient\b/i.test(line) ? 'HttpClient' : undefined;
  const statusText = /\b(?:status(?:code)?|http[-_ ]?status)["']?\s*[:= ]\s*["']?([1-5]\d{2})\b/i.exec(line)?.[1]
    ?? /(?:<---\s*|HTTP\/\d(?:\.\d)?\s+|Response\s+)([1-5]\d{2})\b/i.exec(line)?.[1];
  const durationMatch = /\b(?:duration(?:ms)?|elapsed(?:ms)?|took)["']?\s*[:= ]\s*["']?(\d+(?:\.\d+)?)\s*(ms|s|seconds?|milliseconds?)?\b/i.exec(line)
    ?? /\((\d+(?:\.\d+)?)\s*(ms|s)\)/i.exec(line);
  const durationMs = durationMatch ? Number(durationMatch[1]) * (/^(s|seconds?)$/i.test(durationMatch[2] ?? '') ? 1000 : 1) : undefined;
  return { method, url, path, status: statusText ? Number(statusText) : undefined, durationMs, client, external: Boolean(url || client || /--->|API[ _-]+(?:REQUEST|RESPONSE)/i.test(line)) };
}

export function extractHttpCall(line: string): HttpCall | undefined {
  const details = extractHttpDetails(line);
  // Response-only lines provide metadata, but do not count as additional requests.
  return details.method && (details.url || details.path) ? details : undefined;
}
