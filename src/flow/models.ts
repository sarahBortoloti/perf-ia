export type CallSource = 'CODE' | 'LOG' | 'CODE_AND_LOG';
export type BodySource = 'LOG' | 'OPENAPI' | 'EXISTING_MOCK' | 'DTO' | 'EMPTY';
export type Confidence = 'HIGH' | 'MEDIUM' | 'REVIEW_REQUIRED';
export interface Entrypoint { method: string; path: string }
export interface BodyEvidence {
  responseBody?: unknown;
  bodySource: BodySource;
  confidence: Confidence;
  evidence?: string;
}
