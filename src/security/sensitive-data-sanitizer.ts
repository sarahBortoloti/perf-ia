const MASK = '[REDACTED]';
function maskField(_match: string, prefix: string, value: string): string {
  const quoted = value.startsWith('"') || prefix.trim().startsWith('"');
  return prefix + (quoted ? `"${MASK}"` : value.startsWith("'") ? `'${MASK}'` : MASK);
}

/** Sanitize before returning parsed records, displaying data or persisting it. */
export function sanitizeSensitiveData(text: string): string {
  return text
    .replace(/((?:["']?)(?:authorization|proxy-authorization|cookies?|set-cookie|x-signature)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n}]+)/gi, maskField)
    .replace(/((?:["']?)(?:x-api-key|api[-_ ]?key|assertion|password|passwd|pwd|senha|(?:client[-_ ]?|signing[-_ ]?)?secret(?:[-_ ]?key)?|access[-_]?token|refresh[-_]?token|token)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, maskField)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/(:\s*)\d{11}(?=\s*(?:[,}\]]|$))/g, `$1"${MASK}"`)
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, MASK);
}

/** Preserve JSON shape while masking sensitive keys and values recursively. */
export function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeSensitiveData(value);
  if (typeof value === 'number' && /^\d{11}$/.test(String(value))) return MASK;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
      const sensitive = /authorization|bearer|cookie|apikey|assertion|signature|password|passwd|senha|secret|token|^cpf$/.test(normalized);
      return [sanitizeSensitiveData(key), sensitive ? MASK : sanitizeValue(item)];
    }));
  }
  return value;
}
