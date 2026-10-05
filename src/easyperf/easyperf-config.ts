import { z } from 'zod';
import type { EasyPerfConfig } from './types.js';

const schema = z.object({
  EASYPERF_BASE_URL: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }),
  EASYPERF_USERNAME: z.string().optional(),
  EASYPERF_PASSWORD: z.string().optional(),
  EASYPERF_PROJECT: z.string().trim().min(1),
  EASYPERF_SQUAD: z.string().trim().min(1),
  EASYPERF_MANUAL_LOGIN: z.enum(['true', 'false']).default('true'),
});

export function parseEasyPerfConfig(environment: NodeJS.ProcessEnv): EasyPerfConfig {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    // Zod errors may contain input values; expose only field names.
    throw new Error(`Invalid EasyPerf configuration: ${fields.join(', ')}`);
  }
  const value = result.data;
  if (value.EASYPERF_MANUAL_LOGIN === 'false' && (!value.EASYPERF_USERNAME?.trim() || !value.EASYPERF_PASSWORD)) {
    throw new Error('Automatic login requires EASYPERF_USERNAME and EASYPERF_PASSWORD');
  }
  return { baseUrl: value.EASYPERF_BASE_URL, username: value.EASYPERF_USERNAME, password: value.EASYPERF_PASSWORD,
    project: value.EASYPERF_PROJECT, squad: value.EASYPERF_SQUAD, manualLogin: value.EASYPERF_MANUAL_LOGIN === 'true' };
}
