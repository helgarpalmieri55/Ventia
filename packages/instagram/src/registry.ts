import { GraphProvider } from './graph.js';
import type { InstagramProvider, InstagramProviderId } from './index.js';

/** Todos los ids de proveedor con adaptador de verdad. Vive en el paquete y no
 * en la app, igual que el de `@ventia/whatsapp`: nada de aquí necesita el
 * contenedor de Nest. */
export const INSTAGRAM_PROVIDER_IDS: readonly InstagramProviderId[] = ['graph'];

const PROVIDERS: Record<InstagramProviderId, InstagramProvider> = {
  graph: new GraphProvider(),
};

/** Los adaptadores no tienen estado — cada valor por inquilino llega en
 * `InstagramConfig` — así que una única instancia compartida es lo correcto y
 * evita construir un proveedor por mensaje entrante. */
export function getInstagramProvider(id: string): InstagramProvider | null {
  return (PROVIDERS as Record<string, InstagramProvider | undefined>)[id] ?? null;
}
