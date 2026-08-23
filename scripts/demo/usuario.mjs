#!/usr/bin/env node
/**
 * Crea la cuenta de la dueña de la tienda de demo por el camino REAL de
 * registro: `POST /v1/auth/sign-up/email` contra el API que ya está arriba.
 *
 * ## Por qué no lo hace el seed
 *
 * La contraseña la calcula better-auth, que vive en `services/api`, y
 * `@ventia/db` no puede depender de allí (la dependencia va al revés).
 * Reimplementar el formato del hash en el seed sería un segundo sitio donde
 * tener la misma verdad, y se desincronizaría en la próxima actualización de
 * better-auth — con el síntoma de "la contraseña de la demo dejó de funcionar"
 * el día de la grabación.
 *
 * Así que la cuenta se crea aquí, por HTTP, y el seed solo la ATA a la tienda
 * (membresía de owner) y le da el correo por verificado.
 *
 * Es idempotente: si la cuenta ya existe, lo dice y sale con 0.
 */

import { cargarConfig, apiBase } from './lib/config.mjs';

const cfg = cargarConfig();
const { email, nombre, clave } = cfg.duena;
const url = `${apiBase(cfg)}/v1/auth/sign-up/email`;

// better-auth rechaza con 403 MISSING_OR_NULL_ORIGIN cualquier petición que
// cambie estado y no traiga `Origin` — y `fetch` desde node no manda ninguno.
// Se manda el del panel, que es el que `admin.module.ts` registra como origen
// de confianza a partir de ADMIN_URL.
const origen = process.env.ADMIN_URL ?? cfg.urls.admin;

let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: origen },
    body: JSON.stringify({ email, password: clave, name: nombre }),
  });
} catch (err) {
  console.error(`\n  No se pudo contactar el API en ${url}`);
  console.error(`  ${err.message}\n`);
  process.exit(1);
}

const cuerpo = await res.text();

if (res.ok) {
  console.log(`  cuenta creada: ${email}`);
  process.exit(0);
}

// better-auth devuelve 422 USER_ALREADY_EXISTS cuando el correo ya está
// tomado. Volver a arrancar la demo tiene que ser inocuo, así que eso no es un
// error aquí.
if (/already exists|USER_ALREADY_EXISTS/i.test(cuerpo)) {
  console.log(`  la cuenta ${email} ya existía`);
  process.exit(0);
}

console.error(`\n  El registro falló (${res.status}): ${cuerpo.slice(0, 300)}\n`);
process.exit(1);
