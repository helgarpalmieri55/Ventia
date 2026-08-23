import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Una consulta de SOLO LECTURA contra el Postgres del stack de desarrollo, a
 * través del `psql` que ya vive dentro del contenedor.
 *
 * Existe para una sola cosa: que quien graba vea en la misma terminal si el
 * agente contestó, sin cambiar a la pestaña del panel a media toma. Por eso NO
 * es fatal que falle — si no hay docker, o el contenedor se llama de otra
 * forma, devuelve `null` y quien llama dice "míralo en el panel" en vez de
 * romper el envío, que ya se hizo.
 *
 * Se usa el psql del contenedor y no un cliente de node a propósito: la raíz
 * del repo no tiene ningún driver de Postgres instalado, y añadir una
 * dependencia para una comodidad de grabación no vale lo que cuesta.
 */
export function consultar(sql) {
  try {
    const salida = execFileSync(
      'docker',
      [
        'compose', '-f', 'docker/compose.yaml', 'exec', '-T', 'postgres',
        'psql', '-U', 'ventia', '-d', 'ventia', '-tAc', sql,
      ],
      { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
    return salida.replace(/\s+$/, '');
  } catch {
    return null;
  }
}

/** Escapa un literal para SQL. Los valores que pasan por aquí son ids que
 * genera esta misma demo, pero un apóstrofo en un texto improvisado no puede
 * romper la consulta. */
export function lit(valor) {
  return `'${String(valor).replace(/'/g, "''")}'`;
}
