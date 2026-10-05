import type { RepositoryAnalysis } from '../repository/types.js';
import { analyzeLogs, type ParsedLogLine, type LogAnalysis } from '../logs/log-parser.js';
import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import type { Entrypoint } from './models.js';
import type { ExternalCall } from './external-call.js';
import type { FlowContext } from './flow-context.js';
import { findCodeCalls, pathMatches } from './code-calls.js';
import { ResponseBodyResolver } from './response-body-resolver.js';
import { readLogLines } from '../logs/log-reader.js';
import { parseLogLine } from '../logs/log-parser.js';

export interface BuildFlowOptions {
  application: string;
  flow: string;
  entrypoint: Entrypoint;
  repository: RepositoryAnalysis;
  logPath: string;
  traceId?: string;
}
type Identity = Pick<ParsedLogLine, 'traceId' | 'correlationId' | 'requestId' | 'clientName' | 'clientMethod'> & { http: Pick<ParsedLogLine['http'], 'client'> };
interface Pending { call: ExternalCall; identity: Identity; closed: boolean; responding: boolean; bodyBuffer?: string }
function host(url: string): string | undefined { try { return new URL(url).host; } catch { return undefined; } }

export class FlowBuilder {
  async build(options: BuildFlowOptions): Promise<{ context: FlowContext; logs: LogAnalysis }> {
    const code = findCodeCalls(options.repository, options.entrypoint);
    const runtime: ExternalCall[] = [];
    const pending: Pending[] = [];
    const entryTraces = new Set<string>();
    if (!options.traceId) {
      for await (const raw of readLogLines(options.logPath)) {
        const line = parseLogLine(raw);
        if (!line.httpCall?.external && line.httpCall && line.traceId && line.http.path && (line.http.method === options.entrypoint.method || options.entrypoint.method === 'ANY') && pathMatches(options.entrypoint.path, line.http.path)) entryTraces.add(line.traceId);
      }
    }
    let previous: Pending | undefined;
    const consume = (line: ParsedLogLine): void => {
      if (entryTraces.size && line.traceId && !entryTraces.has(line.traceId)) { previous = undefined; return; }
      if (entryTraces.size && !line.traceId && line.timestamp) { previous = undefined; return; }
      if (line.httpCall?.external) {
        const call: ExternalCall = {
          order: runtime.length + 1, client: line.clientName ?? line.http.client, clientMethod: line.clientMethod,
          method: line.httpCall.method, url: line.httpCall.url, path: line.httpCall.path,
          status: line.http.status, responseBody: line.responseBody, responseHeaders: line.responseHeaders,
          traceId: line.traceId, requestId: line.requestId, source: 'LOG', body: {}, bodySource: 'EMPTY', confidence: 'REVIEW_REQUIRED',
        };
        runtime.push(call);
        const identity: Identity = { traceId: line.traceId, correlationId: line.correlationId, requestId: line.requestId, clientName: line.clientName, clientMethod: line.clientMethod, http: { client: line.http.client } };
        previous = { call, identity, closed: line.responseBody !== undefined, responding: line.http.status !== undefined };
        pending.push(previous);
        return;
      }
      const response = line.http.status !== undefined || line.responseBody !== undefined || line.responseHeaders || line.payload !== undefined || line.jsonFragment;
      if (!response && !/END HTTP/.test(line.text)) { if (!line.http.client) previous = undefined; return; }
      // A generic inbound status must not become the external response.
      if (!line.http.client && !line.responseHeaders && line.responseBody === undefined && line.payload === undefined && !line.jsonFragment && !/response|<---/i.test(line.text)) return;
      let candidates = pending.filter((item) => !item.closed);
      if (line.traceId) candidates = candidates.filter((item) => item.identity.traceId === line.traceId);
      if (line.correlationId) candidates = candidates.filter((item) => item.identity.correlationId === line.correlationId);
      if (line.requestId) candidates = candidates.filter((item) => item.identity.requestId === line.requestId);
      if (line.clientName) candidates = candidates.filter((item) => item.identity.clientName === line.clientName && (!line.clientMethod || item.identity.clientMethod === line.clientMethod));
      else if (line.http.client) candidates = candidates.filter((item) => item.identity.http.client === line.http.client);
      if (line.http.path) candidates = candidates.filter((item) => item.call.path === line.http.path);
      if (!line.traceId && !line.requestId && !line.clientName && !line.correlationId) candidates = previous && !line.timestamp ? candidates.filter((item) => item === previous) : [];
      if (candidates.length !== 1) { previous = undefined; return; }
      const target = candidates[0];
      if (line.http.status !== undefined) { target.call.status = line.http.status; target.responding = true; }
      if (line.responseHeaders) { target.call.responseHeaders = line.responseHeaders; target.responding = true; }
      if (line.responseBody !== undefined) { target.call.responseBody = line.responseBody; target.responding = true; }
      else if (line.payload !== undefined && target.responding && !line.traceId) target.call.responseBody = line.payload;
      else if (line.jsonFragment && target.responding) {
        const fragment = (target.bodyBuffer ?? '') + line.jsonFragment + '\n';
        if (fragment.length > 1024 * 1024) {
          target.closed = true; target.bodyBuffer = undefined;
        } else {
          target.bodyBuffer = fragment;
          try { target.call.responseBody = sanitizeValue(JSON.parse(fragment)); target.bodyBuffer = undefined; }
          catch { /* Continue a bounded, sanitized multiline JSON response. */ }
        }
      }
      if (/END HTTP/.test(line.text) || target.call.responseBody !== undefined) target.closed = true;
      previous = target;
    };
    const logs = await analyzeLogs(options.logPath, options.traceId, consume);
    const used = new Set<ExternalCall>();
    for (const call of runtime) {
      const matches = code.filter((candidate) => {
        if (candidate.method !== call.method || !candidate.path || !call.path || !pathMatches(candidate.path, call.path)) return false;
        if (call.client && !['Feign', 'RestTemplate', 'WebClient'].includes(call.client)) {
          const className = candidate.codePath?.split(/[\\/]/).at(-1)?.replace(/\.java$/, '');
          if (call.client !== candidate.client && call.client.split('.').at(-1) !== className) return false;
        }
        if (candidate.codeUrl && call.url && host(candidate.codeUrl) && host(call.url) && host(candidate.codeUrl) !== host(call.url)) return false;
        return true;
      });
      if (matches.length === 1) {
        const candidate = matches[0]; used.add(candidate);
        Object.assign(call, { source: 'CODE_AND_LOG', client: candidate.client, codePath: candidate.codePath, returnType: candidate.returnType });
      }
    }
    const externalCalls = [...runtime, ...code.filter((call) => !used.has(call))];
    const resolver = new ResponseBodyResolver(options.repository);
    await resolver.load();
    externalCalls.forEach((call, index) => {
      call.order = index + 1;
      Object.assign(call, resolver.resolve(call));
      const reviewReasons: string[] = [];
      if (call.status === undefined) reviewReasons.push('HTTP status not captured; template uses 200');
      if (call.path?.includes('{')) reviewReasons.push('Path contains unresolved parameters');
      if (call.source === 'CODE') reviewReasons.push('Static invocation; runtime execution not confirmed');
      if (reviewReasons.length) call.reviewReasons = reviewReasons;
    });
    const context = sanitizeValue({ application: options.application, flow: options.flow, entrypoint: options.entrypoint, traceId: options.traceId, externalCalls }) as FlowContext;
    return { context, logs };
  }
}
