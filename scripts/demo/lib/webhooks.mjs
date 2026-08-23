import { createHmac, randomBytes } from 'node:crypto';

/**
 * Construcción y firma de entregas de webhook de Meta para la demo.
 *
 * Todo lo que hay aquí es puro: entra un texto, sale un objeto y una cadena
 * firmada. Ni red, ni base de datos, ni relojes que no se puedan inyectar. Es
 * la única parte de `scripts/demo/` que se puede probar de verdad, y es
 * también la única que, si está mal, falla de forma invisible: un webhook con
 * la firma mala recibe un 200 igual que uno bueno (ver
 * `instagram-webhooks.controller.ts` — un payload que no verifica se tira en
 * silencio a propósito, para no decirle a quien llama sin autenticarse qué
 * cuentas atiende esta plataforma). Desde fuera no se distingue "lo contestó"
 * de "lo tiró", así que la corrección de esto se demuestra con pruebas, no
 * mirando la respuesta HTTP.
 *
 * ## El cuerpo CRUDO es el contrato
 *
 * `X-Hub-Signature-256` cubre los bytes exactos que viajan. Volver a
 * serializar el objeto para enviarlo, después de haber firmado otra
 * serialización, da otra cadena y una firma que no cuadra nunca. Por eso
 * {@link sobreInstagram} y {@link sobreWhatsApp} devuelven el CUERPO YA
 * SERIALIZADO junto a la cabecera, y quien envía manda ese string tal cual.
 */

/** `sha256=<hmac hex del cuerpo crudo con el app secret>`, el formato exacto
 * que espera `GraphProvider#verifySignature` y `CloudProvider#verifySignature`. */
export function firmar(cuerpoCrudo, appSecret) {
  return `sha256=${createHmac('sha256', appSecret).update(cuerpoCrudo, 'utf8').digest('hex')}`;
}

/** Un `mid` con la pinta de los de Meta (base64url) y único por llamada. Meta
 * reintenta con el MISMO mid, así que dos mensajes distintos de la demo tienen
 * que traer mids distintos o el segundo lo absorbe la deduplicación
 * (`@@unique([tenantId, externalId])` sobre Message) y parecerá que el agente
 * se quedó mudo. */
export function nuevoMid() {
  return `aWdfZG1f${randomBytes(24).toString('base64url')}`;
}

/** Lo mismo para WhatsApp, cuyos ids empiezan por `wamid.`. */
export function nuevoWamid() {
  return `wamid.${randomBytes(26).toString('base64url')}`;
}

/**
 * Una entrega de mensajería de Instagram con UN mensaje de texto.
 *
 * La forma es la que documenta Meta para el webhook de mensajería de
 * Instagram, y cada campo que lleva está porque el parseo lo mira:
 *
 *  - `object: 'instagram'` — sin esto `GraphProvider` devuelve `null` antes de
 *    nada; es lo que separa esta entrega de una de WhatsApp.
 *  - `entry[].id` — la clave de enrutamiento. El controlador la saca de aquí
 *    para encontrar el inquilino y el adaptador la vuelve a comparar contra la
 *    configuración; tienen que ser el mismo valor o la entrega se descarta.
 *  - `timestamp` en MILISEGUNDOS. La Messenger Platform manda ms (WhatsApp
 *    Cloud manda segundos) y de ahí sale la ventana de 24 horas. Un valor en
 *    segundos aquí se normalizaría multiplicando por 1000 y pondría el mensaje
 *    en 1970 — fuera de la ventana, sin respuesta y sin error visible.
 *  - `message.mid` — el id de deduplicación.
 */
export function payloadInstagram({ igAccountId, igsid, texto, mid = nuevoMid(), ahoraMs = Date.now() }) {
  return {
    object: 'instagram',
    entry: [
      {
        id: igAccountId,
        time: ahoraMs,
        messaging: [
          {
            sender: { id: igsid },
            recipient: { id: igAccountId },
            timestamp: ahoraMs,
            message: { mid, text: texto },
          },
        ],
      },
    ],
  };
}

/**
 * Una entrega de WhatsApp Cloud con UN mensaje de texto.
 *
 * `metadata.phone_number_id` es la clave de enrutamiento —lo que el
 * controlador busca y lo que `CloudProvider` vuelve a comprobar—, y
 * `timestamp` va en SEGUNDOS y como cadena, que es como lo manda Meta.
 * `contacts[].profile.name` es solo para mostrar; el adaptador lo recoge como
 * `pushName` y nunca lo usa para enrutar.
 */
export function payloadWhatsApp({
  phoneNumberId,
  wabaId,
  telefonoVisible,
  telefonoComprador,
  nombreComprador,
  texto,
  wamid = nuevoWamid(),
  ahoraMs = Date.now(),
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: telefonoVisible, phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: nombreComprador }, wa_id: telefonoComprador }],
              messages: [
                {
                  from: telefonoComprador,
                  id: wamid,
                  timestamp: String(Math.floor(ahoraMs / 1000)),
                  type: 'text',
                  text: { body: texto },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * El sobre listo para enviar: ruta, cuerpo crudo y cabeceras.
 *
 * Devuelve `cuerpo` como string y NO como objeto justamente para que quien
 * envía no pueda re-serializarlo sin darse cuenta.
 */
export function sobreInstagram(cfg, texto, opciones = {}) {
  const payload = payloadInstagram({
    igAccountId: cfg.igAccountId,
    igsid: opciones.igsid ?? cfg.compradorIgsid,
    texto,
    ...(opciones.mid ? { mid: opciones.mid } : {}),
    ...(opciones.ahoraMs ? { ahoraMs: opciones.ahoraMs } : {}),
  });
  const cuerpo = JSON.stringify(payload);
  return {
    ruta: `/webhooks/instagram/${cfg.proveedor}`,
    cuerpo,
    mid: payload.entry[0].messaging[0].message.mid,
    cabeceras: {
      'content-type': 'application/json',
      'x-hub-signature-256': firmar(cuerpo, cfg.appSecret),
    },
  };
}

export function sobreWhatsApp(cfg, texto, opciones = {}) {
  const payload = payloadWhatsApp({
    phoneNumberId: cfg.externalId,
    wabaId: cfg.wabaId,
    telefonoVisible: cfg.telefonoVisible,
    telefonoComprador: opciones.telefono ?? cfg.compradorTelefono,
    nombreComprador: opciones.nombre ?? cfg.compradorNombre,
    texto,
    ...(opciones.wamid ? { wamid: opciones.wamid } : {}),
    ...(opciones.ahoraMs ? { ahoraMs: opciones.ahoraMs } : {}),
  });
  const cuerpo = JSON.stringify(payload);
  return {
    ruta: `/webhooks/whatsapp/${cfg.proveedor}`,
    cuerpo,
    mid: payload.entry[0].changes[0].value.messages[0].id,
    cabeceras: {
      'content-type': 'application/json',
      'x-hub-signature-256': firmar(cuerpo, cfg.appSecret),
    },
  };
}
