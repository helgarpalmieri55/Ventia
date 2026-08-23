#!/usr/bin/env node
/**
 * Imprime, en un bloque que cabe en pantalla sin hacer scroll, EXACTAMENTE lo
 * que hay que pegar en el panel de Meta.
 *
 *   node scripts/demo/pegar.mjs      (o `pnpm run demo:pegar`)
 *
 * `arranque.sh` lo llama al final. Existe además como comando suelto porque a
 * mitad de una grabación uno ya ha llenado la terminal de otra cosa y no va a
 * reiniciar el stack para volver a ver una URL.
 *
 * De dónde salen los valores: la URL pública, del túnel (o de `API_PUBLIC_URL`,
 * si quien graba tiene un dominio de verdad); los identificadores y los tokens
 * de verificación, del entorno — son de una cuenta real de Meta y no pueden
 * vivir en un archivo del repositorio.
 *
 * Todo lo que decide QUÉ se imprime está en `lib/pegar.mjs`, que es donde se
 * prueba. Aquí solo queda sacarlo por pantalla.
 */

import { bloqueParaMeta } from './lib/pegar.mjs';

console.log(bloqueParaMeta());
