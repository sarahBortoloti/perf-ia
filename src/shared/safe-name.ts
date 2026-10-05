import { sanitizeSensitiveData } from '../security/sensitive-data-sanitizer.js';

export function safeName(value: string, fallback = 'flow'): string {
  const name = sanitizeSensitiveData(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 100);
  if (!name) return fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `${name}-flow` : name;
}
