import { apiFetch } from './api';

/**
 * Cliente de `/v1/admin/instagram/accounts` (solo el dueño — ver
 * `services/api/src/instagram/instagram-admin.controller.ts`), más la lógica
 * pura de formulario que necesita la pestaña.
 *
 * Los tipos son copias escritas a mano de los del servidor, por lo mismo que
 * las de `whatsapp-api.ts`: esta app no puede importar de `services/api/src`.
 * Los cuerpos de petición reflejan `instagramConnectSchema` en
 * `packages/core/src/instagram-schemas.ts` en vez de importar su tipo
 * inferido, porque el `username` de ese esquema es un TRANSFORM (`string` a la
 * entrada, `string` a la salida) y reutilizar `InstagramConnectInput` aquí
 * afirmaría en falso que este formulario produce el @usuario ya normalizado.
 * No lo hace — normaliza el servidor.
 */

export type InstagramProviderId = 'graph';

/**
 * Una cuenta conectada tal y como el admin puede verla — refleja
 * `InstagramAccountView` en `instagram-accounts.service.ts`.
 *
 * Aquí no hay token, ni app secret, ni token de verificación, y no debería
 * añadirse ninguno: la API no los devuelve (existen solo cifrados, y en claro
 * lo que dura un envío), y al comerciante le hace falta saber QUÉ cuenta está
 * conectada y si funciona, nunca las credenciales que la hacen funcionar.
 */
export interface InstagramAccount {
  id: string;
  provider: InstagramProviderId;
  igAccountId: string;
  /** Nullable porque la otra integración de Meta no tiene página; con `graph`
   * siempre viene. */
  pageId: string | null;
  username: string;
  /** Tipado `string` y no la unión de dos valores que acepta el `PATCH`: la
   * columna lleva además `pending`, y una unión aquí sería mentira en cuanto
   * llegara una fila así. {@link instagramStatusLabel} maneja el conjunto
   * abierto. */
  status: string;
  /** ISO-8601. `Date` en el servidor, cadena cuando llega el JSON. */
  createdAt: string;
}

export interface InstagramAccountsResponse {
  items: InstagramAccount[];
  /** `TenantLimits.instagramChannel`. Falso significa que el formulario de
   * conexión no debe pintarse: el `POST` respondería 402. Emprende no incluye
   * el canal; Crece y Escala sí. */
  channelEnabled: boolean;
  /** `https://api.…/webhooks/instagram` — el proveedor y el `?account=` los
   * añade {@link instagramCallbackUrl}. */
  callbackBaseUrl: string;
}

/** Los dos estados entre los que puede moverse una cuenta desde el admin.
 * `pending` no está a propósito — ver el comentario del esquema. */
export type InstagramAccountStatusInput = 'connected' | 'disabled';

/* -------------------------------------------------------------------------- */
/* Cuerpos de petición                                                         */
/* -------------------------------------------------------------------------- */

/** Refleja la unión discriminada del servidor. Se mantiene como unión, aunque
 * hoy tenga una sola rama, por lo mismo que allí: la segunda integración de
 * Meta no tiene `pageId` ni token de página, y un objeto de opcionales dejaría
 * que este formulario produjera hoy una conexión `graph` incapaz de enviar. */
export interface InstagramGraphConnectBody {
  provider: 'graph';
  igAccountId: string;
  pageId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  username: string;
}

export type InstagramConnectBody = InstagramGraphConnectBody;

/* -------------------------------------------------------------------------- */
/* Estado del formulario                                                       */
/* -------------------------------------------------------------------------- */

/**
 * El estado crudo del formulario de conexión.
 *
 * Como en `wompi-form.ts` y en `whatsapp-api.ts`, no hay una función inversa
 * `*ToFormState`: el `GET` no devuelve nunca una credencial de la que
 * rellenarlo, así que todos los campos secretos empiezan vacíos en cada
 * montaje, sin excepción.
 */
export interface InstagramFormFields {
  provider: InstagramProviderId;
  username: string;
  igAccountId: string;
  pageId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}

export const BLANK_INSTAGRAM_FORM: InstagramFormFields = {
  provider: 'graph',
  username: '',
  igAccountId: '',
  pageId: '',
  accessToken: '',
  appSecret: '',
  verifyToken: '',
};

/**
 * Pasa el estado del formulario al cuerpo del `POST`.
 *
 * Los valores van tal y como se escribieron, sin recortar: todos los campos de
 * `instagramConnectSchema` llevan `.trim()` en el servidor, así que recortar
 * aquí solo lo duplicaría — y `username` en particular se normaliza allí
 * (`@MiTienda` → `mitienda`), que no es algo que este formulario deba intentar
 * adivinar.
 */
export function buildInstagramConnectPayload(fields: InstagramFormFields): InstagramConnectBody {
  return {
    provider: 'graph',
    igAccountId: fields.igAccountId,
    pageId: fields.pageId,
    accessToken: fields.accessToken,
    appSecret: fields.appSecret,
    verifyToken: fields.verifyToken,
    username: fields.username,
  };
}

/* -------------------------------------------------------------------------- */
/* La URL de callback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * La URL exacta que el comerciante tiene que configurar en Meta.
 *
 * ## Por qué lleva `?account=<igAccountId>` y por qué no es opcional
 *
 * El saludo de suscripción de Meta es un `GET` con solo `hub.mode`,
 * `hub.verify_token` y `hub.challenge` — nada que identifique QUÉ cuenta se
 * está verificando. Una sola URL de webhook sirve a todos los inquilinos de la
 * plataforma (Meta entrega por app, no por cuenta), así que el `verify` de
 * `instagram-webhooks.controller.ts` busca la cuenta por el parámetro
 * `account` y responde 403 cuando falta. Una URL pegada sin él falla la
 * verificación siempre, con un error del lado de Meta que no dice nada de la
 * causa — que es justamente por lo que esto se construye en un solo sitio y se
 * prueba.
 *
 * Devuelve `null` si falta el id de la cuenta o la base: media URL de callback
 * es peor que ninguna, porque parece copiable.
 */
export function instagramCallbackUrl(
  callbackBaseUrl: string,
  provider: InstagramProviderId,
  igAccountId: string,
): string | null {
  const base = callbackBaseUrl.trim().replace(/\/+$/, '');
  if (!base) return null;

  const account = igAccountId.trim();
  if (!account) return null;
  return `${base}/${provider}?account=${encodeURIComponent(account)}`;
}

/* -------------------------------------------------------------------------- */
/* Etiquetas                                                                   */
/* -------------------------------------------------------------------------- */

/** El nombre de la integración tal y como el comerciante la encuentra en el
 * panel de Meta, no como lo deletrea el enum. */
export const INSTAGRAM_PROVIDER_LABEL: Record<InstagramProviderId, string> = {
  graph: 'Instagram con Facebook (Meta)',
};

const STATUS_LABELS: Record<string, string> = {
  connected: 'Conectada',
  disabled: 'Desactivada',
  pending: 'Pendiente de verificar',
};

/** Etiqueta es-CO del estado de una fila. Cae al valor crudo en vez de a una
 * palabra genérica: un estado que no reconocemos es exactamente lo que un
 * comerciante citaría en un ticket de soporte. */
export function instagramStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/* -------------------------------------------------------------------------- */
/* Peticiones                                                                  */
/* -------------------------------------------------------------------------- */

export function listInstagramAccounts(): Promise<InstagramAccountsResponse> {
  return apiFetch<InstagramAccountsResponse>('/v1/admin/instagram/accounts');
}

/** Conecta una cuenta, o vuelve a conectar una que esta tienda ya tiene (rotar
 * un token es reconectar — la API no tiene endpoint de edición de credenciales
 * a propósito). Una reconexión devuelve el MISMO id de fila, que es lo que
 * permite fundir el resultado en la lista en vez de añadir un duplicado. */
export function connectInstagramAccount(body: InstagramConnectBody): Promise<InstagramAccount> {
  return apiFetch<InstagramAccount>('/v1/admin/instagram/accounts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function setInstagramAccountStatus(
  id: string,
  status: InstagramAccountStatusInput,
): Promise<InstagramAccount> {
  return apiFetch<InstagramAccount>(`/v1/admin/instagram/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function disconnectInstagramAccount(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/admin/instagram/accounts/${id}`, { method: 'DELETE' });
}
