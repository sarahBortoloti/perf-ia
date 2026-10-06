import type { BodyEvidence, CallSource } from './models.js';

export interface ExternalCall extends BodyEvidence {
  order: number;
  client?: string;
  clientMethod?: string;
  method?: string;
  url?: string;
  path?: string;
  status?: number;
  responseHeaders?: Record<string, unknown>;
  requestHeaders?: Record<string, unknown>;
  requestBody?: unknown;
  source: CallSource;
  traceId?: string;
  requestId?: string;
  spanId?: string;
  correlationId?: string;
  occurrences?: number;
  distinctBehaviors?: number;
  collapseDuplicates?: boolean;
  conflict?: 'VIRTUALIZATION_CONFLICT';
  behaviors?: CallBehavior[];
  returnType?: string;
  codePath?: string;
  codeUrl?: string;
  reviewReasons?: string[];
}

export interface CallBehavior {
  requestHeaders?: Record<string, unknown>; requestBody?: unknown;
  responseHeaders?: Record<string, unknown>; responseBody?: unknown; status?: number;
  url?: string; occurrences: number;
}
