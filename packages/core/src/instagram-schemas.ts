import { z } from 'zod';

/**
 * Esquemas del flujo de conexión de la cuenta de Instagram, solo para el
 * dueño de la tienda.
 *
 * Alimentan dos cosas: la fila `InstagramAccount` (`igAccountId`, `pageId`,
 * `username`, `status`, `verifyToken`, `credentialsEnc`) y —una vez descifrado
 * otra vez en el momento de enviar— `InstagramConfig` en
 * `packages/instagram/src/index.ts`. Cada campo de aquí termina o en una ruta
 * de URL, o en una cabecera HTTP, o en la columna `@unique` por la que se
 * enruta, y por eso los límites son más estrechos que "una cadena cualquiera".
 */

/* -------------------------------------------------------------------------- */
/* El @usuario                                                                 */
/* -------------------------------------------------------------------------- */

/** Las reglas de Instagram para un nombre de usuario: de 1 a 30 caracteres,
 * letras, números, puntos y guiones bajos. Nada más. */
const INSTAGRAM_USERNAME_RE = /^[a-z0-9._]{1,30}$/;

/**
 * Normaliza el @usuario a como Instagram lo guarda: sin la arroba y en
 * minúsculas.
 *
 * Un comerciante lo va a escribir `@MiTienda`, `mitienda` o pegando la URL del
 * perfil; las tres son la misma cuenta, y verlas escritas de tres formas en la
 * misma lista es exactamente el tipo de duda que acaba en un ticket de
 * soporte. Instagram no distingue mayúsculas en los nombres de usuario, así
 * que bajarlo todo a minúsculas no pierde información.
 *
 * Devuelve `null` si no es un nombre de usuario posible. Esto es SOLO para
 * mostrar: el enrutamiento es siempre `igAccountId`, así que un @usuario mal
 * escrito no rompe el canal — pero sí hace que el comerciante no reconozca qué
 * cuenta conectó, que es el único trabajo que tiene este campo.
 */
export function normalizeInstagramUsername(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  // Una URL de perfil pegada: `https://instagram.com/mitienda/?hl=es`.
  const fromUrl = /^https?:\/\/(?:www\.)?instagram\.com\/([^/?#]+)/.exec(value);
  if (fromUrl) value = fromUrl[1]!;
  if (value.startsWith('@')) value = value.slice(1);
  value = value.replace(/\/+$/, '');

  return INSTAGRAM_USERNAME_RE.test(value) ? value : null;
}

export const instagramUsernameSchema = z
  .string()
  .trim()
  // Antes del transform, para que un párrafo pegado se rechace por longitud en
  // vez de arrastrarse por el normalizador. 120 da de sobra para una URL de
  // perfil con parámetros.
  .max(120)
  .transform((raw, ctx) => {
    const normalized = normalizeInstagramUsername(raw);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Debe ser el nombre de usuario de tu cuenta de Instagram (por ejemplo @mitienda): hasta 30 caracteres, solo letras, números, puntos y guiones bajos.',
      });
      return z.NEVER;
    }
    return normalized;
  });

/* -------------------------------------------------------------------------- */
/* Secretos                                                                    */
/* -------------------------------------------------------------------------- */

/** Todo lo que acaba siendo el valor de una cabecera HTTP (`Authorization:
 * Bearer …`) no puede llevar un carácter de control ni un salto de línea:
 * CR/LF en una cabecera es inyección de cabeceras, y un tabulador o un NUL
 * sueltos solo producen un 400 opaco del proveedor horas más tarde. Rechazarlo
 * en el formulario es donde el comerciante todavía puede ver qué campo pegó
 * mal. Igual que en `whatsapp-schemas.ts`, y duplicado a propósito: son dos
 * formularios distintos, y compartirlo haría que tocar uno moviera el otro. */
const NO_CONTROL_CHARS_RE = /^[^\u0000-\u001f\u007f]+$/;

const headerSafeSecret = (max: number) =>
  z.string().trim().min(8).max(max).regex(NO_CONTROL_CHARS_RE, {
    message: 'No puede contener saltos de línea ni caracteres de control',
  });

/** Los ids que emite Meta son numéricos, y esto es un límite de seguridad y no
 * de orden: `igAccountId` se interpola tal cual en una ruta de URL
 * (`graph.facebook.com/v21.0/{igAccountId}/messages`), así que una barra o un
 * `..` ahí dentro reapuntarían el envío a otro endpoint de la Graph API. */
const metaNumericId = (label: string) =>
  z
    .string()
    .trim()
    .min(5)
    .max(32)
    .regex(/^\d+$/, { message: `${label} de Meta son solo dígitos` });

/* -------------------------------------------------------------------------- */
/* Conectar una cuenta                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cuerpo de `POST /v1/admin/instagram/accounts` (solo el dueño, con la puerta
 * de plan en `TenantLimits.instagramChannel`).
 *
 * Es una unión discriminada por `provider` con una sola rama, y no un objeto
 * plano, por la misma razón por la que `InstagramProviderId` es un enum en la
 * base de datos: la segunda integración de Meta (Instagram Login) no tiene
 * `pageId` ni token de página, así que el día que entre, sus campos
 * obligatorios son otros. Con una unión eso es una rama nueva; con un objeto
 * de opcionales sería un `pageId?` que dejaría guardar hoy una conexión de
 * `graph` incapaz de enviar nada.
 */
export const instagramConnectSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('graph'),
    /** LA clave de enrutamiento: se guarda en `InstagramAccount.igAccountId`,
     * es `@unique` global, y se compara contra `entry[].id` en cada entrega. */
    igAccountId: metaNumericId('El ID de la cuenta de Instagram'),
    /** La página de Facebook vinculada. Obligatoria en esta rama: es de donde
     * sale el token y sobre lo que se suscribe el webhook, así que una
     * conexión `graph` sin página no es una conexión a medias, es una que no
     * puede existir. */
    pageId: metaNumericId('El ID de la página de Facebook'),
    /** Token de acceso de la página, va como `Authorization: Bearer`. Los
     * tokens de Meta pasan de 200 caracteres, así que 512 deja margen sin
     * llegar a aceptar un archivo pegado. */
    accessToken: headerSafeSecret(512),
    /** El app secret de Meta — la llave HMAC de `X-Hub-Signature-256`. Hoy son
     * 32 caracteres hexadecimales; el límite es generoso a propósito, para que
     * un cambio de formato no deje el formulario inservible. */
    appSecret: headerSafeSecret(128),
    /** Se devuelve tal cual en el saludo GET de Meta, así que es texto elegido
     * por el comerciante que SALE de nuestro sistema. `min(8)` porque un token
     * de verificación de dos caracteres es un secreto compartido solo de
     * nombre: quien lo adivine completa el saludo contra este endpoint. */
    verifyToken: headerSafeSecret(128),
    username: instagramUsernameSchema,
  }),
]);

/* -------------------------------------------------------------------------- */
/* Actualizar una cuenta ya conectada                                          */
/* -------------------------------------------------------------------------- */

/** Los dos estados entre los que el dueño puede mover una cuenta desde el
 * admin. El tercero que lleva la columna, `pending`, no está aquí a propósito:
 * es el estado en el que se CREA una fila y del que se sale verificando, no
 * pulsando un botón. */
export const INSTAGRAM_ACCOUNT_STATUSES = ['connected', 'disabled'] as const;
export type InstagramAccountStatus = (typeof INSTAGRAM_ACCOUNT_STATUSES)[number];

/**
 * Cuerpo de `PATCH /v1/admin/instagram/accounts/:id` — activar o desactivar
 * una cuenta ya conectada.
 *
 * Solo el estado. Las credenciales no se editan en sitio a propósito: rotar un
 * token es volver a conectar, y hacerlo por aquí dejaría un juego de
 * credenciales a medias (token nuevo, app secret viejo) vivo entre dos
 * peticiones.
 */
export const instagramAccountUpdateSchema = z.object({
  status: z.enum(INSTAGRAM_ACCOUNT_STATUSES),
});

export type InstagramConnectInput = z.infer<typeof instagramConnectSchema>;
export type InstagramAccountUpdateInput = z.infer<typeof instagramAccountUpdateSchema>;
