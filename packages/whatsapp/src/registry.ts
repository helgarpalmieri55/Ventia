import { CloudProvider } from './cloud.js';
import { EvolutionProvider } from './evolution.js';
import type { WhatsAppProvider, WhatsAppProviderId } from './index.js';

/** Every provider id with a real adapter. Mirrors
 * `services/api/src/payments/provider-registry.ts`'s role, but lives in the
 * package rather than the app because — unlike payments, whose registry needs
 * a Nest-injected config service — nothing here needs the container. */
export const WHATSAPP_PROVIDER_IDS: readonly WhatsAppProviderId[] = ['cloud', 'evolution'];

const PROVIDERS: Record<WhatsAppProviderId, WhatsAppProvider> = {
  cloud: new CloudProvider(),
  evolution: new EvolutionProvider(),
};

/** Adapters are stateless — every per-tenant value arrives in `WhatsAppConfig`
 * — so one shared instance each is correct and avoids allocating a provider
 * per inbound message. */
export function getWhatsAppProvider(id: string): WhatsAppProvider | null {
  return (PROVIDERS as Record<string, WhatsAppProvider | undefined>)[id] ?? null;
}
