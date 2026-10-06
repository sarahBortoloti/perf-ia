import type { RepositoryAnalysis } from '../repository/types.js';
import { analyzeLogs, parseLogLine, type LogAnalysis, type LogPatterns } from '../logs/log-parser.js';
import { sanitizeValue } from '../security/sensitive-data-sanitizer.js';
import type { Entrypoint } from './models.js';
import type { ExternalCall } from './external-call.js';
import type { FlowContext } from './flow-context.js';
import { findCodeCalls, pathMatches } from './code-calls.js';
import { readLogLines } from '../logs/log-reader.js';
import { HttpInteractionReconstructor } from '../logs/http-interaction-reconstructor.js';
import { groupInteractions } from './interaction-groups.js';

export interface BuildFlowOptions {
  application: string; flow: string; entrypoint: Entrypoint; repository: RepositoryAnalysis;
  logPath: string; traceId?: string; debug?: boolean; logPatterns?: LogPatterns;
}
function host(url: string): string | undefined { try { return new URL(url).host; } catch { return undefined; } }
export class FlowBuilder {
  async build(options: BuildFlowOptions): Promise<{ context: FlowContext; logs: LogAnalysis; diagnostics: string[] }> {
    const code = findCodeCalls(options.repository, options.entrypoint);
    const runtime = new HttpInteractionReconstructor();
    for (const call of code) runtime.diagnostics.push(`Found CODE integration by reachable invocation + HTTP operation/configuration URL: ${call.method} ${call.path}`);
    const entryTraces = new Set<string>();
    if (!options.traceId) {
      for await (const raw of readLogLines(options.logPath)) {
        const line = parseLogLine(raw, options.logPatterns);
        if (!line.httpCall?.external && line.httpCall && line.traceId && line.http.path && (line.http.method === options.entrypoint.method || options.entrypoint.method === 'ANY') && pathMatches(options.entrypoint.path, line.http.path)) entryTraces.add(line.traceId);
      }
    }
    const logs = await analyzeLogs(options.logPath, options.traceId, (line) => {
      if (entryTraces.size && (line.traceId && !entryTraces.has(line.traceId) || !line.traceId && line.timestamp)) { runtime.resetContinuation(); return; }
      runtime.consume(line);
    }, options.logPatterns);
    runtime.setLogAnalysis(logs);
    const calls = runtime.finish();
    const used = new Set<ExternalCall>();
    for (const call of calls) {
      const matches = code.filter((candidate) => {
        if (candidate.method !== call.method || !candidate.path || !call.path || !pathMatches(candidate.path, call.path)) return false;
        const namedClient = call.client && !['Feign', 'RestTemplate', 'WebClient', 'RestClient', 'HttpClient'].includes(call.client);
        if (namedClient) {
          const className = candidate.codePath?.split(/[\\/]/).at(-1)?.replace(/\.java$/, '');
          if (call.client !== candidate.client && call.client?.split('.').at(-1) !== className) return false;
        }
        // Runtime environment may override a statically resolved URL. Explicit client identity wins.
        return namedClient || !(candidate.codeUrl && call.url && host(candidate.codeUrl) && host(call.url) && host(candidate.codeUrl) !== host(call.url));
      });
      if (matches.length === 1) {
        const candidate = matches[0]; used.add(candidate);
        Object.assign(call, { source: 'CODE_AND_LOG', client: candidate.client, clientMethod: candidate.clientMethod,
          codePath: candidate.codePath, codeUrl: candidate.codeUrl, returnType: candidate.returnType });
        runtime.diagnostics.push(`Correlated CODE_AND_LOG by method, path, client and host: interaction ${call.order}`);
      } else if (matches.length > 1) {
        call.confidence = 'REVIEW_REQUIRED'; call.reviewReasons = [...call.reviewReasons ?? [], 'Ambiguous static integration match'];
        runtime.diagnostics.push(`REVIEW_REQUIRED: ambiguous static match for interaction ${call.order}`);
      } else runtime.diagnostics.push(`Kept LOG-only interaction ${call.order}: no unique matching static integration`);
    }
    const externalCalls = groupInteractions([...calls, ...code.filter((call) => !used.has(call))]);
    for (const call of externalCalls) {
      const reasons = [...call.reviewReasons ?? []];
      if (call.status === undefined) reasons.push('HTTP status not captured; template uses 200');
      if (call.path?.includes('{')) reasons.push('Path contains unresolved parameters');
      if (call.source === 'CODE') reasons.push('Static invocation; runtime execution not confirmed');
      if (reasons.length) { call.reviewReasons = [...new Set(reasons)]; call.confidence = 'REVIEW_REQUIRED'; }
      if (call.collapseDuplicates) runtime.diagnostics.push(`Duplicate occurrences collapsed: ${call.method} ${call.path} (${call.occurrences})`);
      if (call.conflict) runtime.diagnostics.push(`REVIEW_REQUIRED / VIRTUALIZATION_CONFLICT: ${call.method} ${call.path} (${call.distinctBehaviors} behaviors)`);
    }
    const httpAnalysis = runtime.debugMetrics;
    httpAnalysis.uniqueExternalEndpoints = new Set(calls.filter((call) => call.method && call.path).map((call) => `${call.method} ${call.path}`)).size;
    httpAnalysis.duplicatesCollapsed = externalCalls.filter((call) => call.source !== 'CODE').reduce((total, call) => total + Math.max(0, (call.occurrences ?? 1) - (call.distinctBehaviors ?? 1)), 0);
    httpAnalysis.conflictingBehaviors = externalCalls.filter((call) => call.conflict).length;
    const context: FlowContext = { application: options.application, flow: options.flow, entrypoint: options.entrypoint,
      traceId: options.traceId, externalCalls, httpAnalysis, runtimeAnalysis: {
        interactionsFound: calls.length, uniqueExternalEndpoints: new Set(calls.filter((call) => call.method && call.path).map((call) => `${call.method} ${call.path}`)).size,
        duplicateOccurrencesCollapsed: externalCalls.filter((call) => call.source !== 'CODE').reduce((total, call) => total + (call.occurrences ?? 1) - (call.distinctBehaviors ?? 1), 0),
        responseBodiesCaptured: calls.filter((call) => call.responseBody !== undefined).length,
        responseBodiesMissing: calls.filter((call) => call.responseBody === undefined).length,
      } };
    // Sanitize every externally sourced field before returning or persisting context.
    const safe = sanitizeValue(context);
    return { context: safe as FlowContext, logs, diagnostics: runtime.diagnostics };
  }
}
