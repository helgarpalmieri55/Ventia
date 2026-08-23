#!/usr/bin/env node
/**
 * Comprueba que Meta podría alcanzar este API ANTES de abrir Meta.
 *
 *   pnpm run demo:comprobar
 *   pnpm run demo:comprobar -- --publica https://otra-url   # forzar la URL
 *
 * Reproduce el handshake GET del webhook —el mismo que dispara Meta al guardar
 * la URL de devolución de llamada— por la URL PÚBLICA, y comprueba que el
 * cuerpo es el reto tal cual. Si esto no pasa, no hay nada más que probar: el
 * mensaje saldrá del teléfono, llegará a Meta y ahí se quedará.
 *
 * Hace cada comprobación DOS veces, por localhost y por la URL pública, porque
 * el par de resultados es lo que distingue las causas:
 *
 *   local ✗  público ✗   -> el API o los datos
 *   local ✓  público ✗   -> el túnel, o la URL que se pegó en Meta
 *   local ✓  público ✓   -> se puede grabar
 *
 * Por defecto usa las cuentas SEMBRADAS de la demo, que existen siempre. Eso
 * demuestra el camino completo —túnel, API, base, verificación del token— sin
 * necesitar ninguna credencial de Meta. Si además hay valores reales en el
 * entorno (META_IG_ACCOUNT_ID y compañía), comprueba también esos, que son los
 * que de verdad se van a pegar.
 */

import { cargarConfig } from './lib/config.mjs';
// La misma lectura que usa `pegar.mjs`, a propósito: si los dos comandos
// resolvieran la URL del túnel por su cuenta, uno podría dar por buena una URL
// que el otro no ve, y el que miente es siempre el que no comprueba.
import { leerArchivoTunel, primero } from './lib/pegar.mjs';
import {
  callbackInstagram,
  callbackWhatsApp,
  normalizarBase,
  nuevoReto,
  resolverUrlPublica,
  urlSaludo,
} from './lib/tunel.mjs';
import { diagnosticar, evaluarSaludo } from './lib/comprobacion.mjs';

const args = process.argv.slice(2);
let publicaForzada = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') continue;
  if (args[i] === '--publica') publicaForzada = args[++i] ?? '';
  else if (args[i] === '--ayuda' || args[i] === '-h') {
    console.log(`
  Comprueba que el túnel público llega al API y que el handshake de Meta pasa.

    pnpm run demo:comprobar
    pnpm run demo:comprobar -- --publica https://otra.trycloudflare.com
`);
    process.exit(0);
  }
}

const cfg = cargarConfig();
const local = normalizarBase(process.env.API_INTERNAL_URL ?? 'http://localhost:4000');
const { url: publica, origen } = resolverUrlPublica({
  entorno: publicaForzada || process.env.API_PUBLIC_URL,
  archivo: leerArchivoTunel(),
});

if (!publica) {
  console.error(`
  No hay URL pública que comprobar.

  Sin ella Meta no puede alcanzar esta máquina y no hay nada que grabar con
  mensajes reales. Levántala con:

      pnpm run demo          arranca el túnel y el API en el orden correcto
      pnpm run demo:tunel    solo el túnel, si el stack ya está arriba
`);
  process.exit(1);
}

/** Una petición que NUNCA lanza: un fallo de red es un resultado más. */
async function pedir(url, tiempo = 10000) {
  const corte = AbortSignal.timeout(tiempo);
  try {
    const res = await fetch(url, { signal: corte, redirect: 'manual' });
    return { estado: res.status, cuerpo: await res.text() };
  } catch (err) {
    return { estado: null, cuerpo: null, error: err?.message ?? String(err) };
  }
}

async function salud(base) {
  const r = await pedir(`${base}/v1/health`);
  return { ok: r.estado !== null && r.estado >= 200 && r.estado < 500, ...r };
}

/**
 * Un reto NUEVO por llamada, y comparado contra el de ESTA llamada. Un reto
 * fijo lo puede servir un caché intermedio y la comprobación pasaría sin que
 * el API hubiera visto nada.
 */
async function saludo(callback, verifyToken) {
  const reto = nuevoReto();
  const r = await pedir(urlSaludo(callback, { verifyToken, reto }));
  return { ...evaluarSaludo({ ...r, reto }), url: callback };
}

// Ancho fijo: `OK` y `FALLA` no miden lo mismo y una columna desalineada se
// lee peor justo cuando hay prisa.
const marca = (ok) => (ok ? 'OK   ' : 'FALLA');
const lineas = [];
function apuntar(ok, etiqueta, detalle) {
  lineas.push(`  ${marca(ok)}  ${etiqueta}${detalle ? `  — ${detalle}` : ''}`);
  return ok;
}

console.log(`
  Comprobando que Meta podría alcanzar este API.

    local     ${local}
    pública   ${publica}   (${publicaForzada ? 'forzada con --publica' : origen === 'tunel' ? 'del túnel' : 'de API_PUBLIC_URL'})
`);

const saludLocal = await salud(local);
const saludPublica = await salud(publica);
apuntar(saludLocal.ok, 'el API responde en local', saludLocal.error ?? `HTTP ${saludLocal.estado}`);
apuntar(saludPublica.ok, 'el API responde por la URL pública', saludPublica.error ?? `HTTP ${saludPublica.estado}`);

// --- las cuentas a probar ----------------------------------------------------
// La sembrada siempre; la real solo si está declarada. Cada una se prueba por
// los dos caminos.
const cuentas = [
  {
    nombre: 'Instagram (cuenta de demo)',
    callback: (base) => callbackInstagram({ base, proveedor: cfg.instagram.proveedor, cuenta: cfg.instagram.igAccountId }),
    token: cfg.instagram.verifyToken,
    real: false,
  },
  {
    nombre: 'WhatsApp (número de demo)',
    callback: (base) => callbackWhatsApp({ base, proveedor: cfg.whatsapp.proveedor, numero: cfg.whatsapp.externalId }),
    token: cfg.whatsapp.verifyToken,
    real: false,
  },
];

const igReal = primero(process.env.META_IG_ACCOUNT_ID);
const tokenIgReal = primero(process.env.META_IG_VERIFY_TOKEN, process.env.META_VERIFY_TOKEN);
if (igReal && tokenIgReal) {
  cuentas.push({
    nombre: 'Instagram (cuenta REAL de Meta)',
    callback: (base) => callbackInstagram({ base, cuenta: igReal }),
    token: tokenIgReal,
    real: true,
  });
}
const waReal = primero(process.env.META_WA_PHONE_NUMBER_ID);
const tokenWaReal = primero(process.env.META_WA_VERIFY_TOKEN, process.env.META_VERIFY_TOKEN);
if (waReal && tokenWaReal) {
  cuentas.push({
    nombre: 'WhatsApp (número REAL de Meta)',
    callback: (base) => callbackWhatsApp({ base, numero: waReal }),
    token: tokenWaReal,
    real: true,
  });
}

let saludoLocalOk = true;
let saludoPublicoOk = true;
const urlsBuenas = [];
const realesRotas = [];
for (const cuenta of cuentas) {
  const enLocal = await saludo(cuenta.callback(local), cuenta.token);
  const enPublica = await saludo(cuenta.callback(publica), cuenta.token);
  apuntar(enLocal.ok, `handshake ${cuenta.nombre} por local`, enLocal.motivo);
  apuntar(enPublica.ok, `handshake ${cuenta.nombre} por la URL pública`, enPublica.motivo);
  // Las cuentas reales no cuentan para el diagnóstico general: que no estén
  // conectadas todavía es lo NORMAL la primera vez, y no significa que el
  // túnel esté mal. Se informan igual, porque son las que se van a pegar.
  if (!cuenta.real) {
    saludoLocalOk &&= enLocal.ok;
    saludoPublicoOk &&= enPublica.ok;
  }
  if (cuenta.real && !enPublica.ok) realesRotas.push(cuenta.nombre);
  if (enPublica.ok) urlsBuenas.push(`${cuenta.nombre}\n     ${enPublica.url}`);
}

console.log(lineas.join('\n'));

const d = diagnosticar({
  apiLocal: saludLocal.ok,
  apiPublica: saludPublica.ok,
  saludoLocal: saludoLocalOk,
  saludoPublico: saludoPublicoOk,
});

console.log(`\n  ${d.ok ? '✔' : '✘'}  ${d.titulo}`);
for (const paso of d.pasos) console.log(`     ${paso}`);

if (d.ok && urlsBuenas.length) {
  console.log('\n  URLs que verifican ahora mismo:');
  for (const u of urlsBuenas) console.log(`   - ${u}`);
}

// Una cuenta REAL declarada y que no verifica NO es un fallo del túnel, pero
// tampoco es un visto bueno: es justo la URL que se va a pegar en Meta. Se
// informa aparte y se sale con error, porque un verde aquí sería el verde que
// se descubre media hora después con Meta abierto.
if (realesRotas.length) {
  console.log(`\n  ✘  El túnel está bien, pero esto todavía no verifica: ${realesRotas.join(', ')}.`);
  console.log('     Conecta la cuenta en el panel (Configuración -> Instagram / WhatsApp) con');
  console.log('     ESE mismo token de verificación, y vuelve a lanzar esta comprobación.');
}
console.log('');

process.exit(d.ok && realesRotas.length === 0 ? 0 : 1);
