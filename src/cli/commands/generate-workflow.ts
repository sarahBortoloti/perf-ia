import { basename } from 'node:path';
import type { RepositoryAnalysis } from '../../repository/types.js';
import type { Entrypoint } from '../../flow/models.js';
import { FlowBuilder } from '../../flow/flow-builder.js';
import { VirtualizationGenerator } from '../../virtualization/virtualization-generator.js';
import { readLogLines } from '../../logs/log-reader.js';
import { parseLogLine } from '../../logs/log-parser.js';
import { pathMatches } from '../../flow/code-calls.js';
import { sanitizeSensitiveData } from '../../security/sensitive-data-sanitizer.js';
import { repositoryEndpoints } from './interactive-generate.js';

export async function selectArgumentEntrypoint(repository: RepositoryAnalysis, logPath: string, traceId?: string, explicit?: string): Promise<Entrypoint> {
  const endpoints = repositoryEndpoints(repository);
  if (!endpoints.length) throw new Error('No endpoints found in repository');
  if (explicit) {
    const endpoint = endpoints.find((item) => `${item.method} ${item.path}` === explicit);
    if (!endpoint) throw new Error('Selected endpoint was not found in the repository');
    return endpoint;
  }
  const matches = new Map<string, Entrypoint>();
  for await (const raw of readLogLines(logPath)) {
    const line = parseLogLine(raw);
    if (traceId && line.traceId !== traceId) continue;
    if (!line.httpCall || line.httpCall.external) continue;
    for (const endpoint of endpoints) {
      if ((endpoint.method === line.http.method || endpoint.method === 'ANY') && line.http.path && pathMatches(endpoint.path, line.http.path)) {
        matches.set(`${endpoint.method} ${endpoint.path}`, endpoint);
      }
    }
  }
  if (matches.size === 1) return [...matches.values()][0];
  if (matches.size === 0 && endpoints.length === 1) return endpoints[0];
  throw new Error('Cannot determine a unique entrypoint from logs. Use --endpoint "METHOD /path" or npm run generate.');
}

export async function generateWorkflow(options: {
  application: string; flow: string; entrypoint: Entrypoint; repository: RepositoryAnalysis;
  logPath: string; traceId?: string; outputRoot?: string; debug?: boolean;
}): Promise<void> {
  const { context, logs, diagnostics } = await new FlowBuilder().build(options);
  const generated = await new VirtualizationGenerator().generate(context, options.outputRoot);
  const lines = [
    'PERF AI', '────────────────────────────', '',
    `Application: ${options.application}`, `Endpoint: ${options.entrypoint.method} ${options.entrypoint.path}`, `Logs: ${basename(options.logPath)}`, '',
    'Repository', '✓ analyzed', `✓ ${repositoryEndpoints(options.repository).length} endpoints found`, `✓ ${options.repository.feignClients.length} external clients found`, '',
    'Logs', 'Log analyzed', `Lines processed: ${logs.linesProcessed}`, `Relevant lines: ${logs.relevantLines}`, `Trace IDs found: ${logs.traceIdsFound}`, `HTTP calls found: ${logs.httpCallsFound}`, `Context reduction: ${logs.contextReduction}%`, '',
    'Flow', '✓ reconstructed', `✓ ${context.externalCalls.length} external calls identified`, '', 'Virtualizations', '',
    ...generated.files.map((file) => `${file.confidence === 'REVIEW_REQUIRED' ? '⚠' : '✓'} ${file.fileName}  ${file.confidence}`),
    ...generated.errors.map((error) => `✗ ${error}`), '', `${generated.files.length} virtualization files generated.`, '', 'Output:', generated.directory,
  ];
  const metrics = context.runtimeAnalysis;
  if (metrics) lines.push('', 'Runtime HTTP analysis', `✓ ${metrics.interactionsFound} HTTP interactions found`, `✓ ${metrics.uniqueExternalEndpoints} unique external endpoints`,
    `✓ ${metrics.duplicateOccurrencesCollapsed} duplicate occurrences collapsed`, '', 'Sources:',
    ...(['CODE_AND_LOG', 'LOG', 'CODE'] as const).map((source) => `${source}  ${context.externalCalls.filter((call) => call.source === source).length}`),
    '', 'Response bodies:', `✓ ${metrics.responseBodiesCaptured} captured from logs`, `⚠ ${metrics.responseBodiesMissing} missing`);
  for (const call of context.externalCalls) {
    lines.push('', `Integration: ${call.client ?? 'unknown'}`, `Method: ${call.method ?? 'unknown'}`, `Path: ${call.path ?? 'unknown'}`, `Source: ${call.source}`,
      `Request body: ${call.requestBody === undefined ? 'missing' : 'captured'}`, `Response: ${call.status ?? 'missing'}`,
      `Response body: ${call.responseBody === undefined ? call.conflict ? 'multiple behaviors; review required' : 'missing' : 'captured'}`, `Confidence: ${call.confidence}`);
    if (call.conflict) lines.push(`⚠ VIRTUALIZATION_CONFLICT: ${call.occurrences} occurrences, ${call.distinctBehaviors} distinct behaviors`);
  }
  lines.push(...generated.warnings.map((warning) => `⚠ ${warning}`));
  if (options.debug) {
    const http = context.httpAnalysis;
    if (http) lines.push('', `Log format: ${http.formats.join(' + ') || 'TEXT'}`, `HTTP blocks detected: ${http.httpBlocksDetected}`,
      `Requests detected: ${http.requestsDetected}`, `Responses detected: ${http.responsesDetected}`, `Errors detected: ${http.errorsDetected}`, `Retries detected: ${http.retriesDetected}`,
      `Interactions reconstructed: ${http.interactionsReconstructed}`, `Successful interactions: ${http.successfulInteractions}`, `Failed-only interactions: ${http.failedOnlyInteractions}`,
      `Request bodies captured: ${http.requestBodiesCaptured}`, `Response bodies captured: ${http.responseBodiesCaptured}`, `Uncorrelated response bodies: ${http.uncorrelatedResponseBodies}`);
    lines.push('', 'HTTP debug (payloads omitted)', ...diagnostics);
  }
  if (generated.files.some((file) => file.confidence === 'REVIEW_REQUIRED')) lines.push('', 'Files marked REVIEW_REQUIRED must be reviewed before importing into EasyPerf.');
  console.log(sanitizeSensitiveData(lines.join('\n')));
  if (generated.errors.length) throw new Error('Some virtualizations failed validation; see errors above.');
}
