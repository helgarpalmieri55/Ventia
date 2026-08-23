import { apiBase } from './config.mjs';
import { consultar, lit } from './psql.mjs';

/**
 * Lo que comparten los dos simuladores: mandar el sobre firmado y luego
 * esperar a que el agente conteste.
 *
 * Sin colores ni códigos de escape a propósito: esta salida se lee en una
 * terminal que muchas veces está EN la grabación, y también acaba pegada en
 * un log; el texto plano se ve bien en los dos sitios.
 */

/**
 * Publica el sobre en el API local.
 *
 * Un 200 aquí NO significa que el mensaje se haya atendido: el controlador
 * confirma en cuanto reconoce el payload y trabaja después (Meta reintenta
 * ante cualquier cosa que no sea 2xx). Un payload con la firma mala, o de una
 * cuenta desconocida, también recibe 200 — a propósito, para no revelarle a
 * quien llama sin autenticarse qué cuentas atiende la plataforma. Por eso
 * después se espera a ver la respuesta en la base, que es la única señal real.
 */
export async function enviar(cfg, sobre) {
  const url = `${apiBase(cfg)}${sobre.ruta}`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: sobre.cabeceras, body: sobre.cuerpo });
  } catch (err) {
    console.error(`\n  No se pudo contactar el API en ${url}`);
    console.error(`  ${err.message}`);
    console.error('  Arráncalo con: pnpm run demo\n');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\n  El API respondió ${res.status} en ${sobre.ruta}`);
    console.error(`  ${(await res.text().catch(() => '')).slice(0, 300)}\n`);
    process.exit(1);
  }
  return res;
}

/**
 * Espera a que aparezca una respuesta del agente para ESTE mensaje.
 *
 * Se ancla al `externalId` del mensaje entrante y no al último `assistant` de
 * la conversación: si no, un envío descartado por firma mala mostraría la
 * respuesta del mensaje ANTERIOR y parecería que todo va bien.
 */
export async function esperarRespuesta({ tenantId, canal, referencia, externalId, segundos = 45 }) {
  const sql = `
    SELECT m2.content
    FROM "Message" mu
    JOIN "Message" m2 ON m2."conversationId" = mu."conversationId"
    WHERE mu."tenantId" = ${lit(tenantId)}
      AND mu."externalId" = ${lit(externalId)}
      AND m2.role = 'assistant'
      AND m2."createdAt" >= mu."createdAt"
    ORDER BY m2."createdAt" DESC
    LIMIT 1;`.replace(/\s+/g, ' ');

  if (consultar('SELECT 1') === null) {
    console.log('\n  (no se pudo consultar la base desde aquí; mira la conversación en el panel)\n');
    return null;
  }

  process.stdout.write('  esperando a que conteste el agente');
  for (let i = 0; i < segundos * 2; i++) {
    const respuesta = consultar(sql);
    if (respuesta) {
      process.stdout.write('\n');
      return respuesta;
    }
    if (i % 2 === 0) process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write('\n');

  // Diagnóstico en vez de silencio: distinguir "no llegó" de "llegó y no se
  // contestó" es la diferencia entre revisar la firma y revisar la clave de
  // Anthropic, y a media grabación eso son varios minutos.
  const llego = consultar(
    `SELECT 1 FROM "Message" WHERE "tenantId" = ${lit(tenantId)} AND "externalId" = ${lit(externalId)} LIMIT 1;`,
  );
  if (!llego) {
    console.log('  AVISO: el mensaje NO quedó registrado.');
    console.log('  Suele ser una de tres: la firma no verifica (¿resembraste después de tocar demo.json?),');
    console.log(`  la cuenta no está conectada, o el canal ${canal} no entra en el plan de la tienda.`);
    console.log(`  Referencia del comprador: ${referencia}`);
  } else {
    console.log('  AVISO: el mensaje llegó, pero el agente no contestó a tiempo.');
    console.log('  Mira el log del API: casi siempre es ANTHROPIC_API_KEY o el tope de créditos del mes.');
  }
  return null;
}

/** Imprime un turno como se leería en el chat. */
export function pintarTurno(quien, texto) {
  console.log(`\n  ${quien}`);
  for (const linea of texto.split('\n')) console.log(`    ${linea}`);
}
