/**
 * La lógica del túnel público, separada de los procesos que la usan.
 *
 * Todo lo de aquí es puro: entra texto, sale texto. Ni red, ni procesos, ni
 * relojes. Es lo que permite probar por pruebas —y no grabando— las dos cosas
 * que se rompen en silencio:
 *
 *  1. **Sacar la URL del túnel del log de `cloudflared`.** Si el patrón falla,
 *     `API_PUBLIC_URL` se queda vacío, el API arranca igual y el panel enseña
 *     `http://api.ventia.localhost`. El comerciante copia esa URL en Meta, Meta
 *     no la puede alcanzar, y el síntoma aparece media hora después como
 *     "Instagram no funciona".
 *  2. **Armar las URLs de callback.** Meta guarda la cadena tal cual se pega.
 *     Un `?account=` mal puesto es un handshake que falla con un 403 que no
 *     dice por qué.
 */

/**
 * La URL pública que `cloudflared` imprime al abrir un quick tunnel.
 *
 * El formato exacto que saca `cloudflared` es un recuadro ASCII con la URL
 * dentro, y encima cada renglón lleva su marca de tiempo y su nivel:
 *
 *     2026-08-23T12:00:00Z INF +----------------------------------------+
 *     2026-08-23T12:00:00Z INF |  Your quick Tunnel has been created!   |
 *     2026-08-23T12:00:00Z INF |  https://mono-verde-alto.trycloudflare.com  |
 *     2026-08-23T12:00:00Z INF +----------------------------------------+
 *
 * Buscar el host y no la frase de alrededor es deliberado: la frase la han
 * cambiado entre versiones de `cloudflared`, el dominio no.
 *
 * El `(?![\w.-])` del final es lo que impide aceptar
 * `https://algo.trycloudflare.com.otro-dominio.example`, que casaría por
 * prefijo y dejaría el resto del host fuera de la URL — una URL a la que Meta
 * llegaría, pero no a esta máquina.
 *
 * @param {string} texto  el log acumulado de cloudflared
 * @returns {string|null} la URL, sin barra final, o null si aún no aparece
 */
export function urlDelTunel(texto) {
  if (typeof texto !== 'string') return null;
  const encontrado = texto.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com(?![\w.-])/i);
  return encontrado ? encontrado[0] : null;
}

/** Quita las barras finales. Una base con barra produce `//webhooks/...`, que
 * Express sirve igual pero que en Meta se ve mal pegado y hace dudar. */
export function normalizarBase(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

/**
 * La URL de callback de Instagram, la misma que arma
 * `instagram-admin.controller.ts` para el botón de copiar del panel más el
 * `?account=` que el controlador exige.
 *
 * El `account` va codificado aunque hoy sea siempre numérico: el día que no lo
 * sea, un valor sin codificar rompería la URL de una forma que solo se ve en
 * Meta.
 */
export function callbackInstagram({ base, proveedor = 'graph', cuenta }) {
  const url = `${normalizarBase(base)}/webhooks/instagram/${encodeURIComponent(proveedor)}`;
  return `${url}?account=${encodeURIComponent(cuenta)}`;
}

/** La de WhatsApp. El parámetro se llama `number` y lleva el
 * `phone_number_id` de Meta, NO el teléfono. */
export function callbackWhatsApp({ base, proveedor = 'cloud', numero }) {
  const url = `${normalizarBase(base)}/webhooks/whatsapp/${encodeURIComponent(proveedor)}`;
  return `${url}?number=${encodeURIComponent(numero)}`;
}

/**
 * La URL del saludo GET: la de callback más los tres parámetros que manda Meta
 * al guardar el webhook. Sirve para reproducir el handshake sin Meta delante.
 *
 * Se construye sobre la URL de callback REAL y no sobre una copia, para que
 * comprobar el handshake compruebe exactamente la cadena que se va a pegar.
 */
export function urlSaludo(callback, { verifyToken, reto }) {
  const url = new URL(callback);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', verifyToken);
  url.searchParams.set('hub.challenge', String(reto));
  return url.toString();
}

/**
 * El comando exacto para instalar `cloudflared` en esta plataforma.
 *
 * Existe porque la alternativa —"instala cloudflared"— manda a quien va a
 * grabar a buscar en un navegador justo cuando tenía Meta abierto en la otra
 * pestaña. Un comando que se pega y funciona ahorra esa excursión.
 */
export function comandoInstalacion(plataforma = process.platform) {
  switch (plataforma) {
    case 'darwin':
      return 'brew install cloudflared';
    case 'win32':
      return 'winget install --id Cloudflare.cloudflared';
    default:
      // Debian/Ubuntu, que es lo que corre esto en Linux nueve de cada diez
      // veces. El .deb oficial, porque no está en los repos de la distro.
      return (
        'curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb ' +
        '-o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb'
      );
  }
}

/**
 * Un reto aleatorio con la pinta de los de Meta (dígitos). Se usa uno nuevo en
 * cada comprobación a propósito: un reto fijo lo podría devolver un caché o un
 * proxy intermedio y la comprobación pasaría sin que el API hubiera visto nada.
 */
export function nuevoReto() {
  return String(Math.floor(Math.random() * 1e9) + 1e9);
}

/**
 * Decide de dónde sale la URL pública y lo DICE, porque de eso depende qué hay
 * que arreglar cuando no funciona:
 *
 *  - `entorno`  — alguien exportó `API_PUBLIC_URL` a mano (un ngrok suyo, un
 *                 dominio de verdad). Se respeta y NO se levanta ningún túnel.
 *  - `tunel`    — la que dejó escrita el túnel de esta demo.
 *  - `ninguna`  — no hay. Quien pregunte tiene que arrancar el túnel.
 *
 * @param {{entorno?: string, archivo?: string}} fuentes
 */
export function resolverUrlPublica({ entorno, archivo } = {}) {
  const deEntorno = normalizarBase(entorno);
  const deArchivo = normalizarBase(archivo);
  if (deEntorno) {
    // El túnel exporta API_PUBLIC_URL Y la deja escrita, así que dentro del
    // arranque las dos fuentes valen lo mismo. Cuando coinciden, el origen que
    // hay que decir es el túnel: decir "de API_PUBLIC_URL" mandaría a buscar
    // una variable que nadie puso a mano.
    return { url: deEntorno, origen: deEntorno === deArchivo ? 'tunel' : 'entorno' };
  }
  if (deArchivo) return { url: deArchivo, origen: 'tunel' };
  return { url: null, origen: 'ninguna' };
}
