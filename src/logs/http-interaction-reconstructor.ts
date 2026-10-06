import type { ParsedLogLine } from './log-parser.js';
import type { ExternalCall } from '../flow/external-call.js';
import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';

interface Pending {
  call: ExternalCall; sequence: number; timestamp?: number; thread?: string;
  responded: boolean; complete: boolean; orphan: boolean;
  transport?: string;
}
export class HttpInteractionReconstructor {
  readonly calls: ExternalCall[] = [];
  readonly diagnostics: string[] = [];
  private pending: Pending[] = [];
  private sequence = 0;
  private previous?: Pending;
  private buffer?: { target: Pending; kind: 'requestBody' | 'responseBody'; text: string };
  private correlationReason = '';

  private explain(reason: string, call?: ExternalCall): void {
    this.diagnostics.push(`${reason}${call ? `: interaction ${call.order} ${call.method ?? '?'} ${call.path ?? '?'}` : ''}`);
  }
  private review(target: Pending, reason: string): void {
    target.call.confidence = 'REVIEW_REQUIRED';
    target.call.reviewReasons = [...new Set([...(target.call.reviewReasons ?? []), reason])];
    this.explain(`REVIEW_REQUIRED — ${reason}`, target.call);
  }
  private select(line: ParsedLogLine): Pending[] {
    let candidates = this.pending.filter((item) => !item.complete);
    // An explicit identifier is a constraint, never permission to fall back to another request.
    for (const key of ['traceId', 'spanId', 'requestId', 'correlationId'] as const) {
      if (line[key]) candidates = candidates.filter((item) => item.call[key] === line[key]);
    }
    if (line.clientName) candidates = candidates.filter((item) => item.call.client === line.clientName && (!line.clientMethod || item.call.clientMethod === line.clientMethod));
    else if (line.http.client) candidates = candidates.filter((item) => item.transport === line.http.client);
    if (line.http.method) candidates = candidates.filter((item) => !item.call.method || item.call.method === line.http.method);
    if (line.http.path) candidates = candidates.filter((item) => !item.call.path || item.call.path === line.http.path);
    if (line.http.url) candidates = candidates.filter((item) => !item.call.url || item.call.url === line.http.url);
    const explicit = line.spanId || line.requestId || line.correlationId || line.clientName || line.http.path;
    this.correlationReason = line.spanId || line.requestId || line.correlationId ? 'trace + span/request/correlation ID'
      : line.clientName ? 'explicit client identity' : line.http.path ? 'method + URL/path' : 'unique thread/temporal sequence fallback';
    if (!explicit) {
      if (line.thread) candidates = candidates.filter((item) => item.thread === line.thread);
      else if (!line.timestamp && !line.traceId) candidates = candidates.filter((item) => item === this.previous);
      else if (!line.traceId) return [];
      candidates = candidates.filter((item) => this.sequence - item.sequence <= 12 && (!line.timestamp || item.timestamp === undefined || Math.abs(Date.parse(line.timestamp) - item.timestamp) <= 5000));
    }
    return candidates;
  }
  consume(line: ParsedLogLine): void {
    this.sequence++;
    if (line.payload !== undefined || line.jsonFragment) {
      const target = this.buffer?.target ?? this.previous;
      if (!target || target.complete || line.timestamp || line.traceId) { this.explain('Discarded unattached payload'); return; }
      const kind = this.buffer?.kind ?? (target.responded ? 'responseBody' : 'requestBody');
      if (line.payload !== undefined && !this.buffer?.text) {
        target.call[kind] = sanitizeValue(line.payload); this.buffer = undefined;
        if (kind === 'responseBody') target.complete = true;
        this.explain(`Correlated ${kind} by contiguous body sequence`, target.call); return;
      }
      const text = (this.buffer?.text ?? '') + (line.jsonFragment ?? line.text) + '\n';
      if (text.length > 1024 * 1024) { this.review(target, 'Body exceeds 1 MiB limit'); this.buffer = undefined; return; }
      this.buffer = { target, kind, text };
      try {
        target.call[kind] = sanitizeValue(JSON.parse(text));
        if (kind === 'responseBody') target.complete = true;
        this.buffer = undefined; this.explain(`Correlated multiline ${kind}`, target.call);
      } catch { /* Bounded lexical JSON continuation. */ }
      return;
    }
    if (this.buffer?.text) { this.review(this.buffer.target, 'Interrupted multiline body'); this.buffer = undefined; }
    // Any new structured event terminates the previous empty body marker too.
    this.buffer = undefined;
    const combined = Boolean(line.httpCall?.external && !/API[ _-]+RESPONSE|<---|\bResponse\s+\d/i.test(line.text) && (line.responseBody !== undefined || line.http.status !== undefined));
    const response = !combined && (line.event === 'RESPONSE' || line.event === 'RESPONSE_BODY' || line.responseBody !== undefined || line.responseHeaders !== undefined || line.http.status !== undefined && !line.httpCall);
    const request = line.event === 'REQUEST' || line.event === 'REQUEST_BODY' || line.httpCall?.external;
    if (!response && !request) { this.previous = undefined; return; }
    // Inbound entrypoint/response lines without external evidence are never virtualized.
    if (line.httpCall && !line.httpCall.external || response && !line.event && !line.http.client && !line.responseHeaders && line.responseBody === undefined) { this.previous = undefined; return; }
    let candidates = this.select(line);
    const bodyOnly = line.event === 'REQUEST_BODY' || line.event === 'RESPONSE_BODY';
    // An ordinary request begins a new occurrence. A separate request-body line enriches it.
    if (request && !response && !bodyOnly && !line.requestHeaders && candidates.some((item) => item.call.method && item.call.path)) candidates = [];
    if (candidates.length > 1) {
      candidates.forEach((item) => this.review(item, 'Ambiguous request/response correlation'));
      this.previous = undefined; this.explain('Discarded ambiguous event; no payload assigned'); return;
    }
    let target = candidates[0];
    if (!target) {
      if (response && !line.http.path && !line.http.url) { this.explain('Discarded orphan response without endpoint'); this.previous = undefined; return; }
      if (!response && !line.httpCall?.external && !line.event) return;
      const call: ExternalCall = { order: this.calls.length + 1, source: 'LOG', bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED',
        client: line.clientName ?? line.http.client, clientMethod: line.clientMethod,
        method: line.http.method, url: line.http.url, path: line.http.path,
        traceId: line.traceId, spanId: line.spanId, requestId: line.requestId, correlationId: line.correlationId };
      target = { call, sequence: this.sequence, timestamp: line.timestamp ? Date.parse(line.timestamp) : undefined, thread: line.thread, transport: line.http.client, responded: false, complete: false, orphan: response };
      this.calls.push(call); this.pending.push(target);
      this.explain(response ? 'Found orphan response endpoint' : 'Found external request from LOG', call);
      if (response) this.review(target, 'Response without corresponding request');
    } else {
      this.explain(`Correlated event by ${this.correlationReason}`, target.call);
      if (!line.spanId && !line.requestId && !line.correlationId && !line.clientName && !line.http.path && (line.timestamp || line.traceId)) this.review(target, 'Temporal correlation requires review');
    }
    const call = target.call;
    call.method ??= line.http.method; call.path ??= line.http.path; call.url ??= line.http.url;
    if (line.requestBody !== undefined) call.requestBody = sanitizeValue(line.requestBody);
    if (line.requestHeaders !== undefined) call.requestHeaders = line.requestHeaders;
    if (line.http.status !== undefined) { call.status = line.http.status; target.responded = true; }
    if (response) target.responded = true;
    if (line.responseHeaders) call.responseHeaders = line.responseHeaders;
    if (line.responseBody !== undefined) { call.responseBody = sanitizeValue(line.responseBody); target.complete = true; }
    if (bodyOnly && (line.event === 'REQUEST_BODY' ? line.requestBody === undefined : line.responseBody === undefined)) {
      this.buffer = { target, kind: line.event === 'REQUEST_BODY' ? 'requestBody' : 'responseBody', text: line.bodyFragment ? line.bodyFragment + '\n' : '' };
    }
    target.sequence = this.sequence;
    this.previous = target;
  }
  resetContinuation(): void { this.previous = undefined; this.buffer = undefined; }
  finish(): ExternalCall[] {
    if (this.buffer?.text) this.review(this.buffer.target, 'Incomplete multiline body');
    for (const item of this.pending) {
      item.call.bodySource = item.call.responseBody === undefined ? 'EMPTY' : 'LOG';
      item.call.confidence = item.call.responseBody !== undefined && !item.call.reviewReasons?.length && !item.orphan ? 'HIGH' : 'REVIEW_REQUIRED';
      if (item.call.responseBody === undefined) this.review(item, 'Response body not captured');
    }
    return this.calls.filter((call) => {
      if (call.method && call.path) return true;
      this.explain('Discarded incomplete interaction: HTTP method/path not established', call);
      return false;
    });
  }
}
