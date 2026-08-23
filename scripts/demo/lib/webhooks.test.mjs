import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  firmar,
  nuevoMid,
  nuevoWamid,
  payloadInstagram,
  payloadWhatsApp,
  sobreInstagram,
  sobreWhatsApp,
} from './webhooks.mjs';
import { GraphProvider, isWithinMessagingWindow } from '../../../packages/instagram/dist/index.js';
import { CloudProvider } from '../../../packages/whatsapp/dist/index.js';

/**
 * Estas pruebas no comprueban el simulador contra una copia de lo que creo que
 * hace Meta: lo comprueban contra el CÓDIGO DE PRODUCCIÓN que va a recibir la
 * entrega — `GraphProvider` y `CloudProvider` de verdad, importados de su
 * `dist/`. Es la única forma de que "la firma es correcta" signifique algo:
 * una firma mala recibe un 200 igual que una buena (el controlador tira los
 * payloads que no verifican en silencio, a propósito), así que no hay ninguna
 * señal por HTTP que distinguirlas.
 *
 * Requieren que los paquetes estén construidos: `pnpm build` o
 * `turbo run build --filter=@ventia/instagram --filter=@ventia/whatsapp`.
 * El script `pnpm run demo:test` de la raíz lo hace antes de correrlas.
 */

const IG = {
  proveedor: 'graph',
  igAccountId: '17841400000000091',
  appSecret: '5f2c9a1d4b7e8036demo-ig-app-secret',
  compradorIgsid: '7351902348571106',
};
const igConfig = { igAccountId: IG.igAccountId, token: 'x', appSecret: IG.appSecret };

const WA = {
  proveedor: 'cloud',
  externalId: '109300000000091',
  wabaId: '115000000000091',
  telefonoVisible: '+57 300 214 8890',
  appSecret: '8a41d7c2e9b6035demo-wa-app-secret',
  compradorTelefono: '573114458820',
  compradorNombre: 'Andrés Melo',
};
const waConfig = { externalId: WA.externalId, token: 'x', appSecret: WA.appSecret };

describe('firmar', () => {
  it('produce el formato sha256=<hex> que espera el verificador de Meta', () => {
    const firma = firmar('{"a":1}', 'secreto');
    const esperado = createHmac('sha256', 'secreto').update('{"a":1}', 'utf8').digest('hex');
    assert.equal(firma, `sha256=${esperado}`);
    assert.match(firma, /^sha256=[0-9a-f]{64}$/);
  });

  it('cambia si cambia un solo byte del cuerpo', () => {
    assert.notEqual(firmar('{"a":1}', 's'), firmar('{"a":2}', 's'));
  });

  it('cambia si cambia el secreto', () => {
    assert.notEqual(firmar('{"a":1}', 's1'), firmar('{"a":1}', 's2'));
  });
});

describe('sobreInstagram, contra el GraphProvider real', () => {
  it('el adaptador de producción lo verifica y saca el mensaje', () => {
    const sobre = sobreInstagram(IG, '¿Tienen café de Nariño?');
    const mensajes = new GraphProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, igConfig);

    assert.notEqual(mensajes, null, 'la firma tiene que verificar');
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0].text, '¿Tienen café de Nariño?');
    assert.equal(mensajes[0].from, IG.compradorIgsid);
    assert.equal(mensajes[0].externalId, sobre.mid);
  });

  it('la ruta es la del proveedor', () => {
    assert.equal(sobreInstagram(IG, 'hola').ruta, '/webhooks/instagram/graph');
  });

  it('firma el cuerpo EXACTO que se envía, no una segunda serialización', () => {
    const sobre = sobreInstagram(IG, 'con acentos: ñáéíóú y "comillas"');
    assert.equal(sobre.cabeceras['x-hub-signature-256'], firmar(sobre.cuerpo, IG.appSecret));
    // Y el cuerpo tiene que ser una cadena, no un objeto: si se devolviera el
    // objeto, quien envía lo re-serializaría y la firma dejaría de cuadrar.
    assert.equal(typeof sobre.cuerpo, 'string');
  });

  it('un cuerpo alterado después de firmar lo rechaza el adaptador', () => {
    const sobre = sobreInstagram(IG, 'precio original');
    const alterado = sobre.cuerpo.replace('precio original', 'precio alterado');
    assert.notEqual(alterado, sobre.cuerpo);
    const mensajes = new GraphProvider().verifyAndParseWebhook(alterado, sobre.cabeceras, igConfig);
    assert.equal(mensajes, null);
  });

  it('firmado con otro app secret, el adaptador lo rechaza', () => {
    const sobre = sobreInstagram({ ...IG, appSecret: 'otro-secreto' }, 'hola');
    const mensajes = new GraphProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, igConfig);
    assert.equal(mensajes, null);
  });

  it('dirigido a otra cuenta, verifica pero no produce mensajes', () => {
    // Distinto de `null`: la entrega es auténtica, simplemente no es de esta
    // cuenta. El adaptador lo distingue y el controlador también.
    const sobre = sobreInstagram({ ...IG, igAccountId: '17841400000000999' }, 'hola');
    const mensajes = new GraphProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, igConfig);
    assert.deepEqual(mensajes, []);
  });

  it('sin cabecera de firma, rechazado', () => {
    const sobre = sobreInstagram(IG, 'hola');
    const mensajes = new GraphProvider().verifyAndParseWebhook(sobre.cuerpo, {}, igConfig);
    assert.equal(mensajes, null);
  });
});

describe('la marca de tiempo de Instagram va en milisegundos', () => {
  it('sentAtMs sale igual al ahoraMs que se le pasó', () => {
    const ahoraMs = 1_780_000_000_000;
    const sobre = sobreInstagram(IG, 'hola', { ahoraMs });
    const [mensaje] = new GraphProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, igConfig);
    assert.equal(mensaje.sentAtMs, ahoraMs);
  });

  it('el payload lleva la marca EN MILISEGUNDOS, no en segundos', () => {
    // Hay que mirar el payload CRUDO y no lo que sale del adaptador:
    // `normalizeTimestampMs` deduce la unidad por el orden de magnitud y
    // convierte los segundos a milisegundos, así que un simulador que mandara
    // segundos pasaría igual por el parseo — y estaría mintiendo sobre lo que
    // manda Meta, que es lo único que este simulador existe para reproducir.
    const ahoraMs = 1_780_000_000_123;
    const payload = payloadInstagram({ igAccountId: 'a', igsid: 'b', texto: 'c', ahoraMs });
    const evento = payload.entry[0].messaging[0];
    assert.equal(evento.timestamp, ahoraMs);
    assert.ok(evento.timestamp > 1e12, 'por debajo de 1e12 el parseo lo leería como segundos');
    assert.equal(payload.entry[0].time, ahoraMs);
  });

  it('un mensaje de hace 25 horas queda FUERA de la ventana de 24 h', () => {
    // El caso que hace que el agente no conteste sin decir por qué. Si el
    // simulador mandara segundos donde Meta manda milisegundos, TODO mensaje
    // caería aquí.
    const ahora = Date.now();
    const sobre = sobreInstagram(IG, 'hola', { ahoraMs: ahora - 25 * 60 * 60 * 1000 });
    const [mensaje] = new GraphProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, igConfig);
    assert.equal(isWithinMessagingWindow(mensaje.sentAtMs, ahora), false);
  });

  it('un mensaje de ahora mismo queda DENTRO de la ventana', () => {
    const ahora = Date.now();
    const sobre = sobreInstagram(IG, 'hola', { ahoraMs: ahora });
    const [mensaje] = new GraphProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, igConfig);
    assert.equal(isWithinMessagingWindow(mensaje.sentAtMs, ahora), true);
  });
});

describe('identificadores de mensaje', () => {
  it('nuevoMid no se repite entre llamadas', () => {
    const vistos = new Set(Array.from({ length: 500 }, () => nuevoMid()));
    assert.equal(vistos.size, 500);
  });

  it('nuevoWamid tampoco, y lleva el prefijo de Meta', () => {
    const vistos = new Set(Array.from({ length: 500 }, () => nuevoWamid()));
    assert.equal(vistos.size, 500);
    assert.ok(nuevoWamid().startsWith('wamid.'));
  });

  it('dos envíos seguidos con el mismo texto traen mids distintos', () => {
    // Si se repitieran, la deduplicación por `@@unique([tenantId,
    // externalId])` se comería el segundo y en cámara parecería que el agente
    // dejó de contestar.
    assert.notEqual(sobreInstagram(IG, 'hola').mid, sobreInstagram(IG, 'hola').mid);
    assert.notEqual(sobreWhatsApp(WA, 'hola').mid, sobreWhatsApp(WA, 'hola').mid);
  });

  it('un mid fijado a mano se respeta, para poder provocar un duplicado', () => {
    assert.equal(sobreInstagram(IG, 'hola', { mid: 'fijo-1' }).mid, 'fijo-1');
    assert.equal(sobreWhatsApp(WA, 'hola', { wamid: 'fijo-2' }).mid, 'fijo-2');
  });
});

describe('sobreWhatsApp, contra el CloudProvider real', () => {
  it('el adaptador de producción lo verifica y saca el mensaje', () => {
    const sobre = sobreWhatsApp(WA, '¿Hacen envíos a Cali?');
    const mensajes = new CloudProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, waConfig);

    assert.notEqual(mensajes, null);
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0].text, '¿Hacen envíos a Cali?');
    assert.equal(mensajes[0].from, WA.compradorTelefono);
    assert.equal(mensajes[0].externalId, sobre.mid);
    assert.equal(mensajes[0].pushName, WA.compradorNombre);
  });

  it('la ruta es la del proveedor', () => {
    assert.equal(sobreWhatsApp(WA, 'hola').ruta, '/webhooks/whatsapp/cloud');
  });

  it('un cuerpo alterado después de firmar lo rechaza el adaptador', () => {
    const sobre = sobreWhatsApp(WA, 'texto original');
    const alterado = sobre.cuerpo.replace('texto original', 'texto alterado');
    assert.equal(new CloudProvider().verifyAndParseWebhook(alterado, sobre.cabeceras, waConfig), null);
  });

  it('dirigido a otro número, verifica pero no produce mensajes', () => {
    const sobre = sobreWhatsApp({ ...WA, externalId: '109300000000999' }, 'hola');
    assert.deepEqual(
      new CloudProvider().verifyAndParseWebhook(sobre.cuerpo, sobre.cabeceras, waConfig),
      [],
    );
  });

  it('la marca de tiempo va en SEGUNDOS y como cadena, que es como la manda Meta', () => {
    const ahoraMs = 1_780_000_000_000;
    const payload = payloadWhatsApp({
      phoneNumberId: WA.externalId,
      wabaId: WA.wabaId,
      telefonoVisible: WA.telefonoVisible,
      telefonoComprador: WA.compradorTelefono,
      nombreComprador: WA.compradorNombre,
      texto: 'hola',
      ahoraMs,
    });
    const ts = payload.entry[0].changes[0].value.messages[0].timestamp;
    assert.equal(typeof ts, 'string');
    assert.equal(ts, '1780000000');
  });
});

describe('la forma del payload es la que el parseo exige', () => {
  it('Instagram se marca con object=instagram', () => {
    // Sin esto, `GraphProvider` devuelve null antes de mirar nada más — y un
    // payload de WhatsApp parseado por el canal de Instagram sería una tienda
    // contestando por el canal equivocado.
    assert.equal(payloadInstagram({ igAccountId: 'a', igsid: 'b', texto: 'c' }).object, 'instagram');
  });

  it('WhatsApp se marca con object=whatsapp_business_account', () => {
    const payload = payloadWhatsApp({
      phoneNumberId: 'a',
      wabaId: 'b',
      telefonoVisible: '+57 1',
      telefonoComprador: '57300',
      nombreComprador: 'n',
      texto: 'c',
    });
    assert.equal(payload.object, 'whatsapp_business_account');
  });

  it('la clave de enrutamiento de Instagram va en entry[].id', () => {
    const payload = payloadInstagram({ igAccountId: 'CUENTA', igsid: 'b', texto: 'c' });
    assert.equal(payload.entry[0].id, 'CUENTA');
  });

  it('la clave de enrutamiento de WhatsApp va en metadata.phone_number_id', () => {
    const payload = payloadWhatsApp({
      phoneNumberId: 'NUMERO',
      wabaId: 'b',
      telefonoVisible: '+57 1',
      telefonoComprador: '57300',
      nombreComprador: 'n',
      texto: 'c',
    });
    assert.equal(payload.entry[0].changes[0].value.metadata.phone_number_id, 'NUMERO');
  });

  it('el remitente NO es la cuenta de la tienda', () => {
    // Un mensaje cuyo `sender.id` es la propia cuenta lo descarta el parseo
    // como eco: sería el agente hablando solo, para siempre.
    const payload = payloadInstagram({ igAccountId: 'CUENTA', igsid: 'COMPRADOR', texto: 'c' });
    assert.notEqual(payload.entry[0].messaging[0].sender.id, 'CUENTA');
  });
});
