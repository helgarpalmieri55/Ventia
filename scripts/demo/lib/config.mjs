import { readFileSync } from 'node:fs';

/**
 * Lee `scripts/demo/demo.json`, que es la fuente única de verdad de la demo.
 *
 * El seed lee ESE MISMO archivo (packages/db/src/seed-demo.ts). Es lo que
 * garantiza que el app secret con el que aquí se firma sea exactamente el que
 * el seed cifró dentro de `credentialsEnc`: si fueran dos copias, un cambio en
 * una dejaría de verificar y el síntoma sería "el agente no contesta", sin
 * ningún error por ningún lado.
 */
export function cargarConfig() {
  const url = new URL('../demo.json', import.meta.url);
  const cfg = JSON.parse(readFileSync(url, 'utf8'));

  // Las URLs sí admiten override por entorno: quien graba puede tener el API
  // en otro puerto, o querer pasar por Caddy en vez de por localhost. Los
  // secretos no lo admiten, porque cambiarlos por un lado y no por el otro es
  // exactamente el fallo silencioso que este archivo existe para evitar.
  cfg.urls.api = process.env.DEMO_API_URL ?? cfg.urls.api;
  return cfg;
}

/** Base URL del API sin barra final. */
export function apiBase(cfg) {
  return cfg.urls.api.replace(/\/+$/, '');
}
