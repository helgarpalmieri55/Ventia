#!/usr/bin/env node
/**
 * Sube las imágenes de la tienda de demo al MinIO del stack de desarrollo.
 *
 * ## Por qué imágenes generadas y no fotos de banco
 *
 * No hay ninguna foto de café con licencia disponible dentro de este repo, y
 * enlazar a un host externo pone la grabación a depender de que ese host
 * responda: una imagen que falla deja el glifo de imagen rota del navegador en
 * mitad de la vitrina, que es peor que no tener foto. Lo que se sube es una
 * lámina SVG por producto, con la paleta del tema de la tienda y el nombre del
 * producto: se lee como una ficha de catálogo hecha a propósito, no como un
 * hueco.
 *
 * ## Cómo poner fotos DE VERDAD
 *
 * Deje un archivo con el slug del producto en `scripts/demo/fotos/`
 * (`cafe-narino-el-mirador-340g.jpg`, `.png` o `.webp`) y este script lo sube
 * en lugar de la lámina. Lo mismo con `logo.png` para la cabecera de la
 * tienda. No hace falta tocar nada más: el objeto se guarda sin extensión y el
 * navegador se guía por el `Content-Type`, así que la URL que escribe el seed
 * es la misma en los dos casos.
 *
 * Uso:  node scripts/demo/fotos.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { cargarConfig } from './lib/config.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const cfg = cargarConfig();

const TIPOS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// La paleta del preset "Taller", que es el tema con el que el seed deja la
// tienda. Si cambia allí, cambia aquí: unas láminas en otro color que la
// tienda se ven como fotos prestadas de otra marca.
const TERRACOTA = '#b45309';
const CREMA = '#fffaf3';
const TINTA = '#3f2d20';

/**
 * Las siluetas. Cada una es un trazo simple sobre la lámina; el objetivo no es
 * ilustrar el producto sino que la cuadrícula de la tienda tenga ritmo y no
 * doce rectángulos idénticos.
 */
const SILUETAS = {
  bolsa: `<path d="M250 330 h300 l30 470 a40 40 0 0 1 -40 42 h-280 a40 40 0 0 1 -40 -42 z"/>
          <path d="M250 330 q150 -70 300 0"/>
          <path d="M330 250 q70 -40 140 0 l0 80 q-70 -35 -140 0 z"/>
          <rect x="320" y="520" width="160" height="120" rx="10"/>`,
  prensa: `<rect x="290" y="330" width="220" height="430" rx="18"/>
           <rect x="330" y="180" width="140" height="60" rx="20"/>
           <path d="M400 240 v90"/>
           <path d="M300 470 h200"/>
           <path d="M270 760 h260"/>`,
  molino: `<rect x="300" y="380" width="200" height="330" rx="16"/>
           <circle cx="400" cy="300" r="70"/>
           <path d="M400 230 v-70 h90"/>
           <path d="M330 560 h140"/>`,
  greca: `<path d="M300 760 l40 -220 h120 l40 220 z"/>
          <path d="M320 540 l30 -200 h100 l30 200"/>
          <path d="M470 400 q90 40 0 130"/>
          <path d="M330 300 h140"/>`,
  cono: `<path d="M250 340 h300 l-120 260 h-60 z"/>
         <path d="M370 600 v120"/>
         <path d="M300 720 h200"/>
         <path d="M290 400 h220"/>`,
  taza: `<path d="M290 380 h220 v210 a110 110 0 0 1 -220 0 z"/>
         <path d="M510 420 q90 20 0 130"/>
         <path d="M270 730 h260"/>
         <path d="M350 300 q30 -50 0 -90"/>
         <path d="M430 300 q30 -50 0 -90"/>`,
  caja: `<rect x="250" y="380" width="300" height="330" rx="14"/>
         <path d="M250 470 h300"/>
         <path d="M400 380 v330"/>
         <path d="M400 380 q-90 -110 -140 -40 q-30 45 60 40"/>
         <path d="M400 380 q90 -110 140 -40 q30 45 -60 40"/>`,
};

/** Qué silueta le toca a cada producto, por su slug. */
function siluetaDe(slug) {
  if (slug.startsWith('cafe-') || slug.startsWith('mezcla-') || slug.startsWith('descafeinado')) return 'bolsa';
  if (slug.includes('prensa')) return 'prensa';
  if (slug.includes('molino')) return 'molino';
  if (slug.includes('greca')) return 'greca';
  if (slug.includes('v60') || slug.includes('filtro')) return 'cono';
  if (slug.includes('taza')) return 'taza';
  return 'caja';
}

function escapar(texto) {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Parte un título largo en líneas que quepan en la lámina.
 *
 * 26 caracteres es lo que entra a 34 px en una serif dentro de los 800 px de
 * ancho de la lámina. Los títulos de `demo.json` están escritos para caber en
 * una sola línea, y hay una prueba que lo mantiene así; esto es la red por si
 * alguien añade uno más largo. */
function envolver(texto, maximo = 26) {
  const lineas = [];
  let actual = '';
  for (const palabra of texto.split(' ')) {
    if ((actual + ' ' + palabra).trim().length > maximo && actual) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = (actual + ' ' + palabra).trim();
    }
  }
  if (actual) lineas.push(actual);
  // Una última línea de una o dos letras ("...300 / ml") se lee como un error
  // de maquetación: mejor pasarse un poco de ancho que dejarla suelta.
  if (lineas.length > 1 && lineas.at(-1).length <= 3) {
    const suelta = lineas.pop();
    lineas[lineas.length - 1] += ` ${suelta}`;
  }
  return lineas.slice(0, 3);
}

/** Una lámina 4:5, que es la proporción a la que el storefront recorta toda
 * foto de producto. Generarla ya en esa proporción evita que el recorte se
 * coma parte del nombre. */
function lamina(nombre) {
  const lineas = envolver(nombre);
  const base = 880 - (lineas.length - 1) * 22;
  const textos = lineas
    .map((linea, i) => `<text x="400" y="${base + i * 44}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="${TINTA}">${escapar(linea)}</text>`)
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000" width="800" height="1000" role="img">
    <rect width="800" height="1000" fill="${CREMA}"/>
    <circle cx="400" cy="470" r="300" fill="${TERRACOTA}" opacity="0.07"/>
    <g fill="none" stroke="${TERRACOTA}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"
       transform="translate(400 470) scale(0.8) translate(-400 -470)">
      __SILUETA__
    </g>
    ${textos}
    <text x="400" y="960" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" letter-spacing="4" fill="${TERRACOTA}">TOSTADURÍA LA CUMBRE</text>
  </svg>`;
}

function laminaProducto(slug, nombre) {
  return lamina(nombre).replace('__SILUETA__', SILUETAS[siluetaDe(slug)]);
}

function laminaLogo() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 120" width="520" height="120" role="img">
    <rect width="520" height="120" fill="none"/>
    <g fill="none" stroke="${TERRACOTA}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M24 84 L58 34 L92 84 Z"/>
      <path d="M60 84 L86 46 L112 84 Z"/>
    </g>
    <text x="136" y="60" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="${TINTA}">La Cumbre</text>
    <text x="138" y="90" font-family="Helvetica, Arial, sans-serif" font-size="15" letter-spacing="4" fill="${TERRACOTA}">TOSTADURÍA DE CAFÉ</text>
  </svg>`;
}

// ---------------------------------------------------------------------------

/** Un archivo real dejado a mano en `scripts/demo/fotos/`, si lo hay. */
function archivoPropio(slug) {
  let entradas;
  try {
    entradas = readdirSync(path.join(AQUI, 'fotos'));
  } catch {
    return null;
  }
  for (const entrada of entradas) {
    const ext = path.extname(entrada).toLowerCase();
    if (path.basename(entrada, ext) !== slug || !TIPOS[ext]) continue;
    return { cuerpo: readFileSync(path.join(AQUI, 'fotos', entrada)), tipo: TIPOS[ext], origen: entrada };
  }
  return null;
}

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'ventia',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'ventia-secret',
  },
});
const bucket = process.env.S3_BUCKET ?? 'ventia';

/**
 * Se guarda SIN extensión a propósito: así la URL que escribe el seed no
 * cambia según el formato, y quien quiera poner un JPG de verdad solo tiene
 * que dejar el archivo en la carpeta. El navegador se guía por el
 * `Content-Type`, no por la extensión.
 */
async function subir(slug, cuerpo, tipo, intentos = 5) {
  const orden = new PutObjectCommand({
    Bucket: bucket,
    Key: `${cfg.fotos.prefijo}/${slug}`,
    Body: cuerpo,
    ContentType: tipo,
    CacheControl: 'public, max-age=300',
  });
  // Reintentos porque el bucket lo crea el contenedor `minio-init` justo
  // después de arrancar MinIO, y este script corre en cuanto el stack está en
  // pie: la primera subida puede llegar medio segundo antes que el bucket.
  for (let i = 1; ; i++) {
    try {
      await s3.send(orden);
      return;
    } catch (err) {
      if (i >= intentos) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// La lista de láminas vive en `demo.json` y no se deduce del catálogo de
// TypeScript: este script es JavaScript plano y leer un módulo .ts desde aquí
// significaría o compilarlo o analizarlo con una expresión regular, y las dos
// cosas se rompen en silencio. `test/seed-demo.test.ts` comprueba que la lista
// case UNO A UNO con el catálogo, que es la garantía de verdad.
const productos = cfg.fotos.laminas;

let propias = 0;
try {
  for (const producto of productos) {
    const propio = archivoPropio(producto.slug);
    if (propio) {
      await subir(producto.slug, propio.cuerpo, propio.tipo);
      propias += 1;
    } else {
      await subir(producto.slug, laminaProducto(producto.slug, producto.titulo), 'image/svg+xml');
    }
  }
  const logoPropio = archivoPropio('logo');
  if (logoPropio) await subir('logo', logoPropio.cuerpo, logoPropio.tipo);
  else await subir('logo', laminaLogo(), 'image/svg+xml');
} catch (err) {
  console.error(`\n  No se pudieron subir las imágenes a MinIO (${process.env.S3_ENDPOINT ?? 'http://localhost:9000'}).`);
  console.error(`  ${err.message}`);
  console.error('  ¿Está arriba el stack?  docker compose -f docker/compose.yaml up -d\n');
  process.exit(1);
}

const base = (process.env.S3_PUBLIC_URL ?? 'http://localhost:9000/ventia').replace(/\/+$/, '');
console.log(`  ${productos.length} imágenes y el logo subidos a ${base}/${cfg.fotos.prefijo}/`);
if (propias > 0) console.log(`  (${propias} son fotos propias de scripts/demo/fotos/)`);
