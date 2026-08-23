import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  callbackInstagram,
  callbackWhatsApp,
  comandoInstalacion,
  normalizarBase,
  nuevoReto,
  resolverUrlPublica,
  urlDelTunel,
  urlSaludo,
} from './tunel.mjs';

/**
 * Lo que estas pruebas protegen es un fallo que NO se ve al grabar.
 *
 * Si `urlDelTunel` no encuentra la URL, el arranque sigue, el API arranca y el
 * panel enseña `http://api.ventia.localhost` con su botón de copiar tan
 * tranquilo. Nada falla, nada avisa: simplemente Meta no puede alcanzar esa
 * URL, y eso se descubre cuando el handshake da error en la consola de Meta,
 * en mitad de la grabación.
 *
 * Por eso el caso principal se prueba contra la salida LITERAL de
 * `cloudflared`, recuadro ASCII y marcas de tiempo incluidas, y no contra una
 * línea limpia que nunca existe en la vida real.
 */

// La salida real de `cloudflared tunnel --url http://localhost:4000`, copiada
// tal cual: dos columnas de marca de tiempo y nivel, y la URL dentro de un
// recuadro de barras verticales.
const LOG_REAL = `2026-08-23T12:00:01Z INF Thank you for trying Cloudflare Tunnel.
2026-08-23T12:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-23T12:00:03Z INF +--------------------------------------------------------------------------------------------+
2026-08-23T12:00:03Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-08-23T12:00:03Z INF |  https://mono-verde-alto-cafe.trycloudflare.com                                             |
2026-08-23T12:00:03Z INF +--------------------------------------------------------------------------------------------+
2026-08-23T12:00:03Z INF Registered tunnel connection connIndex=0
`;

describe('urlDelTunel', () => {
  it('saca la URL de la salida literal de cloudflared', () => {
    assert.equal(urlDelTunel(LOG_REAL), 'https://mono-verde-alto-cafe.trycloudflare.com');
  });

  it('devuelve null mientras cloudflared aún no la ha impreso', () => {
    // Este es el estado en el que está el log durante los primeros segundos, y
    // el motivo por el que el arranque tiene que ESPERAR en vez de leer una vez.
    assert.equal(urlDelTunel('2026-08-23T12:00:01Z INF Requesting new quick Tunnel...\n'), null);
  });

  it('no confunde la mención del dominio con una URL', () => {
    // `Requesting new quick Tunnel on trycloudflare.com...` aparece SIEMPRE, y
    // antes que la URL. Aceptarla daría una URL sin subdominio.
    assert.equal(urlDelTunel('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  });

  it('exige un subdominio: `trycloudflare.com` a secas no es un túnel', () => {
    // El dominio desnudo es la web de Cloudflare, no un túnel. Aceptarlo daría
    // una `API_PUBLIC_URL` que responde 200 a todo y no lleva a esta máquina:
    // el handshake fallaría con un 404 desconcertante en la consola de Meta.
    assert.equal(urlDelTunel('https://trycloudflare.com/algo'), null);
    assert.equal(urlDelTunel('https://.trycloudflare.com'), null);
    assert.equal(urlDelTunel('https://-.trycloudflare.com'), null);
  });

  it('no se queda con el prefijo de un host más largo', () => {
    // `https://x.trycloudflare.com.otro.example` casa por prefijo con un
    // patrón ingenuo, y el resultado sería una URL que resuelve a OTRA máquina.
    assert.equal(urlDelTunel('https://x.trycloudflare.com.otro.example/algo'), null);
  });

  it('acepta la URL seguida de puntuación o de fin de renglón', () => {
    assert.equal(urlDelTunel('visita https://a-b.trycloudflare.com, gracias'), 'https://a-b.trycloudflare.com');
    assert.equal(urlDelTunel('https://a-b.trycloudflare.com'), 'https://a-b.trycloudflare.com');
    assert.equal(urlDelTunel('|  https://a-b.trycloudflare.com  |'), 'https://a-b.trycloudflare.com');
  });

  it('se queda con la PRIMERA cuando el log arrastra un túnel anterior', () => {
    // El log se acumula entre reintentos. La primera es la del túnel vivo.
    const dos = 'https://uno.trycloudflare.com\nmás tarde\nhttps://dos.trycloudflare.com\n';
    assert.equal(urlDelTunel(dos), 'https://uno.trycloudflare.com');
  });

  it('nunca devuelve una URL con barra final', () => {
    // Una barra aquí se propaga a `//webhooks/instagram/graph` en la URL que se
    // pega en Meta.
    assert.equal(urlDelTunel('https://a-b.trycloudflare.com/'), 'https://a-b.trycloudflare.com');
  });

  it('tolera que no le llegue texto', () => {
    assert.equal(urlDelTunel(undefined), null);
    assert.equal(urlDelTunel(null), null);
    assert.equal(urlDelTunel(''), null);
  });
});

describe('normalizarBase', () => {
  it('quita las barras finales y los espacios', () => {
    assert.equal(normalizarBase('https://x.trycloudflare.com///'), 'https://x.trycloudflare.com');
    assert.equal(normalizarBase('  https://x.trycloudflare.com \n'), 'https://x.trycloudflare.com');
  });

  it('convierte lo ausente en cadena vacía y no en "undefined"', () => {
    // Un literal `"undefined"` metido en una URL de callback es exactamente el
    // tipo de valor que se pega en Meta sin mirar.
    assert.equal(normalizarBase(undefined), '');
    assert.equal(normalizarBase(null), '');
  });
});

describe('callbackInstagram', () => {
  const base = 'https://mono-verde.trycloudflare.com';

  it('arma la cadena exacta que espera instagram-webhooks.controller.ts', () => {
    assert.equal(
      callbackInstagram({ base, cuenta: '17841400000000091' }),
      'https://mono-verde.trycloudflare.com/webhooks/instagram/graph?account=17841400000000091',
    );
  });

  it('coincide con el callbackBaseUrl que el panel enseña', () => {
    // `instagram-admin.controller.ts` devuelve `${apiPublicUrl()}/webhooks/instagram`.
    // Si estas dos cadenas divergen, el documento diría una cosa y el botón de
    // copiar del panel otra, y quien graba pegaría la que tuviera más cerca.
    const delPanel = `${base}/webhooks/instagram`;
    assert.ok(callbackInstagram({ base, cuenta: '1' }).startsWith(`${delPanel}/graph?`));
  });

  it('no duplica la barra cuando la base la trae', () => {
    assert.equal(
      callbackInstagram({ base: `${base}/`, cuenta: '9' }),
      `${base}/webhooks/instagram/graph?account=9`,
    );
  });

  it('codifica la cuenta', () => {
    assert.equal(
      callbackInstagram({ base, cuenta: 'a b&c' }),
      `${base}/webhooks/instagram/graph?account=a%20b%26c`,
    );
  });
});

describe('callbackWhatsApp', () => {
  const base = 'https://mono-verde.trycloudflare.com';

  it('usa el parámetro `number`, que es el que lee el controlador', () => {
    // El controlador de WhatsApp lee `query.number`; el de Instagram lee
    // `query.account`. Intercambiarlos da un 403 sin explicación.
    assert.equal(
      callbackWhatsApp({ base, numero: '109300000000091' }),
      'https://mono-verde.trycloudflare.com/webhooks/whatsapp/cloud?number=109300000000091',
    );
  });

  it('lleva el proveedor `cloud`, el único que el controlador acepta en el GET', () => {
    assert.match(callbackWhatsApp({ base, numero: '1' }), /\/webhooks\/whatsapp\/cloud\?/);
  });
});

describe('urlSaludo', () => {
  const callback = 'https://x.trycloudflare.com/webhooks/instagram/graph?account=991';

  it('conserva el parámetro de enrutamiento y añade los tres de Meta', () => {
    const url = new URL(urlSaludo(callback, { verifyToken: 'tok', reto: '12345' }));
    assert.equal(url.searchParams.get('account'), '991');
    assert.equal(url.searchParams.get('hub.mode'), 'subscribe');
    assert.equal(url.searchParams.get('hub.verify_token'), 'tok');
    assert.equal(url.searchParams.get('hub.challenge'), '12345');
  });

  it('codifica un verify token con caracteres raros', () => {
    // Meta deja inventarse el verify token, y quien lo invente puede meter un
    // `&`. Sin codificar, partiría la URL y el token llegaría truncado.
    const url = new URL(urlSaludo(callback, { verifyToken: 'a&b=c d', reto: '1' }));
    assert.equal(url.searchParams.get('verify_token'), null);
    assert.equal(url.searchParams.get('hub.verify_token'), 'a&b=c d');
  });

  it('manda el reto como texto aunque llegue como número', () => {
    const url = new URL(urlSaludo(callback, { verifyToken: 't', reto: 42 }));
    assert.equal(url.searchParams.get('hub.challenge'), '42');
  });

  it('no pisa la ruta ni el host del callback', () => {
    const url = new URL(urlSaludo(callback, { verifyToken: 't', reto: '1' }));
    assert.equal(url.host, 'x.trycloudflare.com');
    assert.equal(url.pathname, '/webhooks/instagram/graph');
  });
});

describe('comandoInstalacion', () => {
  it('da un comando distinto y concreto por plataforma', () => {
    assert.equal(comandoInstalacion('darwin'), 'brew install cloudflared');
    assert.match(comandoInstalacion('win32'), /winget install/);
    assert.match(comandoInstalacion('linux'), /cloudflared-linux-amd64\.deb/);
  });

  it('cae en el comando de Linux ante una plataforma desconocida', () => {
    assert.equal(comandoInstalacion('freebsd'), comandoInstalacion('linux'));
  });

  it('nunca devuelve algo vacío, que es lo que dejaría el mensaje sin salida', () => {
    for (const p of ['darwin', 'win32', 'linux', 'aix', undefined]) {
      assert.ok(comandoInstalacion(p).length > 10, `plataforma ${p}`);
    }
  });
});

describe('nuevoReto', () => {
  it('son dígitos, como los de Meta', () => {
    assert.match(nuevoReto(), /^[0-9]+$/);
  });

  it('cambia entre llamadas', () => {
    // Un reto fijo lo podría devolver un caché intermedio y la comprobación
    // pasaría sin que el API hubiera visto la petición.
    const vistos = new Set(Array.from({ length: 50 }, () => nuevoReto()));
    assert.ok(vistos.size > 45, `demasiadas repeticiones: ${vistos.size}/50`);
  });
});

describe('resolverUrlPublica', () => {
  it('el entorno gana sobre el archivo del túnel', () => {
    // Quien ya tiene un dominio de verdad o su propio ngrok exporta
    // API_PUBLIC_URL, y entonces no se levanta ningún túnel.
    const r = resolverUrlPublica({ entorno: 'https://api.mio.com', archivo: 'https://x.trycloudflare.com' });
    assert.deepEqual(r, { url: 'https://api.mio.com', origen: 'entorno' });
  });

  it('dice `tunel` cuando el entorno trae lo mismo que escribió el túnel', () => {
    // Es el caso del arranque: `arrancar_tunel` exporta la variable Y escribe
    // el archivo. Llamarlo `entorno` mandaría a quien lee a buscar un export
    // que nadie hizo a mano.
    const r = resolverUrlPublica({
      entorno: 'https://x.trycloudflare.com',
      archivo: 'https://x.trycloudflare.com\n',
    });
    assert.deepEqual(r, { url: 'https://x.trycloudflare.com', origen: 'tunel' });
  });

  it('usa el archivo del túnel cuando no hay entorno', () => {
    const r = resolverUrlPublica({ archivo: 'https://x.trycloudflare.com\n' });
    assert.deepEqual(r, { url: 'https://x.trycloudflare.com', origen: 'tunel' });
  });

  it('una variable vacía NO cuenta como puesta', () => {
    // `export API_PUBLIC_URL=` deja la variable definida y vacía. Tratarla como
    // válida daría una URL de callback que empieza por `/webhooks`.
    const r = resolverUrlPublica({ entorno: '   ', archivo: 'https://x.trycloudflare.com' });
    assert.equal(r.origen, 'tunel');
  });

  it('dice `ninguna` cuando no hay nada, en vez de inventarse localhost', () => {
    assert.deepEqual(resolverUrlPublica({}), { url: null, origen: 'ninguna' });
    assert.deepEqual(resolverUrlPublica(), { url: null, origen: 'ninguna' });
  });
});
