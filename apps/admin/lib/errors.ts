import type { ApiError } from './api';

/** es-CO copy for every error code the API is known to emit (see
 * services/api/src/**\/*.ts for the `error: '...'` literals), plus the
 * client-only NETWORK/UNKNOWN codes from {@link ApiError}. Unrecognized
 * codes fall back to a generic message rather than leaking a raw code to
 * the merchant. */
const MESSAGES: Record<string, string> = {
  PLAN_LIMIT_EXCEEDED: 'Alcanzaste el límite de tu plan. Mejora tu plan para continuar.',
  VALIDATION_FAILED: 'Revisa los campos marcados.',
  FORBIDDEN_ROLE: 'No tienes permisos para esta acción.',
  TENANT_SUSPENDED: 'Tu tienda está suspendida. Contacta soporte.',
  SLUG_TAKEN: 'Esa URL ya está en uso. Elige otra.',
  SKU_TAKEN: 'Ese SKU ya está en uso. Elige otro.',
  IMAGE_LIMIT: 'Alcanzaste el límite de imágenes permitido.',
  INVITE_INVALID: 'La invitación no es válida o ya expiró.',
  INVITE_EXISTS: 'Ya existe una invitación pendiente para este correo.',
  ALREADY_MEMBER: 'Esta persona ya pertenece al equipo.',
  ALREADY_HAS_TENANT: 'Ya tienes una tienda registrada.',
  CANNOT_REMOVE_OWNER: 'No puedes eliminar al propietario de la tienda.',
  NOT_FOUND: 'No encontramos lo que buscabas.',
  TENANT_NOT_FOUND: 'No encontramos la tienda.',
  NO_TENANT: 'No tienes una tienda asociada a tu cuenta.',
  UNAUTHENTICATED: 'Debes iniciar sesión para continuar.',
  STOCK_BELOW_ZERO: 'El inventario no puede quedar en negativo.',
  INVALID_TRANSITION: 'Esta acción ya no es válida para el estado actual del pedido. Actualiza la página.',
  ONLINE_PAYMENT_PENDING:
    'Este pedido se paga en línea y su pago aún no se ha confirmado. Se confirmará automáticamente cuando la pasarela reporte el pago.',
  ORDER_NOT_FOUND: 'No encontramos este pedido.',
  INVALID_UPLOAD: 'El archivo subido no es válido.',
  CSV_TOO_LARGE: 'El archivo CSV supera el tamaño permitido.',
  CSV_INVALID: 'El archivo CSV tiene un formato inválido.',
  LAUNCH_CHECKLIST_INCOMPLETE: 'Completa la lista de lanzamiento antes de continuar.',
  // The `externalId` unique constraint on WhatsAppNumber: another store already
  // registered this phone number ID / instance. Named as a mis-typed identifier
  // first, because that is the overwhelmingly likely cause — and taking the
  // number over silently would break the other store's routing, so there is
  // nothing this merchant can do from here except check what they pasted.
  WHATSAPP_NUMBER_ALREADY_CONNECTED:
    'Ese número ya está conectado en otra tienda. Revisa el identificador que ingresaste; si de verdad es tuyo, contacta soporte.',
  WHATSAPP_NUMBER_NOT_FOUND: 'No encontramos este número de WhatsApp. Actualiza la página.',
  NETWORK: 'No pudimos conectar con el servidor. Verifica tu conexión.',
  UNKNOWN: 'Ocurrió un error inesperado. Intenta de nuevo.',
};

/** Maps an {@link ApiError} code to an es-CO message safe to show a merchant. */
export function errorMessage(e: ApiError): string {
  return MESSAGES[e.code] ?? MESSAGES.UNKNOWN;
}

interface ZodFlatten {
  formErrors?: unknown;
  fieldErrors?: Record<string, unknown>;
}

function isZodFlatten(value: unknown): value is ZodFlatten {
  return typeof value === 'object' && value !== null;
}

/** Extracts a `{ field: message }` map from a VALIDATION_FAILED error's
 * `details`, which the API populates with zod's `.flatten()` shape
 * (`{ formErrors: string[], fieldErrors: Record<string, string[]> }`).
 * Returns `{}` for any other shape (missing/absent fieldErrors). */
export function fieldErrors(e: ApiError): Record<string, string> {
  const details = e.details;
  if (!isZodFlatten(details) || !details.fieldErrors) return {};

  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(details.fieldErrors)) {
    if (Array.isArray(messages) && typeof messages[0] === 'string') {
      result[field] = messages[0];
    }
  }
  return result;
}
