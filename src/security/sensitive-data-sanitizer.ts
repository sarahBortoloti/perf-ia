const MASK = '[REDACTED]';

/** Sanitize before returning parsed records, displaying data or persisting it. */
export function sanitizeSensitiveData(text: string): string {
  return text
    .replace(/((?:["']?)(?:authorization|proxy-authorization|cookies?|set-cookie|x-signature)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n}]+)/gi, `$1${MASK}`)
    .replace(/((?:["']?)(?:x-api-key|api[-_ ]?key|password|passwd|pwd|senha|(?:client[-_ ]?|signing[-_ ]?)?secret(?:[-_ ]?key)?|access[-_]?token|refresh[-_]?token|token)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, `$1${MASK}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, MASK);
}
