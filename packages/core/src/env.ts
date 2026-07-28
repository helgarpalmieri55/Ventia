import { z } from 'zod';

// Exported (not just a literal in the schema below) so mailer.module.ts's
// hand-rolled process.env fallback (it can't call loadEnv() itself — see
// that file's doc comment on why) can share this exact default instead of
// carrying its own copy that could silently drift from this one.
export const DEFAULT_RESEND_FROM_EMAIL = 'pedidos@ventia.localhost';

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
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().default(DEFAULT_RESEND_FROM_EMAIL),
  // AES-256-GCM key for encrypting payment-provider credentials at rest
  // (services/api/src/payments/encryption.ts). Required, no default — an
  // unset/malformed key must fail loudly at boot, not silently produce
  // garbage ciphertext. Must base64-decode to exactly 32 raw bytes
  // (generate with `openssl rand -base64 32`).
  PAYMENTS_ENCRYPTION_KEY: z.string().min(1).refine(
    (val) => {
      try {
        return Buffer.from(val, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes' },
  ),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Include each issue's message, not just its field path — a bare path
    // list (e.g. "PAYMENTS_ENCRYPTION_KEY") can't distinguish "missing" from
    // "present but fails a .refine() check" (e.g. wrong-length key), which
    // matters for a var whose failure mode is otherwise a cryptic crypto
    // error deep inside crypto.createCipheriv.
    const details = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join(', ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
