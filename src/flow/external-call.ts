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
  responseBody?: unknown;
  source: CallSource;
  traceId?: string;
  requestId?: string;
  returnType?: string;
  codePath?: string;
  codeUrl?: string;
  reviewReasons?: string[];
}
