import { z } from 'zod';

/**
 * What a shopper may send to the account endpoints (`/v1/storefront/account/*`).
 *
 * These describe a SHOPPER's login at one store, which is a different thing
 * from the merchant login in `staff-schemas.ts`: merchant identity lives in
 * better-auth's tables, is platform-wide, and is deliberately unreachable from
 * tenant-scoped code. A shopper account belongs to exactly one store — see the
 * `ShopperAccount` model comment for why that is a product decision and not a
 * modelling accident.
 */

/**
 * Minimum password length.
 *
 * Length is the only rule. No "one uppercase, one symbol" composition
 * requirement, deliberately: those push people toward `Password1!` and toward
 * writing it down, and NIST has recommended against them for years. Eight is
 * the floor because this guards a shopping history and a saved address, not a
 * bank — and because a rule a shopper cannot satisfy on a phone keyboard is a
 * rule that loses the sale.
 */
export const SHOPPER_PASSWORD_MIN = 8;

/** Upper bound, so a megabyte of "password" cannot be handed to scrypt. Each
 * hash costs real CPU and memory (see `shopper-credentials.ts`), which makes an
 * unbounded input an amplification lever against the whole API. */
export const SHOPPER_PASSWORD_MAX = 200;

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(SHOPPER_PASSWORD_MIN).max(SHOPPER_PASSWORD_MAX);
/** The opaque secret from a verification, magic-link or reset URL. Bounded
 * only loosely — its real validation is whether it hashes to a stored row. */
const linkToken = z.string().min(1).max(500);

export const shopperRegisterSchema = z.object({
  email,
  password,
  /** Optional: the store asks for a name at checkout anyway, and demanding one
   * up front adds a field to the screen with the highest abandon rate. */
  name: z.string().trim().min(1).max(120).optional(),
});

export const shopperSignInSchema = z.object({
  email,
  /** Not length-checked on sign-in. A minimum here would reject a legacy or
   * shorter password with a VALIDATION error instead of an authentication one,
   * which tells an attacker their guess was the wrong SHAPE rather than simply
   * wrong. */
  password: z.string().min(1).max(SHOPPER_PASSWORD_MAX),
});

/** Used for both "email me a sign-in link" and "I forgot my password". Both
 * answer identically whether or not the address has an account — see
 * `ShopperAuthService` for why. */
export const shopperEmailRequestSchema = z.object({ email });

export const shopperConsumeTokenSchema = z.object({ token: linkToken });

export const shopperPasswordResetSchema = z.object({ token: linkToken, password });

export const shopperProfileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).nullable().optional(),
});

export type ShopperRegisterInput = z.infer<typeof shopperRegisterSchema>;
export type ShopperSignInInput = z.infer<typeof shopperSignInSchema>;
export type ShopperEmailRequestInput = z.infer<typeof shopperEmailRequestSchema>;
export type ShopperConsumeTokenInput = z.infer<typeof shopperConsumeTokenSchema>;
export type ShopperPasswordResetInput = z.infer<typeof shopperPasswordResetSchema>;
export type ShopperProfileUpdateInput = z.infer<typeof shopperProfileUpdateSchema>;
