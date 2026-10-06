import type { ParsedLogLine } from './log-parser.js';
import type { ExternalCall } from '../flow/external-call.js';
import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import { HttpMultilineMachine, type HttpDebugMetrics } from './http-multiline-machine.js';
import { classifyLogEvent } from './log-event.js';

interface Pending {
  call: ExternalCall; sequence: number; timestamp?: number; thread?: string;
  responded: boolean; complete: boolean; orphan: boolean;
  transport?: string;
  logger?: string;
}
export class HttpInteractionReconstructor {
  readonly calls: ExternalCall[] = [];
  readonly diagnostics: string[] = [];
  private pending: Pending[] = [];
  private sequence = 0;
  private previous?: Pending;
  private buffer?: { target: Pending; kind: 'requestBody' | 'responseBody'; text: string };
  private correlationReason = '';
  private multiline = new HttpMultilineMachine();
  private jsonLines = false;
  private uncorrelatedBodies = 0;
  private uncorrelatedResponses = 0;
  private requests = 0;
  private responses = 0;
  private uncorrelatedRequests = 0;
  private analysis = { linesRead: 0, jsonLinesParsed: 0, textLinesParsed: 0, httpEventCandidates: 0 };
  private firstSeen = new WeakMap<ExternalCall, number>();
  get debugMetrics(): HttpDebugMetrics {
    const calls = [...this.calls, ...this.multiline.calls].filter((call) => call.method && call.path);
    return { formats: [...(this.jsonLines ? ['JSON_LINES'] : []), ...(this.multiline.metrics.httpBlocksDetected ? ['HTTP_MULTILINE'] : [])],
      ...this.analysis,
      ...this.multiline.metrics, requestsDetected: this.requests + this.multiline.metrics.requestsDetected,
      responsesDetected: this.responses + this.multiline.metrics.responsesDetected, interactionsReconstructed: calls.length,
      successfulInteractions: calls.filter((call) => call.status !== undefined && call.virtualizationStatus !== 'NO_SUCCESSFUL_RESPONSE').length,
      failedOnlyInteractions: calls.filter((call) => call.status === undefined || call.virtualizationStatus === 'NO_SUCCESSFUL_RESPONSE').length,
      requestBodiesCaptured: this.calls.filter((call) => call.requestBody !== undefined).length + this.multiline.metrics.requestBodiesCaptured,
      responseBodiesCaptured: this.calls.filter((call) => call.responseBody !== undefined).length + this.multiline.metrics.responseBodiesCaptured,
      uncorrelatedRequests: this.uncorrelatedRequests, uncorrelatedResponses: this.uncorrelatedResponses + this.multiline.metrics.uncorrelatedResponseBodies,
      uncorrelatedResponseBodies: this.uncorrelatedBodies + this.multiline.metrics.uncorrelatedResponseBodies,
      uniqueExternalEndpoints: 0, duplicatesCollapsed: 0, conflictingBehaviors: 0 };
  }
  setLogAnalysis(analysis: { linesProcessed: number; jsonLinesParsed: number; textLinesParsed: number; httpEventCandidates: number }): void {
    this.analysis = { linesRead: analysis.linesProcessed, jsonLinesParsed: analysis.jsonLinesParsed, textLinesParsed: analysis.textLinesParsed, httpEventCandidates: analysis.httpEventCandidates };
  }

  private explain(reason: string, call?: ExternalCall): void {
    this.diagnostics.push(`${reason}${call ? `: interaction ${call.order} ${call.method ?? '?'} ${call.path ?? '?'}` : ''}`);
  }
  private review(target: Pending, reason: string): void {
    target.call.confidence = 'REVIEW_REQUIRED';
    target.call.reviewReasons = [...new Set([...(target.call.reviewReasons ?? []), reason])];
    this.explain(`REVIEW_REQUIRED — ${reason}`, target.call);
  }
  private select(line: ParsedLogLine): Pending[] {
    const open = this.pending.filter((item) => !item.complete);
    const trace = (items: Pending[]) => line.traceId ? items.filter((item) => item.call.traceId === line.traceId) : items;
    let candidates: Pending[];
    if (line.traceId && line.spanId) {
      candidates = open.filter((item) => item.call.traceId === line.traceId && item.call.spanId === line.spanId);
      this.correlationReason = 'traceId + spanId';
    } else if (line.requestId) {
      candidates = trace(open.filter((item) => item.call.requestId === line.requestId));
      this.correlationReason = 'requestId';
    } else if (line.correlationId) {
      candidates = trace(open.filter((item) => item.call.correlationId === line.correlationId));
      this.correlationReason = 'correlationId';
    } else if (line.clientName || line.loggerName) {
      candidates = trace(open.filter((item) => (!line.clientName || item.call.client === line.clientName) && (!line.loggerName || item.logger === line.loggerName)
        && (!line.thread || item.thread === line.thread) && (!line.clientMethod || item.call.clientMethod === line.clientMethod)));
      this.correlationReason = 'logger/client + threadName';
    } else if (line.http.path || line.http.url) {
      candidates = trace(open.filter((item) => (!line.http.method || !item.call.method || item.call.method === line.http.method)
        && (!line.http.path || !item.call.path || item.call.path === line.http.path) && (!line.http.url || !item.call.url || item.call.url === line.http.url)));
      this.correlationReason = 'method + normalizedPath';
    } else if (line.thread) {
      candidates = trace(open.filter((item) => item.thread === line.thread));
      this.correlationReason = 'logger/client + threadName';
    } else {
      candidates = trace(open);
      this.correlationReason = 'sequence/timestamp proximity';
      if (!line.traceId && !line.timestamp) candidates = candidates.filter((item) => item === this.previous);
      else if (!line.traceId) return [];
    }
    const explicit = line.spanId || line.requestId || line.correlationId || line.clientName || line.http.path || line.loggerName || line.thread;
    if (this.correlationReason === 'logger/client + threadName' || this.correlationReason === 'sequence/timestamp proximity') {
      candidates = candidates.filter((item) => this.sequence - item.sequence <= 12 && (!line.timestamp || item.timestamp === undefined || Math.abs(Date.parse(line.timestamp) - item.timestamp) <= 5000));
    }
    // API body markers are independent log events, unlike payload lines inside an HTTP dump.
    if (line.responseBody !== undefined && !explicit) {
      candidates.forEach((item) => this.review(item, 'Ambiguous unscoped response body'));
      return [];
    }
    return candidates;
  }
  consume(line: ParsedLogLine): void {
    this.sequence++;
    this.jsonLines ||= line.format === 'JSON_LINES';
    const event = classifyLogEvent(line);
    if (this.multiline.consume(event)) {
      for (const call of this.multiline.calls) if (!this.firstSeen.has(call)) this.firstSeen.set(call, this.sequence);
      return;
    }
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
    const response = !combined && (['RESPONSE_START', 'RESPONSE_BODY', 'RESPONSE_HEADERS'].includes(event.type) || line.responseBody !== undefined || line.responseHeaders !== undefined || line.http.status !== undefined && !line.httpCall);
    const request = ['REQUEST_START', 'REQUEST_BODY', 'REQUEST_HEADERS'].includes(event.type) || line.httpCall?.external;
    if (response && line.http.status !== undefined) this.responses++;
    if (!response && !request) { this.previous = undefined; return; }
    // Inbound entrypoint/response lines without external evidence are never virtualized.
    if (line.httpCall && !line.httpCall.external || response && event.type === 'OTHER' && !line.http.client && !line.responseHeaders && line.responseBody === undefined) { this.previous = undefined; return; }
    let candidates = this.select(line);
    const bodyOnly = event.type === 'REQUEST_BODY' || event.type === 'RESPONSE_BODY';
    // An ordinary request begins a new occurrence. A separate request-body line enriches it.
    if (request && !response && !bodyOnly && !line.requestHeaders && candidates.some((item) => item.call.method && item.call.path)) candidates = [];
    if (candidates.length > 1) {
      candidates.forEach((item) => this.review(item, 'Ambiguous request/response correlation'));
      if (response) this.uncorrelatedResponses++;
      if (line.responseBody !== undefined) this.uncorrelatedBodies++;
      this.previous = undefined; this.explain('Discarded ambiguous event; no payload assigned'); return;
    }
    let target = candidates[0];
    if (!target) {
      if (response && !line.http.path && !line.http.url) { this.uncorrelatedResponses++; if (line.responseBody !== undefined) this.uncorrelatedBodies++; this.explain('REVIEW_REQUIRED: Discarded orphan response without endpoint'); this.previous = undefined; return; }
      if (!response && !line.httpCall?.external && event.type === 'OTHER') return;
      const call: ExternalCall = { order: this.calls.length + 1, source: 'LOG', bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED',
        client: line.clientName ?? line.http.client ?? line.loggerName, clientMethod: line.clientMethod,
        method: line.http.method, url: line.http.url, path: line.http.path,
        traceId: line.traceId, spanId: line.spanId, requestId: line.requestId, correlationId: line.correlationId };
      target = { call, sequence: this.sequence, timestamp: line.timestamp ? Date.parse(line.timestamp) : undefined, thread: line.thread, transport: line.http.client, logger: line.loggerName, responded: false, complete: false, orphan: response };
      if (!response) this.requests++;
      this.calls.push(call); this.pending.push(target);
      this.firstSeen.set(call, this.sequence);
      this.explain(response ? 'Found orphan response endpoint' : 'Found external request from LOG', call);
      if (response) this.review(target, 'Response without corresponding request');
    } else {
      this.explain(`Correlated event by ${this.correlationReason}`, target.call);
      if (!line.spanId && !line.requestId && !line.correlationId && !line.clientName && !line.http.path && !line.loggerName && !line.thread && (line.timestamp || line.traceId)) this.review(target, 'Temporal correlation requires review');
    }
    const call = target.call;
    call.method ??= line.http.method; call.path ??= line.http.path; call.url ??= line.http.url;
    if (line.requestBody !== undefined) call.requestBody = sanitizeValue(line.requestBody);
    if (line.requestHeaders !== undefined) call.requestHeaders = line.requestHeaders;
    if (line.http.status !== undefined) { call.status = line.http.status; target.responded = true; }
    if (response) target.responded = true;
    if (line.responseHeaders) call.responseHeaders = line.responseHeaders;
    if (line.responseBody !== undefined) { call.responseBody = sanitizeValue(line.responseBody); target.complete = true; }
    if (bodyOnly && (event.type === 'REQUEST_BODY' ? line.requestBody === undefined : line.responseBody === undefined)) {
      this.buffer = { target, kind: event.type === 'REQUEST_BODY' ? 'requestBody' : 'responseBody', text: line.bodyFragment ? line.bodyFragment + '\n' : '' };
    }
    target.sequence = this.sequence;
    this.previous = target;
  }
  resetContinuation(): void { this.previous = undefined; this.buffer = undefined; this.multiline.resetContinuation(); }
  finish(): ExternalCall[] {
    if (this.buffer?.text) this.review(this.buffer.target, 'Incomplete multiline body');
    for (const item of this.pending) {
      item.call.bodySource = item.call.responseBody === undefined ? 'EMPTY' : 'LOG';
      item.call.confidence = item.call.responseBody !== undefined && !item.call.reviewReasons?.length && !item.orphan ? 'HIGH' : 'REVIEW_REQUIRED';
      if (item.call.responseBody === undefined) this.review(item, 'Response body not captured');
    }
    const multilineCalls = this.multiline.finish(); this.diagnostics.push(...this.multiline.diagnostics);
    return [...this.calls, ...multilineCalls].filter((call) => {
      if (call.method && call.path) return true;
      this.uncorrelatedRequests++;
      this.explain('Discarded incomplete interaction: HTTP method/path not established', call);
      return false;
    }).sort((a, b) => (this.firstSeen.get(a) ?? 0) - (this.firstSeen.get(b) ?? 0)).map((call, index) => ({ ...call, order: index + 1 }));
  }
}
