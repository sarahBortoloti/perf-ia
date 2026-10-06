import type { ParsedLogLine } from './log-parser.js';
import type { ExternalCall, HttpAttempt } from '../flow/external-call.js';
import { sanitizeSensitiveData, sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import { normalizedPath } from '../flow/interaction-groups.js';
import { classifyLogEvent, type LogEvent, type HttpReadingPhase } from './log-event.js';

type State = 'IDLE' | 'REQUEST_HEADERS' | 'REQUEST_BODY' | 'RESPONSE_HEADERS' | 'RESPONSE_BODY' | 'ERROR';
interface Block {
  call: ExternalCall; attempt: HttpAttempt; state: State; logger?: string; thread?: string;
  body: string; overflow: boolean; retry: boolean; complete: boolean;
}
export interface HttpDebugMetrics {
  formats: string[]; linesRead: number; jsonLinesParsed: number; textLinesParsed: number; httpEventCandidates: number;
  httpBlocksDetected: number; requestsDetected: number; responsesDetected: number;
  errorsDetected: number; retriesDetected: number; interactionsReconstructed: number;
  successfulInteractions: number; failedOnlyInteractions: number; requestBodiesCaptured: number;
  responseBodiesCaptured: number; uncorrelatedRequests: number; uncorrelatedResponses: number; uncorrelatedResponseBodies: number;
  uniqueExternalEndpoints: number; duplicatesCollapsed: number; conflictingBehaviors: number;
}

/** Each block has its own state, so interleaved threads/spans cannot share a body buffer. */
export class HttpMultilineMachine {
  readonly calls: ExternalCall[] = [];
  readonly diagnostics: string[] = [];
  readonly metrics = { httpBlocksDetected: 0, requestsDetected: 0, responsesDetected: 0, errorsDetected: 0, retriesDetected: 0,
    requestBodiesCaptured: 0, responseBodiesCaptured: 0, uncorrelatedResponseBodies: 0 };
  private blocks: Block[] = [];
  private orphan?: { state: State; hasBody: boolean };

  private matches(block: Block, line: ParsedLogLine): boolean {
    if (line.traceId && line.spanId) return block.call.traceId === line.traceId && block.call.spanId === line.spanId;
    if (line.requestId) return block.call.requestId === line.requestId;
    if (line.correlationId) return block.call.correlationId === line.correlationId;
    if (line.clientName || line.loggerName) {
      const identityMatches = (!line.clientName || block.call.client === line.clientName)
        && (!line.loggerName || block.logger === line.loggerName);
      return identityMatches && (!line.thread || !block.thread || block.thread === line.thread);
    }
    if (line.thread) return block.thread === line.thread;
    return true;
  }
  private review(block: Block, reason: string): void {
    block.call.reviewReasons = [...new Set([...(block.call.reviewReasons ?? []), reason])];
    block.call.confidence = 'REVIEW_REQUIRED';
    this.diagnostics.push(`REVIEW_REQUIRED: HTTP block ${block.call.order} — ${reason}`);
  }
  private capture(block: Block, text: string): void {
    if (block.overflow) return;
    if (block.body.length + text.length + 1 > 1024 * 1024) {
      block.body = ''; block.overflow = true; this.review(block, 'HTTP body exceeds 1 MiB'); return;
    }
    block.body += sanitizeSensitiveData(text) + '\n';
  }
  private finishBody(block: Block, response: boolean): void {
    const text = block.body.trim();
    if (text && !block.overflow) {
      let value: unknown = text;
      try { value = JSON.parse(text); } catch { /* Preserve non-JSON response/request text. */ }
      const key = response ? 'responseBody' : 'requestBody';
      block.attempt[key] = sanitizeValue(value);
      if (response) this.metrics.responseBodiesCaptured++; else this.metrics.requestBodiesCaptured++;
    }
    block.body = ''; block.overflow = false;
  }
  consume(input: ParsedLogLine | LogEvent): boolean {
    const original = 'type' in input ? input : undefined;
    const line = original?.line ?? input as ParsedLogLine;
    const active = this.blocks.find((block) => !block.complete && this.matches(block, line));
    const phase = active && ['REQUEST_HEADERS', 'REQUEST_BODY', 'RESPONSE_HEADERS', 'RESPONSE_BODY'].includes(active.state) ? active.state as HttpReadingPhase : undefined;
    const event = original?.type === 'OTHER' && phase ? classifyLogEvent(line, phase) : original ?? classifyLogEvent(line, phase);
    const text = line.text.trim().replace(/^\[[^\]]+\]\s*/, '');
    const start = /--->\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(https?:\/\/\S+)\s+HTTP\/\d(?:\.\d)?/i.exec(text);
    const status = /<---\s+([1-5]\d{2})\b/.exec(text);
    const error = event.type === 'ERROR';
    const retry = event.type === 'RETRY';
    const requestEnd = event.type === 'REQUEST_END';
    const responseEnd = event.type === 'RESPONSE_END';
    const errorEnd = event.type === 'ERROR_END';
    if (start) {
      const method = start[1].toUpperCase(); const url = sanitizeSensitiveData(start[2]);
      let path: string; try { path = normalizedPath(new URL(url).pathname); } catch { return false; }
      const retries = this.blocks.filter((block) => block.retry && this.matches(block, line) && block.call.method === method && block.call.url === url);
      let block = retries.length === 1 ? retries[0] : undefined;
      if (retries.length > 1) retries.forEach((item) => this.review(item, 'Ambiguous retry association'));
      if (!block) {
        const call: ExternalCall = { order: this.calls.length + 1, method, url, path, source: 'LOG', bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED',
          client: line.clientName ?? line.loggerName ?? line.http.client, clientMethod: line.clientMethod,
          traceId: line.traceId, spanId: line.spanId, requestId: line.requestId, correlationId: line.correlationId, attempts: [] };
        block = { call, attempt: { order: 1, outcome: 'PENDING' }, state: 'IDLE', logger: line.loggerName, thread: line.thread, body: '', overflow: false, retry: false, complete: false };
        this.calls.push(call); this.blocks.push(block);
      }
      block.attempt = { order: (block.call.attempts?.length ?? 0) + 1, outcome: 'PENDING' };
      block.call.attempts?.push(block.attempt); block.state = 'REQUEST_HEADERS'; block.retry = false; block.body = ''; block.overflow = false;
      this.metrics.requestsDetected++; this.metrics.httpBlocksDetected++;
      this.diagnostics.push(`Found HTTP_MULTILINE request: block ${block.call.order}, attempt ${block.attempt.order}`);
      return true;
    }
    if (!this.blocks.length && !this.orphan) return false;
    // API/body messages are independent events; health checks never become dump body text.
    if (line.payload === undefined && !line.jsonFragment && /(?:^|\s)API[ _-]+(?:REQUEST|RESPONSE)\b|^(?:REQUEST|RESPONSE)[ _-]+BODYS?\b/i.test(text)) return false;
    const candidates = this.blocks.filter((block) => !block.complete && this.matches(block, line) && (block.state !== 'IDLE' || block.attempt.outcome === 'PENDING' || retry));
    if (!candidates.length && !this.orphan) return false;
    if (candidates.length !== 1) {
      if (status || error || retry || requestEnd || responseEnd || errorEnd || candidates.some((block) => block.state !== 'IDLE')) {
        candidates.forEach((block) => this.review(block, 'Ambiguous HTTP block correlation'));
        if (status) { this.metrics.responsesDetected++; this.orphan = { state: 'RESPONSE_HEADERS', hasBody: false }; }
        if (this.orphan) {
          if (responseEnd) { if (this.orphan.hasBody) this.metrics.uncorrelatedResponseBodies++; this.orphan = undefined; }
          else if (!status && text && !/^[\w-]+:\s*/.test(text)) this.orphan.hasBody = true;
        }
        this.diagnostics.push('Discarded uncorrelated/ambiguous HTTP block event'); return true;
      }
      if (this.orphan) {
        if (responseEnd) { if (this.orphan.hasBody) this.metrics.uncorrelatedResponseBodies++; this.orphan = undefined; }
        else if (text && !/^[\w-]+:\s*/.test(text)) this.orphan.hasBody = true;
        return true;
      }
      return false;
    }
    const block = candidates[0];
    if (retry) {
      this.metrics.retriesDetected++; block.retry = true; block.state = 'IDLE';
      if (block.attempt.outcome === 'PENDING') block.attempt.outcome = 'ERROR';
      this.diagnostics.push(`Retry registered: HTTP block ${block.call.order}`); return true;
    }
    if (error) {
      this.metrics.errorsDetected++; block.attempt.outcome = 'ERROR';
      block.attempt.error = sanitizeSensitiveData(text.slice(text.indexOf('<---') + 4).trim()).slice(0, 16384);
      block.state = 'ERROR'; block.body = ''; return true;
    }
    if (errorEnd) { block.state = 'IDLE'; return true; }
    if (status) {
      this.metrics.responsesDetected++; block.attempt.status = Number(status[1]); block.state = 'RESPONSE_HEADERS'; block.body = ''; return true;
    }
    if (requestEnd) { this.finishBody(block, false); block.state = 'IDLE'; return true; }
    if (responseEnd) {
      this.finishBody(block, true); block.state = 'IDLE'; block.complete = true;
      block.attempt.outcome = block.attempt.status === undefined ? 'ERROR' : 'SUCCESS'; return true;
    }
    if (block.state === 'ERROR') {
      if (text) block.attempt.error = sanitizeSensitiveData((block.attempt.error ?? '') + '\n' + text).slice(0, 16384);
      return true;
    }
    if (block.state === 'IDLE') return false;
    const response = block.state === 'RESPONSE_HEADERS' || block.state === 'RESPONSE_BODY';
    if (block.state === 'REQUEST_HEADERS' || block.state === 'RESPONSE_HEADERS') {
      if (!text) { block.state = response ? 'RESPONSE_BODY' : 'REQUEST_BODY'; return true; }
      const header = /^([!#$%&'*+.^_`|~\w-]+):\s*(.*)$/.exec(text);
      if (header) {
        const safe = sanitizeValue({ [header[1]]: header[2] });
        const fields = safe && typeof safe === 'object' ? Object.fromEntries(Object.entries(safe)) : {};
        const key = response ? 'responseHeaders' : 'requestHeaders';
        block.attempt[key] = { ...block.attempt[key], ...fields }; return true;
      }
      block.state = response ? 'RESPONSE_BODY' : 'REQUEST_BODY';
    }
    this.capture(block, line.text); return true;
  }
  resetContinuation(): void {
    for (const block of this.blocks.filter((item) => item.state !== 'IDLE')) this.review(block, 'HTTP scope interrupted');
  }
  finish(): ExternalCall[] {
    for (const block of this.blocks) {
      const final = [...block.call.attempts ?? []].reverse().find((attempt) => attempt.outcome === 'SUCCESS');
      if (final) {
        Object.assign(block.call, { requestHeaders: final.requestHeaders, requestBody: final.requestBody, status: final.status,
          responseHeaders: final.responseHeaders, responseBody: final.responseBody,
          bodySource: final.responseBody === undefined ? 'EMPTY' : 'LOG', confidence: final.responseBody !== undefined && !block.call.reviewReasons?.length ? 'HIGH' : 'REVIEW_REQUIRED' });
      } else {
        block.call.virtualizationStatus = 'NO_SUCCESSFUL_RESPONSE';
        this.review(block, 'NO_SUCCESSFUL_RESPONSE');
        const last = block.call.attempts?.at(-1);
        block.call.requestHeaders = last?.requestHeaders; block.call.requestBody = last?.requestBody;
      }
    }
    return this.calls;
  }
}
