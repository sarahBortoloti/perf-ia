import type { ExternalCall, CallBehavior } from './external-call.js';

export function normalizedPath(path: string): string { return path.split('?')[0].replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function behavior(call: ExternalCall): CallBehavior {
  return { requestHeaders: call.requestHeaders, requestBody: call.requestBody, responseHeaders: call.responseHeaders,
    responseBody: call.responseBody, status: call.status, url: call.url, occurrences: call.occurrences ?? 1 };
}
/** Preserve differing behaviors in metadata; never select a response silently. */
export function groupInteractions(calls: ExternalCall[]): ExternalCall[] {
  const groups = new Map<string, ExternalCall[]>();
  for (const call of calls) {
    const key = call.method && call.path ? `${call.method.toUpperCase()} ${normalizedPath(call.path)}` : `unknown:${call.order}`;
    groups.set(key, [...groups.get(key) ?? [], call]);
  }
  return [...groups.values()].map((items, index) => {
    const distinct = new Map<string, CallBehavior>();
    for (const call of items) {
      for (const item of call.behaviors ?? [behavior(call)]) {
        const { occurrences, ...data } = item;
        const key = JSON.stringify(canonical(data));
        const previous = distinct.get(key);
        if (previous) previous.occurrences += occurrences;
        else distinct.set(key, { ...item });
      }
    }
    const sources = new Set(items.map((call) => call.source));
    const result: ExternalCall = { ...items[0], order: index + 1, path: items[0].path ? normalizedPath(items[0].path) : undefined,
      source: sources.has('CODE_AND_LOG') || sources.has('CODE') && sources.has('LOG') ? 'CODE_AND_LOG' : items[0].source,
      occurrences: [...distinct.values()].reduce((total, item) => total + item.occurrences, 0), distinctBehaviors: distinct.size,
      collapseDuplicates: distinct.size === 1 && items.reduce((total, call) => total + (call.occurrences ?? 1), 0) > 1 };
    if (items.some((call) => call.confidence === 'REVIEW_REQUIRED')) result.confidence = 'REVIEW_REQUIRED';
    result.reviewReasons = [...new Set(items.flatMap((call) => call.reviewReasons ?? []))];
    if (distinct.size > 1) {
      result.behaviors = [...distinct.values()]; result.conflict = 'VIRTUALIZATION_CONFLICT'; result.confidence = 'REVIEW_REQUIRED';
      result.reviewReasons.push('VIRTUALIZATION_CONFLICT: endpoint has distinct request/response behaviors');
      // There is no single authoritative response for a conflicting group.
      result.responseBody = undefined;
    }
    return result;
  });
}
