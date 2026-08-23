import { describe, expect, it } from 'vitest';
import {
  HUMAN_ATTENDED_STATUS,
  HUMAN_MESSAGE_ROLE,
  instagramReplyWindow,
  isHumanAttended,
  needsDisclosureAfter,
  TRANSCRIPT_ROLES,
} from '../src/agent/human-takeover';
import { splitForChannel } from '../src/agent/human-reply.service';
import { DISCLOSURE_SESSION_GAP_MS } from '../src/agent/system-prompt';
import { MESSAGING_WINDOW_MS } from '@ventia/instagram';

/**
 * Las reglas de la atención humana, sin base de datos.
 *
 * El otro lado —que el panel de verdad guarde, envíe y calle al agente— vive en
 * `conversations-human-reply.test.ts`, con conversaciones reales. Aquí se fija
 * lo que se puede fijar sin nada montado, que es justo lo que un revisor de
 * Meta acabaría leyendo: quién habla, y cuándo hay que decir que quien habla es
 * una máquina.
 */

const AHORA = new Date('2026-08-23T12:00:00.000Z');

function haceMs(ms: number): Date {
  return new Date(AHORA.getTime() - ms);
}

describe('isHumanAttended — cuándo calla el agente', () => {
  it('calla solo con el estado de atención humana', () => {
    expect(isHumanAttended(HUMAN_ATTENDED_STATUS)).toBe(true);
    for (const estado of ['open', 'escalated', 'resolved']) {
      expect(isHumanAttended(estado)).toBe(false);
    }
  });

  it('un estado desconocido, nulo o vacío NO calla al agente', () => {
    // Fallar hacia «el bot contesta» es lo correcto aquí: el silencio es una
    // decisión que toma el comerciante, y una fila con un estado que no
    // reconocemos no puede dejar una tienda muda sin que nadie lo pidiera.
    for (const estado of [null, undefined, '', 'atendida', 'HUMAN']) {
      expect(isHumanAttended(estado)).toBe(false);
    }
  });
});

describe('needsDisclosureAfter — cuándo hay que (volver a) revelar', () => {
  it('conversación nueva: se revela', () => {
    expect(needsDisclosureAfter(null, AHORA)).toBe(true);
    expect(needsDisclosureAfter(undefined, AHORA)).toBe(true);
  });

  it('el agente acaba de hablar: NO se repite la revelación', () => {
    // Repetirla en cada mensaje es ruido que la gente deja de leer, y leerla es
    // el único motivo por el que existe.
    const hace = haceMs(DISCLOSURE_SESSION_GAP_MS - 60_000);
    expect(needsDisclosureAfter({ role: 'assistant', createdAt: hace }, AHORA)).toBe(false);
  });

  it('el agente habló hace mucho: sesión nueva, se revela', () => {
    const hace = haceMs(DISCLOSURE_SESSION_GAP_MS + 60_000);
    expect(needsDisclosureAfter({ role: 'assistant', createdAt: hace }, AHORA)).toBe(true);
  });

  it('lo último lo escribió UNA PERSONA: se revela aunque fuera hace un minuto', () => {
    // El caso que añade la atención humana, y el único que ninguna ventana de
    // tiempo detecta: el comprador acaba de hablar con alguien del equipo y
    // cree que sigue hablando con esa persona. Que el bot retome el hilo sin
    // decir nada es exactamente la confusión que la política persigue.
    const hace = haceMs(60_000);
    expect(needsDisclosureAfter({ role: HUMAN_MESSAGE_ROLE, createdAt: hace }, AHORA)).toBe(true);
  });

  it('una persona hace un segundo también obliga a revelar', () => {
    expect(needsDisclosureAfter({ role: HUMAN_MESSAGE_ROLE, createdAt: haceMs(1000) }, AHORA)).toBe(true);
  });
});

describe('el transcripto distingue quién habló', () => {
  it('`human` es un rol propio y no un alias de `assistant`', () => {
    // Si fueran el mismo rol, el transcripto no podría decir quién dijo qué —y
    // `assistant` acarrea la revelación de automatización, que una persona no
    // lleva.
    expect(HUMAN_MESSAGE_ROLE).not.toBe('assistant');
    expect(TRANSCRIPT_ROLES).toContain(HUMAN_MESSAGE_ROLE);
    expect(TRANSCRIPT_ROLES).toContain('assistant');
    expect(TRANSCRIPT_ROLES).toContain('user');
  });

  it('las filas `tool` siguen fuera del transcripto', () => {
    expect(TRANSCRIPT_ROLES).not.toContain('tool');
  });
});

describe('instagramReplyWindow — la ventana de 24 horas de una respuesta humana', () => {
  it('abierta a las 23 horas y cerrada a las 25', () => {
    expect(instagramReplyWindow(haceMs(23 * 60 * 60 * 1000), AHORA).open).toBe(true);
    expect(instagramReplyWindow(haceMs(25 * 60 * 60 * 1000), AHORA).open).toBe(false);
  });

  it('el borde exacto de 24 horas ya está cerrado', () => {
    // La misma frontera que usa el camino de entrada (`isWithinMessagingWindow`
    // compara con `<`), para que el panel y el canal no discrepen en el minuto
    // en que más importa.
    expect(instagramReplyWindow(haceMs(MESSAGING_WINDOW_MS), AHORA).open).toBe(false);
    expect(instagramReplyWindow(haceMs(MESSAGING_WINDOW_MS - 1), AHORA).open).toBe(true);
  });

  it('dice CUÁNDO se cierra, que es lo que permite avisar antes', () => {
    const ultimoEntrante = haceMs(2 * 60 * 60 * 1000);
    const ventana = instagramReplyWindow(ultimoEntrante, AHORA);
    expect(ventana.closesAt?.getTime()).toBe(ultimoEntrante.getTime() + MESSAGING_WINDOW_MS);
  });

  it('sin fecha de entrada no se bloquea al comerciante', () => {
    // Conversaciones anteriores a la columna. Dejar mudo al comerciante en una
    // conversación viva por un dato que aún no existía es peor que el riesgo de
    // un rechazo de Meta, que quien llama ya sabe convertir en un error legible.
    expect(instagramReplyWindow(null, AHORA)).toEqual({ open: true, closesAt: null });
  });
});

describe('splitForChannel — partir sin perder nada', () => {
  it('un mensaje que cabe sale entero y en un solo cuerpo', () => {
    expect(splitForChannel('Claro, te lo mando hoy mismo.', 1000)).toEqual(['Claro, te lo mando hoy mismo.']);
  });

  it('NO le añade nada a lo que escribió la persona', () => {
    // La propiedad de esta función, y la razón por la que existe separada del
    // renderizador del agente: lo que sale es carácter por carácter lo que se
    // escribió. Ni revelación, ni firma, ni prefijo.
    const texto = 'Hola Ana, soy Marcela de la tienda. Te lo aparto hasta mañana.';
    expect(splitForChannel(texto, 1000).join('')).toBe(texto);
  });

  it('parte por párrafo antes que por palabra, y no pierde caracteres', () => {
    const parrafo1 = 'a'.repeat(40);
    const parrafo2 = 'b'.repeat(40);
    const trozos = splitForChannel(`${parrafo1}\n\n${parrafo2}`, 50);
    expect(trozos).toEqual([parrafo1, parrafo2]);
  });

  it('una sola palabra más larga que el tope se corta en seco, nunca se trunca', () => {
    const palabra = 'x'.repeat(120);
    const trozos = splitForChannel(palabra, 50);
    expect(trozos.join('')).toBe(palabra);
    expect(trozos.every((t) => t.length <= 50)).toBe(true);
  });

  it('ningún cuerpo se pasa del tope del canal', () => {
    const largo = Array.from({ length: 300 }, (_, i) => `linea ${i}`).join('\n');
    for (const trozo of splitForChannel(largo, 1000)) {
      expect(trozo.length).toBeLessThanOrEqual(1000);
    }
  });

  it('un texto en blanco no produce ningún cuerpo', () => {
    // Un mensaje vacío es un error del proveedor y un hueco en el transcripto.
    expect(splitForChannel('   \n  ', 1000)).toEqual([]);
  });
});
