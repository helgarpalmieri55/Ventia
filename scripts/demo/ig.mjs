#!/usr/bin/env node
/**
 * Simulador de un mensaje directo de Instagram entrante.
 *
 * Construye una entrega de webhook con la forma exacta que documenta Meta, la
 * firma con `X-Hub-Signature-256` usando el app secret que el seed dejó
 * cifrado en la fila `InstagramAccount`, y la publica en el API local. A
 * partir de ahí no hay nada simulado: el controlador la verifica, la enruta al
 * inquilino, el agente contesta y la conversación aparece en el panel.
 *
 * Uso:
 *   node scripts/demo/ig.mjs "¿Tienen café de Nariño?"
 *   node scripts/demo/ig.mjs --igsid 9988776655 "Hola"     # otro comprador
 *   node scripts/demo/ig.mjs --sin-esperar "Hola"          # no espera respuesta
 *   node scripts/demo/ig.mjs --saludo                      # el handshake GET de Meta
 *
 * ## Lo que este script NO puede hacer, y conviene saber antes de grabar
 *
 * La respuesta del agente SALE hacia `graph.facebook.com` con un token falso,
 * así que Meta la rechaza y el canal lo registra como un fallo de envío. Eso
 * no afecta a lo que se ve: `AgentService` guarda la respuesta ANTES de
 * enviarla, así que la conversación completa —pregunta y respuesta— está en el
 * panel y es lo que se graba. Ver el mensaje llegar dentro de la app de
 * Instagram exige credenciales reales de Meta; eso no se puede fingir desde
 * aquí y no se intenta.
 */

import { cargarConfig, apiBase } from './lib/config.mjs';
import { sobreInstagram } from './lib/webhooks.mjs';
import { enviar, esperarRespuesta, pintarTurno } from './lib/cli.mjs';

const cfg = cargarConfig();
const ig = cfg.instagram;

const args = process.argv.slice(2);
const opciones = { igsid: ig.compradorIgsid, esperar: true, saludo: false };
const libres = [];
for (let i = 0; i < args.length; i++) {
  // `pnpm run demo:ig -- "hola"` mete un `--` suelto en argv; sin esto
  // acabaría dentro del texto del mensaje.
  if (args[i] === '--') continue;
  else if (args[i] === '--igsid') opciones.igsid = args[++i];
  else if (args[i] === '--sin-esperar') opciones.esperar = false;
  else if (args[i] === '--saludo') opciones.saludo = true;
  else if (args[i] === '--ayuda' || args[i] === '-h') opciones.ayuda = true;
  else libres.push(args[i]);
}

if (opciones.ayuda) {
  console.log(`
  Simula un mensaje directo de Instagram hacia la tienda de demo.

    node scripts/demo/ig.mjs "tu mensaje"
    node scripts/demo/ig.mjs --igsid <IGSID> "tu mensaje"   otro comprador
    node scripts/demo/ig.mjs --sin-esperar "tu mensaje"     no espera la respuesta
    node scripts/demo/ig.mjs --saludo                       repite el handshake GET de Meta
`);
  process.exit(0);
}

if (opciones.saludo) {
  // El saludo de suscripción: Meta llama por GET con un reto y solo guarda la
  // URL si se le devuelve tal cual, en texto plano. Es lo primero que hay que
  // enseñar en la grabación de la configuración del webhook.
  const reto = String(Math.floor(Math.random() * 1e9));
  const url = new URL(`${apiBase(cfg)}/webhooks/instagram/${ig.proveedor}`);
  url.searchParams.set('account', ig.igAccountId);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', ig.verifyToken);
  url.searchParams.set('hub.challenge', reto);

  const res = await fetch(url).catch((err) => {
    console.error(`\n  No se pudo contactar el API: ${err.message}\n`);
    process.exit(1);
  });
  const cuerpo = (await res.text()).trim();
  console.log(`\n  GET ${url.pathname}${url.search}`);
  console.log(`  -> ${res.status} ${cuerpo}`);
  console.log(cuerpo === reto ? '\n  El reto se devolvió tal cual: Meta guardaría esta URL.\n' : '\n  El reto NO coincide: Meta rechazaría esta URL.\n');
  process.exit(cuerpo === reto ? 0 : 1);
}

const texto = libres.join(' ').trim();
if (!texto) {
  console.error('\n  Falta el texto del mensaje.  Ej.: node scripts/demo/ig.mjs "¿Hacen envíos a Cali?"\n');
  process.exit(1);
}

const sobre = sobreInstagram(ig, texto, { igsid: opciones.igsid });
await enviar(cfg, sobre);

console.log(`\n  Instagram DM -> @${ig.usuario}  (mid ${sobre.mid.slice(0, 16)}...)`);
pintarTurno(`${ig.compradorNombre} (IGSID ${opciones.igsid}):`, texto);

if (!opciones.esperar) {
  console.log(`\n  Enviado. La conversación aparece en ${cfg.urls.admin}/conversaciones\n`);
  process.exit(0);
}

const respuesta = await esperarRespuesta({
  tenantId: cfg.tienda.id,
  canal: 'instagram',
  referencia: opciones.igsid,
  externalId: sobre.mid,
});

if (respuesta) {
  pintarTurno('Manuela (el agente):', respuesta);
  console.log(`\n  En el panel: ${cfg.urls.admin}/conversaciones\n`);
}
