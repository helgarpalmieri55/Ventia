import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AUTH_SECRET: z.string().min(1),
  API_PORT: z.coerce.number().int().default(4000),
  API_URL: z.string().url().default('http://api.ventia.localhost'),
  PLATFORM_ROOT_DOMAIN: z.string().min(1).default('ventia.localhost'),
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_ACCESS_KEY: z.string().min(1).default('ventia'),
  S3_SECRET_KEY: z.string().min(1).default('ventia-secret'),
  S3_BUCKET: z.string().min(1).default('ventia'),
  S3_PUBLIC_URL: z.string().url().default('http://localhost:9000/ventia'),
  REVALIDATE_SECRET: z.string().min(1).default('dev-revalidate-secret'),
  STOREFRONT_INTERNAL_URL: z.string().url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${missing}`);
  }
  return parsed.data;
}
