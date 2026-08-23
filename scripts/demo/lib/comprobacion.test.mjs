import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diagnosticar, evaluarSaludo } from './comprobacion.mjs';

/**
 * El valor de estas pruebas está en los casos que NO son "200 y ya":
 * un handshake que devuelve 200 con el reto envuelto en JSON pasa cualquier
 * comprobación ingenua y lo rechaza Meta. Esta es la lógica que distingue
 * "responde" de "Meta lo daría por bueno".
 */

const RETO = '1234567890';

describe('evaluarSaludo', () => {
  it('acepta el reto devuelto tal cual', () => {
    assert.deepEqual(evaluarSaludo({ estado: 200, cuerpo: RETO, reto: RETO }), {
      ok: true,
      motivo: 'devolvió el reto tal cual',
    });
  });

  it('rechaza un 200 con el reto entrecomillado como JSON', () => {
    // El caso que rompería si el controlador devolviera el reto por la vía
    // normal de Nest en vez de como texto plano.
    const r = evaluarSaludo({ estado: 200, cuerpo: `"${RETO}"`, reto: RETO });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /texto plano/);
  });

  it('rechaza un 200 con espacios alrededor y lo dice', () => {
    const r = evaluarSaludo({ estado: 200, cuerpo: `  ${RETO}\n`, reto: RETO });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /sin recortar/);
  });

  it('rechaza un 200 con OTRO reto', () => {
    // Un proxy o un caché que devuelva la respuesta de una comprobación
    // anterior. Comparar contra el reto de ESTA llamada es lo que lo detecta.
    const r = evaluarSaludo({ estado: 200, cuerpo: '999', reto: RETO });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /en vez del reto/);
  });

  it('explica el 403 con sus dos causas reales', () => {
    const r = evaluarSaludo({ estado: 403, cuerpo: '', reto: RETO });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /no está conectada/);
    assert.match(r.motivo, /token de verificación/);
  });

  it('explica el 404 como proveedor equivocado en la ruta', () => {
    const r = evaluarSaludo({ estado: 404, cuerpo: '', reto: RETO });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /graph/);
    assert.match(r.motivo, /cloud/);
  });

  it('un cuerpo vacío con 200 NO pasa', () => {
    assert.equal(evaluarSaludo({ estado: 200, cuerpo: '', reto: RETO }).ok, false);
    assert.equal(evaluarSaludo({ estado: 200, cuerpo: null, reto: RETO }).ok, false);
  });

  it('un error de red se distingue de una respuesta mala', () => {
    const r = evaluarSaludo({ estado: null, cuerpo: null, reto: RETO, error: 'ECONNREFUSED' });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /ECONNREFUSED/);
  });

  it('el error gana sobre cualquier estado que venga por casualidad', () => {
    const r = evaluarSaludo({ estado: 200, cuerpo: RETO, reto: RETO, error: 'abortado' });
    assert.equal(r.ok, false);
  });
});

describe('diagnosticar', () => {
  const todo = { apiLocal: true, apiPublica: true, saludoLocal: true, saludoPublico: true };

  it('cuando todo pasa, lo dice y no propone nada', () => {
    const d = diagnosticar(todo);
    assert.equal(d.ok, true);
    assert.deepEqual(d.pasos, []);
  });

  it('el API caído tapa a todo lo demás', () => {
    // Con el API caído fallan las cuatro. Informar de las cuatro mandaría a
    // perseguir un túnel que está perfectamente bien.
    const d = diagnosticar({ apiLocal: false, apiPublica: false, saludoLocal: false, saludoPublico: false });
    assert.equal(d.ok, false);
    assert.match(d.titulo, /no responde en esta máquina/);
    assert.ok(d.pasos.some((p) => p.includes('pnpm run demo')));
  });

  it('separa "el túnel no llega" de "el API está mal"', () => {
    const d = diagnosticar({ ...todo, apiPublica: false, saludoPublico: false });
    assert.equal(d.ok, false);
    assert.match(d.titulo, /túnel no llega/);
    assert.ok(d.pasos.some((p) => p.includes('demo:tunel')));
  });

  it('avisa de que un túnel nuevo cambia la URL que hay pegada en Meta', () => {
    // El error de fondo: relevantar el túnel y no volver a pegar la URL deja
    // Meta apuntando a un host que ya no existe.
    const d = diagnosticar({ ...todo, apiPublica: false, saludoPublico: false });
    assert.ok(d.pasos.some((p) => /CAMBIA/.test(p)));
  });

  it('un handshake que falla también en local es problema de datos', () => {
    const d = diagnosticar({ ...todo, saludoLocal: false, saludoPublico: false });
    assert.match(d.titulo, /los datos, no.*la red/);
    assert.ok(d.pasos.some((p) => p.includes('demo:seed')));
  });

  it('bueno en local y malo por fuera apunta a la cadena de consulta', () => {
    // El riesgo que `docs/deploying-whatsapp.md` marca como el más probable:
    // que el `?number=` no sobreviva.
    const d = diagnosticar({ ...todo, saludoPublico: false });
    assert.match(d.titulo, /y NO por la URL pública/);
    assert.ok(d.pasos.some((p) => p.includes('?account=')));
  });

  it('nunca devuelve ok con alguna comprobación caída', () => {
    for (const clave of ['apiLocal', 'apiPublica', 'saludoLocal', 'saludoPublico']) {
      assert.equal(diagnosticar({ ...todo, [clave]: false }).ok, false, clave);
    }
  });

  it('cuando no pasa, siempre da al menos un paso concreto', () => {
    for (const clave of ['apiLocal', 'apiPublica', 'saludoLocal', 'saludoPublico']) {
      assert.ok(diagnosticar({ ...todo, [clave]: false }).pasos.length > 0, clave);
    }
  });
});
