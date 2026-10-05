import 'dotenv/config';
import { z } from 'zod';

export const envSchema = z.object({
  EASYPERF_USERNAME: z.string().optional(),
  EASYPERF_PASSWORD: z.string().optional(),
  EASYPERF_MANUAL_LOGIN: z.enum(['true', 'false']).default('true')
});

export const env = envSchema.parse(process.env);
