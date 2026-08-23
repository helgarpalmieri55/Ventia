import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bloqueParaMeta, HUECO_IG, HUECO_TOKEN, HUECO_WA, primero } from './pegar.mjs';

/**
 * Este bloque es lo que se copia LITERALMENTE en el panel de Meta, así que lo
 * que se comprueba aquí son cadenas exactas, no formas aproximadas. Una URL de
 * callback con un carácter de más no produce ningún error visible: Meta la
 * guarda, el handshake devuelve 403 sin explicación, y eso se descubre con la
 * cámara puesta.
 */

const BASE = 'https://mono-verde.trycloudflare.com';
const COMPLETO = {
  API_PUBLIC_URL: BASE,
  META_IG_ACCOUNT_ID: '17841400000000091',
  META_WA_PHONE_NUMBER_ID: '109300000000091',
  META_VERIFY_TOKEN: 'cumbre-meta-2026',
};

describe('primero', () => {
  it('se queda con el primero que traiga algo', () => {
    assert.equal(primero('', 'b', 'c'), 'b');
  });

  it('trata la cadena vacía y los espacios como ausencia', () => {
    // El caso real: `entorno.sh` deja META_IG_VERIFY_TOKEN definido aunque
    // esté vacío. Con `??` esa cadena vacía ganaría sobre META_VERIFY_TOKEN y
    // el bloque enseñaría un hueco teniendo el valor bueno al lado.
    assert.equal(primero('', '   ', 'bueno'), 'bueno');
    assert.equal(primero(undefined, null, 'bueno'), 'bueno');
  });

  it('recorta lo que devuelve', () => {
    assert.equal(primero('  valor \n'), 'valor');
  });

  it('devuelve cadena vacía cuando no hay nada', () => {
    assert.equal(primero(), '');
    assert.equal(primero('', undefined), '');
  });
});

describe('bloqueParaMeta, con todo configurado', () => {
  const salida = bloqueParaMeta(COMPLETO, '');

  it('lleva la URL de callback de Instagram exacta', () => {
    assert.ok(
      salida.includes(`${BASE}/webhooks/instagram/graph?account=17841400000000091`),
      salida,
    );
  });

  it('lleva la URL de callback de WhatsApp exacta, con ?number=', () => {
    assert.ok(salida.includes(`${BASE}/webhooks/whatsapp/cloud?number=109300000000091`), salida);
  });

  it('lleva el token de verificación', () => {
    assert.ok(salida.includes('cumbre-meta-2026'));
  });

  it('nombra el campo que hay que suscribir', () => {
    // Suscribir el campo equivocado deja el webhook verificado y mudo, que es
    // el fallo más caro de diagnosticar de todo este camino.
    assert.match(salida, /Campo a suscribir en los dos:\s+messages/);
  });

  it('NO enseña ningún hueco cuando no falta nada', () => {
    for (const h of [HUECO_IG, HUECO_WA, HUECO_TOKEN]) {
      assert.ok(!salida.includes(h), `sobra el hueco ${h}`);
    }
    assert.ok(!salida.includes('Los PEGA_AQUI_'), 'sobra la explicación de los huecos');
  });

  it('cabe en pantalla sin hacer scroll', () => {
    // El requisito de verdad: quien graba vuelve a esta terminal y tiene que
    // ver las dos URLs y los dos tokens sin buscar hacia arriba.
    const renglones = salida.split('\n').length;
    assert.ok(renglones <= 24, `el bloque ocupa ${renglones} renglones`);
  });

  it('ninguna línea se pasa de 110 columnas', () => {
    // Una URL partida por el ajuste de línea se copia partida.
    for (const l of salida.split('\n')) {
      assert.ok(l.length <= 110, `renglón de ${l.length} columnas: ${l}`);
    }
  });
});

describe('bloqueParaMeta, sin los identificadores reales', () => {
  const salida = bloqueParaMeta({ API_PUBLIC_URL: BASE }, '');

  it('enseña huecos y no los valores de la demo sembrada', () => {
    // Los de la demo verificarían el handshake y NO recibirían ninguna entrega
    // real: Meta guardaría la URL y luego tiraría cada mensaje en silencio.
    assert.ok(salida.includes(HUECO_IG));
    assert.ok(salida.includes(HUECO_WA));
    assert.ok(salida.includes(HUECO_TOKEN));
    assert.ok(!salida.includes('17841400000000091'), 'no debe ofrecer la cuenta de demo');
    assert.ok(!salida.includes('la-cumbre-ig-verify-2026'), 'no debe ofrecer el token de demo');
  });

  it('los huecos van en la URL sin codificar, para que se lean como huecos', () => {
    assert.ok(salida.includes(`?account=${HUECO_IG}`));
    assert.ok(!salida.includes('%3C'));
  });

  it('explica de dónde sacar cada hueco', () => {
    assert.match(salida, /META_IG_ACCOUNT_ID=/);
    assert.match(salida, /META_VERIFY_TOKEN=/);
  });
});

describe('bloqueParaMeta, de dónde sale la URL', () => {
  it('usa el archivo del túnel cuando no hay variable', () => {
    const salida = bloqueParaMeta({}, `${BASE}\n`);
    assert.ok(salida.includes(BASE));
    assert.match(salida, /\(del túnel\)/);
  });

  it('dice "del túnel" cuando la variable coincide con el archivo', () => {
    // Es el caso del arranque: `arrancar_tunel` exporta Y escribe. Decir "de
    // API_PUBLIC_URL" mandaría a buscar un export que nadie hizo a mano.
    const salida = bloqueParaMeta({ API_PUBLIC_URL: BASE }, `${BASE}\n`);
    assert.match(salida, /\(del túnel\)/);
  });

  it('dice "de API_PUBLIC_URL" cuando alguien la puso a mano', () => {
    const salida = bloqueParaMeta({ API_PUBLIC_URL: 'https://api.mio.example' }, `${BASE}\n`);
    assert.match(salida, /\(de API_PUBLIC_URL\)/);
  });

  it('sin URL pública no finge un bloque: dice cómo conseguirla', () => {
    const salida = bloqueParaMeta({}, '');
    assert.ok(!salida.includes('PEGAR EN META'), 'no debe imprimir un bloque sin URL');
    assert.match(salida, /pnpm run demo/);
  });

  it('una URL pública con barra final no produce una doble barra', () => {
    const salida = bloqueParaMeta({ ...COMPLETO, API_PUBLIC_URL: `${BASE}/` }, '');
    assert.ok(!salida.includes('com//webhooks'), salida);
    assert.ok(salida.includes(`${BASE}/webhooks/instagram/graph?account=17841400000000091`));
  });
});

describe('bloqueParaMeta, tokens por canal', () => {
  it('el token específico de un canal gana sobre el general', () => {
    const salida = bloqueParaMeta({ ...COMPLETO, META_IG_VERIFY_TOKEN: 'solo-ig' }, '');
    assert.ok(salida.includes('solo-ig'));
    assert.ok(salida.includes('cumbre-meta-2026'), 'WhatsApp debe seguir con el general');
  });

  it('un token de canal VACÍO cae al general, no al hueco', () => {
    // `entorno.sh` exporta META_IG_VERIFY_TOKEN aunque esté vacío. Sin el
    // tratamiento de la cadena vacía, esto enseñaría un hueco teniendo el
    // token bueno en META_VERIFY_TOKEN.
    const salida = bloqueParaMeta({ ...COMPLETO, META_IG_VERIFY_TOKEN: '' }, '');
    assert.ok(!salida.includes(HUECO_TOKEN), salida);
    assert.equal(salida.split('cumbre-meta-2026').length - 1, 2, 'los dos canales con el general');
  });
});
