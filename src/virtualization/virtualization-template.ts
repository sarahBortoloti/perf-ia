import type { ExternalCall } from '../flow/external-call.js';
import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';

export interface VirtualizationTemplate {
  response: { metodo: string; path: string; status: number; header: Record<string, unknown>; body: unknown };
}
export function createVirtualizationTemplate(call: ExternalCall): VirtualizationTemplate {
  return sanitizeValue({ response: {
    metodo: call.method ?? '', path: call.path ?? '', status: call.status ?? 200,
    header: call.responseHeaders ?? { 'Content-Type': 'application/json' }, body: call.body,
  } }) as VirtualizationTemplate;
}
