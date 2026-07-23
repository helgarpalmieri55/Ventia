export type TenantStatus = 'draft' | 'live' | 'suspended';
export type PlanId = 'basico' | 'pro' | 'premium';
export type MembershipRole = 'owner' | 'staff' | 'platform_admin';

export interface PlanLimits {
  productsMax: number;
  aiMessagesMonth: number;
  staffSeats: number;
  customDomain: boolean;
  humanHandoff: boolean;
  whatsappChannel: boolean;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  basico: { productsMax: 100, aiMessagesMonth: 500, staffSeats: 1, customDomain: false, humanHandoff: false, whatsappChannel: false },
  pro: { productsMax: 1000, aiMessagesMonth: 3000, staffSeats: 3, customDomain: true, humanHandoff: false, whatsappChannel: true },
  premium: { productsMax: 10000, aiMessagesMonth: 10000, staffSeats: 10, customDomain: true, humanHandoff: true, whatsappChannel: true },
};
