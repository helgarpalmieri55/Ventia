import { INSTAGRAM_MAX_CHARS } from '@ventia/instagram';
import { renderForWhatsApp, type WhatsAppRenderInput } from '../agent/whatsapp-render';

/**
 * Convierte un turno del agente en los cuerpos de mensaje que se le mandan por
 * Instagram, en orden.
 *
 * ## Por qué reutiliza el renderizador de WhatsApp en vez de copiarlo
 *
 * La propiedad por la que existe ese módulo no es "texto para WhatsApp": es
 * que cada nombre, precio, disponibilidad y enlace sale de un RESULTADO DE
 * HERRAMIENTA y nunca de la prosa del modelo, para que un precio alucinado no
 * pueda llegarle a un comprador aunque falle la regla del prompt. Esa garantía
 * es del renderizador, no del canal, y tiene que sobrevivir al cambio de
 * canal — si no, Instagram sería la única superficie donde lo que el modelo
 * dice sobre un precio es lo que el comprador ve.
 *
 * Los dos canales son texto plano sin markdown, así que el trabajo es el
 * mismo. Copiarlo habría duplicado justo la parte delicada.
 *
 * ## Lo único que cambia: 1000 caracteres, no 4096
 *
 * Instagram corta los mensajes de texto en 1000 caracteres. Es una diferencia
 * que rompe el canal en producción y de la peor manera: Meta rechaza el
 * mensaje ENTERO, así que el comprador no recibe la mitad, no recibe nada.
 *
 * Así que este módulo vuelve a partir lo que devolvió `renderForWhatsApp`. Es
 * un segundo pase sobre mensajes que ya son unidades con sentido (la prosa, la
 * lista de productos, el enlace al carrito), no un troceado ciego: los que
 * caben salen intactos, y solo se parte lo que no cabe — por párrafos, luego
 * por líneas, luego por palabras, en ese orden.
 */

/** Los mismos separadores, y en el mismo orden de preferencia, que usa
 * `whatsapp-render.ts`: párrafo, línea, palabra. El orden importa — partir una
 * lista numerada por la mitad de una línea deja media línea de precio, y media
 * línea de precio es un precio equivocado. */
const SEPARATORS = ['\n\n', '\n', ' '] as const;

export function renderForInstagram(reply: WhatsAppRenderInput, storefrontBaseUrl: string): string[] {
  return renderForWhatsApp(reply, storefrontBaseUrl)
    .flatMap((body) => chunkText(body, INSTAGRAM_MAX_CHARS, SEPARATORS))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/**
 * Parte `text` en trozos de como mucho `limit` caracteres, probando los
 * separadores en orden y cayendo al corte duro solo cuando ni siquiera una
 * palabra cabe.
 *
 * Copia deliberada del helper homónimo de `whatsapp-render.ts`, que no está
 * exportado. Se copia y no se exporta desde allí por lo mismo que ese módulo
 * copia su propio `formatCOP`: es la convención de este repositorio para
 * ayudantes de este tamaño, y exportarlo convertiría un detalle interno de
 * aquel módulo en una API que este canal podría fijar sin querer.
 */
function chunkText(text: string, limit: number, separators: readonly string[]): string[] {
  if (text.length <= limit) return [text];

  const [separator, ...rest] = separators;
  if (separator === undefined) {
    const slices: string[] = [];
    for (let index = 0; index < text.length; index += limit) slices.push(text.slice(index, index + limit));
    return slices;
  }

  const chunks: string[] = [];
  let current = '';
  for (const piece of text.split(separator)) {
    const candidate = current === '' ? piece : `${current}${separator}${piece}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
    // El trozo suelto puede seguir siendo demasiado largo: se baja al
    // siguiente separador y se deja su cola abierta para que el siguiente
    // trozo pueda compartir ese último bloque.
    const sub = chunkText(piece, limit, rest);
    chunks.push(...sub.slice(0, -1));
    current = sub[sub.length - 1] ?? '';
  }
  if (current !== '') chunks.push(current);
  return chunks;
}
