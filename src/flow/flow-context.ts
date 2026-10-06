import type { Entrypoint } from './models.js';
import type { ExternalCall } from './external-call.js';
import type { HttpDebugMetrics } from '../logs/http-multiline-machine.js';

export interface FlowContext {
  application: string;
  flow: string;
  entrypoint: Entrypoint;
  externalCalls: ExternalCall[];
  traceId?: string;
  httpAnalysis?: HttpDebugMetrics;
  runtimeAnalysis?: {
    interactionsFound: number; uniqueExternalEndpoints: number; duplicateOccurrencesCollapsed: number;
    responseBodiesCaptured: number; responseBodiesMissing: number;
  };
}
