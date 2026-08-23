#!/usr/bin/env node
/**
 * Simulador de un mensaje de WhatsApp entrante (proveedor Cloud API).
 *
 * Mismo mecanismo que `ig.mjs` — payload con la forma de Meta, firmado con
 * `X-Hub-Signature-256` usando el app secret que el seed cifró en la fila
 * `WhatsAppNumber` — sobre el otro endpoint y con el otro formato de payload:
 * aquí la clave de enrutamiento es `metadata.phone_number_id` y la marca de
 * tiempo va en SEGUNDOS, no en milisegundos como en Instagram.
 *
 * Uso:
 *   node scripts/demo/wa.mjs "¿Hacen envíos a Cali?"
 *   node scripts/demo/wa.mjs --telefono 573001112233 "Hola"
 *   node scripts/demo/wa.mjs --sin-esperar "Hola"
 *   node scripts/demo/wa.mjs --saludo
 *
 * La misma advertencia que en Instagram: la respuesta sale hacia la Graph API
 * con un token falso y Meta la rechaza. La conversación completa queda
 * guardada y es lo que se ve en el panel.
 */

import { cargarConfig, apiBase } from './lib/config.mjs';
import { sobreWhatsApp } from './lib/webhooks.mjs';
import { enviar, esperarRespuesta, pintarTurno } from './lib/cli.mjs';

const cfg = cargarConfig();
const wa = cfg.whatsapp;

const args = process.argv.slice(2);
const opciones = { telefono: wa.compradorTelefono, esperar: true, saludo: false };
const libres = [];
for (let i = 0; i < args.length; i++) {
  // `pnpm run demo:ig -- "hola"` mete un `--` suelto en argv; sin esto
  // acabaría dentro del texto del mensaje.
  if (args[i] === '--') continue;
  else if (args[i] === '--telefono') opciones.telefono = args[++i].replace(/\D/g, '');
  else if (args[i] === '--sin-esperar') opciones.esperar = false;
  else if (args[i] === '--saludo') opciones.saludo = true;
  else if (args[i] === '--ayuda' || args[i] === '-h') opciones.ayuda = true;
  else libres.push(args[i]);
}

if (opciones.ayuda) {
  console.log(`
  Simula un mensaje de WhatsApp hacia la tienda de demo.

    node scripts/demo/wa.mjs "tu mensaje"
    node scripts/demo/wa.mjs --telefono <573...> "tu mensaje"   otro comprador
    node scripts/demo/wa.mjs --sin-esperar "tu mensaje"         no espera la respuesta
    node scripts/demo/wa.mjs --saludo                           repite el handshake GET de Meta
`);
  process.exit(0);
}

if (opciones.saludo) {
  const reto = String(Math.floor(Math.random() * 1e9));
  const url = new URL(`${apiBase(cfg)}/webhooks/whatsapp/${wa.proveedor}`);
  url.searchParams.set('number', wa.externalId);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', wa.verifyToken);
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
  console.error('\n  Falta el texto del mensaje.  Ej.: node scripts/demo/wa.mjs "¿Cuánto vale el envío a Cali?"\n');
  process.exit(1);
}

const sobre = sobreWhatsApp(wa, texto, { telefono: opciones.telefono });
await enviar(cfg, sobre);

console.log(`\n  WhatsApp -> ${wa.telefonoVisible}  (${sobre.mid.slice(0, 22)}...)`);
pintarTurno(`${wa.compradorNombre} (+${opciones.telefono}):`, texto);

if (!opciones.esperar) {
  console.log(`\n  Enviado. La conversación aparece en ${cfg.urls.admin}/conversaciones\n`);
  process.exit(0);
}

const respuesta = await esperarRespuesta({
  tenantId: cfg.tienda.id,
  canal: 'whatsapp',
  referencia: opciones.telefono,
  externalId: sobre.mid,
});

if (respuesta) {
  pintarTurno('Manuela (el agente):', respuesta);
  console.log(`\n  En el panel: ${cfg.urls.admin}/conversaciones\n`);
}
