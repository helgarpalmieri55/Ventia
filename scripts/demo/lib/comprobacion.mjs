/**
 * Cómo se juzga un handshake de Meta, y qué se concluye de un conjunto de
 * resultados. Puro: entra lo que devolvió la red, sale un veredicto.
 *
 * Se separa del script que hace las peticiones porque el veredicto es la parte
 * que importa y la que es fácil equivocar. "Devolvió 200" NO es "el handshake
 * funciona": Meta compara el cuerpo con el reto que mandó, byte a byte, y
 * guarda la URL solo si son idénticos. Un 200 con el reto entrecomillado, o
 * envuelto en JSON, o con un salto de línea de más, es un 200 que Meta
 * rechaza — y la diferencia entre esos dos casos es media hora de grabación
 * perdida.
 */

/**
 * ¿Este saludo lo daría por bueno Meta?
 *
 * @param {{estado: number|null, cuerpo: string|null, reto: string, error?: string}} r
 * @returns {{ok: boolean, motivo: string}}
 */
export function evaluarSaludo({ estado, cuerpo, reto, error }) {
  if (error) return { ok: false, motivo: `no se pudo llegar: ${error}` };
  if (estado !== 200) {
    // 403 es la respuesta del controlador cuando no encuentra la cuenta o el
    // token no casa. Es el fallo esperable, y merece decir las dos causas.
    if (estado === 403) {
      return { ok: false, motivo: '403 — o esa cuenta no está conectada, o el token de verificación no coincide' };
    }
    if (estado === 404) {
      return { ok: false, motivo: '404 — proveedor equivocado en la ruta (Instagram usa `graph`, WhatsApp usa `cloud`)' };
    }
    return { ok: false, motivo: `HTTP ${estado}` };
  }
  const texto = cuerpo ?? '';
  if (texto === reto) return { ok: true, motivo: 'devolvió el reto tal cual' };
  if (texto.trim() === reto) {
    // Meta compara sin recortar. Un espacio sobra tanto como un byte cualquiera.
    return { ok: false, motivo: 'devolvió el reto con espacios alrededor; Meta compara sin recortar' };
  }
  if (texto === JSON.stringify(reto) || texto === `"${reto}"`) {
    return { ok: false, motivo: 'devolvió el reto entrecomillado como JSON; Meta lo quiere en texto plano' };
  }
  return { ok: false, motivo: `devolvió ${JSON.stringify(texto.slice(0, 60))} en vez del reto` };
}

/**
 * De los resultados de las cuatro comprobaciones sale UNA conclusión con el
 * siguiente paso concreto. El orden importa: se informa de la causa más
 * profunda, porque arreglar la de arriba arregla las de abajo y decir las tres
 * a la vez manda a perseguir problemas que no existen.
 *
 * @param {{apiLocal: boolean, apiPublica: boolean, saludoLocal: boolean, saludoPublico: boolean}} r
 * @returns {{ok: boolean, titulo: string, pasos: string[]}}
 */
export function diagnosticar({ apiLocal, apiPublica, saludoLocal, saludoPublico }) {
  if (!apiLocal) {
    return {
      ok: false,
      titulo: 'El API no responde en esta máquina. Nada más puede funcionar.',
      pasos: ['pnpm run demo', 'Si ya estaba arrancando, mira el api.log que imprimió el arranque.'],
    };
  }
  if (!apiPublica) {
    return {
      ok: false,
      titulo: 'El API responde en local pero NO por la URL pública: el túnel no llega.',
      pasos: [
        'pnpm run demo:tunel     (si el stack ya está arriba y solo se cayó el túnel)',
        'Ojo: al levantar un túnel nuevo la URL CAMBIA, y hay que volver a pegarla en Meta.',
      ],
    };
  }
  if (!saludoLocal) {
    return {
      ok: false,
      titulo: 'El túnel llega, pero el handshake falla también en local: el problema está en los datos, no en la red.',
      pasos: [
        'Esa cuenta no está conectada, o su token de verificación no es el que se está probando.',
        'pnpm run demo:seed      (vuelve a sembrar las cuentas de la demo)',
        'Si estás comprobando una cuenta REAL, conéctala antes en el panel: Configuración -> Instagram / WhatsApp.',
      ],
    };
  }
  if (!saludoPublico) {
    return {
      ok: false,
      titulo: 'El handshake funciona en local y NO por la URL pública: algo se pierde por el camino.',
      pasos: [
        'Lo más probable es que se esté perdiendo la cadena de consulta (?account= / ?number=).',
        'Comprueba que la URL que pegaste en Meta la lleva entera, sin cortar en el `?`.',
      ],
    };
  }
  return {
    ok: true,
    titulo: 'El handshake pasa por la URL pública. Meta guardaría esta URL.',
    pasos: [],
  };
}
