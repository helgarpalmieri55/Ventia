/**
 * El bloque de "PEGAR EN META": qué valores lleva y con qué forma se imprimen.
 *
 * Está aquí y no en el script que lo saca por pantalla porque es lo que se
 * copia LITERALMENTE en el panel de Meta. Un carácter de más en una URL de
 * callback no da ningún error visible: Meta la guarda, el handshake falla con
 * un 403 sin explicación, y quien graba lo descubre con la cámara puesta. Eso
 * se fija con pruebas o no se fija.
 */

import { readFileSync } from 'node:fs';
import { callbackInstagram, callbackWhatsApp, resolverUrlPublica } from './tunel.mjs';

// Los huecos van en MAYÚSCULAS y sin caracteres que haya que codificar: uno
// entre `<` y `>` sale de `encodeURIComponent` como `%3C...%3E`, que ya no se
// lee como un hueco sino como un valor raro, y hay quien lo pega tal cual.
//
// Además fallan RUIDOSAMENTE si se pegan por descuido: Meta manda el handshake,
// el controlador no encuentra ninguna cuenta con ese id y devuelve 403. Meta
// enseña el error en el acto. Eso es exactamente lo que se quiere de un hueco.
export const HUECO_IG = 'PEGA_AQUI_TU_INSTAGRAM_ACCOUNT_ID';
export const HUECO_WA = 'PEGA_AQUI_TU_PHONE_NUMBER_ID';
export const HUECO_TOKEN = 'PEGA_AQUI_EL_TOKEN_QUE_TE_INVENTES';
const HUECOS = new Set([HUECO_IG, HUECO_WA, HUECO_TOKEN]);

/**
 * El primer valor que traiga algo, tratando la cadena vacía como ausencia.
 *
 * `??` no vale aquí. `entorno.sh` deja `META_IG_VERIFY_TOKEN` definido aunque
 * esté vacío, y una línea `META_IG_VERIFY_TOKEN=` en el `.env` hace lo mismo:
 * con `??` esa cadena vacía GANARÍA sobre el `META_VERIFY_TOKEN` general, y el
 * bloque enseñaría un hueco teniendo el valor bueno al lado.
 */
export function primero(...valores) {
  for (const v of valores) {
    const limpio = String(v ?? '').trim();
    if (limpio) return limpio;
  }
  return '';
}

/** Lee la URL que dejó escrita el túnel. Un archivo que no existe es un estado
 * normal (aún no se ha levantado), no un error. */
export function leerArchivoTunel(entorno = process.env) {
  const ruta =
    primero(entorno.ARCHIVO_TUNEL) ||
    `${entorno.TMPDIR ?? '/tmp'}/ventia-demo-tunel-${process.getuid?.() ?? 0}.url`;
  try {
    return readFileSync(ruta, 'utf8');
  } catch {
    return '';
  }
}

/**
 * El bloque entero, ya formateado.
 *
 * Cuando los identificadores reales NO están puestos enseña la forma de la URL
 * con un hueco marcado, y NO enseña los valores de la demo sembrada. Es
 * deliberado: el handshake con la cuenta de demo SÍ pasaría —su token está en
 * la base— y Meta guardaría la URL tan contento, pero luego cada entrega real
 * vendría con el `entry[].id` de la cuenta de verdad, no encontraría fila y se
 * tiraría en silencio. Una URL que verifica y no entrega es la peor trampa
 * posible, así que aquí no se ofrece.
 */
export function bloqueParaMeta(entorno = process.env, archivo = leerArchivoTunel(entorno)) {
  const { url: base, origen } = resolverUrlPublica({ entorno: entorno.API_PUBLIC_URL, archivo });

  if (!base) {
    return [
      '',
      '  No hay URL pública, así que no hay nada que pegar en Meta todavía.',
      '',
      '  Levántala con:   pnpm run demo        (arranca el túnel y el API juntos)',
      '                   pnpm run demo:tunel  (solo el túnel, si el stack ya está arriba)',
      '',
    ].join('\n');
  }

  const cuenta = primero(entorno.META_IG_ACCOUNT_ID) || HUECO_IG;
  const numero = primero(entorno.META_WA_PHONE_NUMBER_ID) || HUECO_WA;
  const tokenIg = primero(entorno.META_IG_VERIFY_TOKEN, entorno.META_VERIFY_TOKEN) || HUECO_TOKEN;
  const tokenWa = primero(entorno.META_WA_VERIFY_TOKEN, entorno.META_VERIFY_TOKEN) || HUECO_TOKEN;
  const faltan = [cuenta, numero, tokenIg, tokenWa].some((v) => HUECOS.has(v));

  const regla = '  ' + '='.repeat(74);
  const lineas = [
    '',
    regla,
    '   PEGAR EN META',
    regla,
    `   URL pública del API   ${base}   (${origen === 'entorno' ? 'de API_PUBLIC_URL' : 'del túnel'})`,
    '',
    '   Instagram  ->  Webhooks  ->  URL de devolución de llamada',
    `     ${callbackInstagram({ base, cuenta })}`,
    '   Instagram  ->  Webhooks  ->  Token de verificación',
    `     ${tokenIg}`,
    '',
    '   WhatsApp  ->  Configuración  ->  URL de devolución de llamada',
    `     ${callbackWhatsApp({ base, numero })}`,
    '   WhatsApp  ->  Configuración  ->  Token de verificación',
    `     ${tokenWa}`,
    '',
    '   Campo a suscribir en los dos:  messages',
    regla,
  ];

  if (faltan) {
    lineas.push(
      '   Los PEGA_AQUI_ los rellenas tú con lo que enseña Meta: el account id en',
      '   Instagram -> Configuración de la API, el phone number id en WhatsApp ->',
      '   Configuración de la API, y el token de verificación te lo inventas.',
      '   Para verlos ya rellenos aquí, ponlos en el .env de la raíz:',
      '     META_IG_ACCOUNT_ID=...   META_WA_PHONE_NUMBER_ID=...   META_VERIFY_TOKEN=...',
      regla,
    );
  }

  lineas.push('   Antes de abrir Meta:   pnpm run demo:comprobar', '');
  return lineas.join('\n');
}
