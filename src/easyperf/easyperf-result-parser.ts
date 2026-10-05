import type { EasyPerfRawResult } from './easyperf-page.js';
import type { PublicationResult, SelectedVirtualization } from './types.js';
import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';

export function normalizeBaseUrl(value: string): string {
  const input = value.trim();
  if (!input || /\s/.test(input) || sanitizeSensitiveData(input) !== input) throw new Error('Invalid or unsafe publication base URL');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) throw new Error('Invalid publication base URL');
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`); }
  catch { throw new Error('Invalid publication base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid or unsafe publication base URL');
  url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') + '/';
  return url.toString();
}
export function normalizeEndpointPath(value: string): string {
  const input = value.trim();
  if (!input.startsWith('/') || input.startsWith('//') || /[\s?#\\]/.test(input) || sanitizeSensitiveData(input) !== input) throw new Error('Invalid or unsafe published endpoint path');
  const path = input.replace(/\/+/g, '/');
  if (path.split('/').some((part) => part === '.' || part === '..' || /%2e|%2f|%5c/i.test(part))) throw new Error('Invalid published endpoint path');
  return path;
}
export function parseEasyPerfResult(raw: EasyPerfRawResult, selected: SelectedVirtualization[]): PublicationResult {
  const baseUrl = normalizeBaseUrl(raw.baseUrl);
  const expected = new Set(selected.map((file) => `${file.template.response.metodo} ${normalizeEndpointPath(file.template.response.path)}`));
  const services = new Map<string, PublicationResult['services'][number]>();
  for (const endpoint of raw.endpoints) {
    const path = normalizeEndpointPath(endpoint.path);
    const candidates = selected.filter((file) => normalizeEndpointPath(file.template.response.path) === path);
    const methods = new Set(candidates.map((file) => file.template.response.metodo));
    const method = endpoint.method?.trim().toUpperCase() || (methods.size === 1 ? [...methods][0] : undefined);
    if (!method || !expected.has(`${method} ${path}`)) throw new Error('Publication result contains an unrecognized or ambiguous endpoint');
    const url = baseUrl.replace(/\/$/, '') + path;
    services.set(`${method} ${path}`, { method, path, url });
  }
  if (!services.size || [...expected].some((key) => !services.has(key))) throw new Error('Publication result does not confirm all selected endpoints');
  return { baseUrl, services: [...services.values()] };
}
