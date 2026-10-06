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
  attempts?: HttpAttempt[];
  virtualizationStatus?: 'NO_SUCCESSFUL_RESPONSE';
  returnType?: string;
  codePath?: string;
  codeUrl?: string;
  reviewReasons?: string[];
}

export interface HttpAttempt {
  order: number; outcome: 'PENDING' | 'SUCCESS' | 'ERROR';
  requestHeaders?: Record<string, unknown>; requestBody?: unknown;
  status?: number; responseHeaders?: Record<string, unknown>; responseBody?: unknown;
  error?: string;
}

export interface CallBehavior {
  requestHeaders?: Record<string, unknown>; requestBody?: unknown;
  responseHeaders?: Record<string, unknown>; responseBody?: unknown; status?: number;
  url?: string; occurrences: number;
}
