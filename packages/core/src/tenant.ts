export type TenantStatus = 'draft' | 'live' | 'suspended';

/**
 * The three plans.
 *
 * Named for what the merchant is doing, not for a tier ladder: someone
 * choosing between "básico" and "premium" is being asked which of them is the
 * cheap one, and the answer makes the cheap one feel like a compromise.
 * "Emprende / Crece / Escala" asks a different question — where is your store
 * right now — and every answer is a good one.
 *
 * These are the SAME strings the merchant sees. Keeping an internal id that
 * differs from the marketing name is how a store ends up on "premium" while
 * support insists there is no such plan.
 */
export type PlanId = 'emprende' | 'crece' | 'escala';

export type MembershipRole = 'owner' | 'staff' | 'platform_admin';

/**
 * A practical ceiling that stands in for "unlimited" on Escala.
 *
 * `productsMax` is an `Int` column checked on every product create, so an
 * honest `null` would mean a nullable column and a null check at every call
 * site — for a distinction no real store reaches. A Colombian retailer with a
 * million SKUs is not a customer this platform has, or wants.
 *
 * The number is documented rather than hidden because the plan page says
 * "ilimitados" and this is the sense in which that is true. If a tenant ever
 * approaches it, that is a conversation, not a silent wall.
 */
export const PRODUCTS_UNLIMITED = 1_000_000;

export interface PlanLimits {
  productsMax: number;
  /**
   * Créditos de IA per calendar month.
   *
   * Credits and not messages because two different actions consume the agent
   * and they do not cost the same — see {@link CREDIT_COST}. One number the
   * merchant can reason about, weighted underneath by what each action
   * actually costs us.
   */
  aiCreditsMonth: number;
  staffSeats: number;
  customDomain: boolean;
  humanHandoff: boolean;
  whatsappChannel: boolean;
  instagramChannel: boolean;
}

/**
 * What each action costs against {@link PlanLimits.aiCreditsMonth}.
 *
 * Grounded in measured cost, not invented: with the shopper agent on Sonnet 5,
 * one shopper turn costs ~72 COP and one merchant question ~145 COP, because
 * the merchant's assistant reads far more context (catalog, orders) to answer.
 * Two credits for the merchant is that ratio, rounded toward the customer.
 *
 * The merchant's own usage is deliberately on the SAME counter rather than a
 * second quota. A merchant asking one or two questions a day spends ~120
 * credits a month — invisible against any plan — and a single number is the
 * only thing anyone can actually keep track of.
 */
export const CREDIT_COST = {
  /** One shopper turn in the storefront or WhatsApp chat. */
  shopperMessage: 1,
  /** One question from the merchant to their own assistant. */
  merchantQuery: 2,
} as const;

export type CreditedAction = keyof typeof CREDIT_COST;

/**
 * How far past the monthly allowance a store may go before the agent stops.
 *
 * Reaching the allowance does NOT silence the agent — see
 * `agent-budget.service.ts`. Going quiet on the store's busiest day of the
 * year does not read to a merchant as a quota notice; it reads as the shop
 * being broken, at the exact hour it matters most. Credits past the allowance
 * are billed as overage instead.
 *
 * This multiplier is the backstop on that, and it exists for a different
 * failure: a scripted abuser, or a loop of our own, burning credits nobody
 * authorised. Three times the allowance is far beyond any honest month and
 * still bounds the damage to something a refund can cover.
 */
export const OVERAGE_CEILING_MULTIPLIER = 3;

export const PLANS: Record<PlanId, PlanLimits> = {
  // WhatsApp is in the entry plan on purpose. The product is sold as "your
  // salesperson on WhatsApp"; an entry plan without WhatsApp sells something
  // else, and the 83% of Colombian online sellers who are one-to-five-person
  // businesses are exactly the ones who live in that inbox.
  emprende: {
    productsMax: 300,
    aiCreditsMonth: 500,
    staffSeats: 1,
    customDomain: false,
    humanHandoff: false,
    whatsappChannel: true,
    instagramChannel: false,
  },
  crece: {
    productsMax: 3_000,
    aiCreditsMonth: 1_200,
    staffSeats: 5,
    customDomain: true,
    humanHandoff: true,
    whatsappChannel: true,
    instagramChannel: true,
  },
  escala: {
    productsMax: PRODUCTS_UNLIMITED,
    aiCreditsMonth: 2_800,
    staffSeats: 15,
    customDomain: true,
    humanHandoff: true,
    whatsappChannel: true,
    instagramChannel: true,
  },
};

/** Credits this action costs. */
export function creditsFor(action: CreditedAction): number {
  return CREDIT_COST[action];
}

/** The hard stop for a plan: past this, the agent really does go quiet. */
export function overageCeiling(limits: Pick<PlanLimits, 'aiCreditsMonth'>): number {
  return limits.aiCreditsMonth * OVERAGE_CEILING_MULTIPLIER;
}
