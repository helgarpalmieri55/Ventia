import { describe, expect, it } from 'vitest';
import {
  AUTOR_MENSAJE,
  INTERVALO_DETALLE_MS,
  INTERVALO_LISTA_MS,
  avisoVentana,
  conversacionesConNovedad,
  estaAlFondo,
  estadoCompositor,
  estiloDeMensaje,
  mensajesNuevos,
} from '../lib/conversations-live';
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
} from '../lib/conversations-api';

/**
 * Las reglas de la bandeja en vivo.
 *
 * Lo que se fija aquí es justo lo que un componente puede romper en silencio:
 * que se note que llegó un mensaje, que el scroll no se le vaya de las manos al
 * comerciante mientras relee, y que el cuadro de respuesta explique por qué
 * está cerrado ANTES de que alguien escriba tres párrafos para nada.
 */

function conversacion(over: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    channel: 'instagram',
    status: 'open',
    shopperRef: '61000000',
    startedAt: '2026-08-23T10:00:00.000Z',
    messageCount: 2,
    lastMessage: 'hola',
    lastMessageAt: '2026-08-23T10:00:00.000Z',
    lastMessageRole: 'user',
    ...over,
  };
}

function mensaje(id: string, role = 'user'): ConversationMessage {
  return { id, role, content: `contenido ${id}`, createdAt: '2026-08-23T10:00:00.000Z' };
}

function detalle(over: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'c1',
    channel: 'instagram',
    status: 'open',
    shopperRef: '61000000',
    startedAt: '2026-08-23T10:00:00.000Z',
    messages: [],
    canReply: true,
    replyBlockedReason: null,
    replyWindowClosesAt: null,
    replyMaxChars: 1000,
    ...over,
  };
}

describe('conversacionesConNovedad — que se note que llegó algo', () => {
  it('marca la conversación cuyo último mensaje cambió', () => {
    const antes = [conversacion({ id: 'a' }), conversacion({ id: 'b' })];
    const despues = [
      conversacion({ id: 'a', lastMessageAt: '2026-08-23T10:05:00.000Z' }),
      conversacion({ id: 'b' }),
    ];
    expect(conversacionesConNovedad(antes, despues)).toEqual(new Set(['a']));
  });

  it('detecta un mensaje repetido, que comparar textos no vería', () => {
    // «hola» dos veces seguidas es de lo más normal, y es exactamente el caso
    // en que comparar contenidos perdería el segundo.
    const antes = [conversacion({ id: 'a', lastMessage: 'hola' })];
    const despues = [
      conversacion({ id: 'a', lastMessage: 'hola', lastMessageAt: '2026-08-23T10:05:00.000Z' }),
    ];
    expect(conversacionesConNovedad(antes, despues)).toEqual(new Set(['a']));
  });

  it('una conversación que aparece por primera vez es novedad', () => {
    // Un cliente nuevo escribiendo: lo que más se quiere ver en esta pantalla.
    const antes = [conversacion({ id: 'a' })];
    const despues = [conversacion({ id: 'nueva' }), conversacion({ id: 'a' })];
    expect(conversacionesConNovedad(antes, despues)).toEqual(new Set(['nueva']));
  });

  it('la PRIMERA carga no marca nada', () => {
    // Si no, la pantalla entera aparecería resaltada, que es lo mismo que no
    // resaltar nada.
    const despues = [conversacion({ id: 'a' }), conversacion({ id: 'b' })];
    expect(conversacionesConNovedad([], despues).size).toBe(0);
  });

  it('sin cambios no marca nada', () => {
    const filas = [conversacion({ id: 'a' }), conversacion({ id: 'b' })];
    expect(conversacionesConNovedad(filas, filas).size).toBe(0);
  });

  it('una conversación sin ningún mensaje no se marca sola en cada sondeo', () => {
    const vacia = conversacion({ id: 'a', lastMessage: null, lastMessageAt: null, lastMessageRole: null });
    expect(conversacionesConNovedad([vacia], [vacia]).size).toBe(0);
  });
});

describe('mensajesNuevos — resaltar solo lo que acaba de llegar', () => {
  it('devuelve los ids que no estaban antes', () => {
    const antes = [mensaje('m1'), mensaje('m2')];
    const despues = [mensaje('m1'), mensaje('m2'), mensaje('m3')];
    expect(mensajesNuevos(antes, despues)).toEqual(new Set(['m3']));
  });

  it('la primera carga no resalta el transcripto entero', () => {
    expect(mensajesNuevos([], [mensaje('m1'), mensaje('m2')]).size).toBe(0);
  });

  it('sin novedades no resalta nada', () => {
    const mensajes = [mensaje('m1')];
    expect(mensajesNuevos(mensajes, mensajes).size).toBe(0);
  });
});

describe('estaAlFondo — no arrastrarle la vista a nadie', () => {
  it('al final del transcripto, sí', () => {
    expect(estaAlFondo({ scrollTop: 600, scrollHeight: 900, clientHeight: 300 })).toBe(true);
  });

  it('leyendo hacia arriba, NO', () => {
    // El caso que hay que proteger: uno sube a releer justo antes de contestar,
    // y bajarle la vista cada tres segundos hace el panel inusable.
    expect(estaAlFondo({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 })).toBe(false);
  });

  it('«casi abajo» cuenta como abajo', () => {
    // Redondeo de subpíxeles y el gesto de quedarse a un dedo del final.
    expect(estaAlFondo({ scrollTop: 570, scrollHeight: 900, clientHeight: 300 })).toBe(true);
    expect(estaAlFondo({ scrollTop: 540, scrollHeight: 900, clientHeight: 300 }, 48)).toBe(false);
  });

  it('un transcripto que cabe entero siempre está al fondo', () => {
    expect(estaAlFondo({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true);
  });
});

describe('estadoCompositor — decirlo antes de escribir, no al enviar', () => {
  it('deja escribir cuando el servidor dice que sí, con el tope del canal', () => {
    const estado = estadoCompositor(detalle({ canReply: true, replyMaxChars: 1000 }));
    expect(estado).toEqual({ habilitado: true, aviso: null, maxChars: 1000 });
  });

  it('la ventana cerrada se explica en español y dice qué la reabre', () => {
    const estado = estadoCompositor(
      detalle({ canReply: false, replyBlockedReason: 'MESSAGING_WINDOW_CLOSED' }),
    );
    expect(estado.habilitado).toBe(false);
    expect(estado.aviso).toContain('24 horas');
    // Lo único que el comerciante puede hacer: esperar a que el cliente
    // escriba. Decirlo evita que se quede intentándolo.
    expect(estado.aviso).toContain('vuelva a escribirte');
  });

  it('cada motivo tiene su propio texto, no uno genérico', () => {
    const motivos = [
      'MESSAGING_WINDOW_CLOSED',
      'CHANNEL_NOT_CONNECTED',
      'CHANNEL_NOT_IN_PLAN',
      'SHOPPER_UNREACHABLE',
    ] as const;
    const textos = motivos.map(
      (m) => estadoCompositor(detalle({ canReply: false, replyBlockedReason: m })).aviso,
    );
    expect(new Set(textos).size).toBe(motivos.length);
    expect(textos.every((t) => (t ?? '').length > 0)).toBe(true);
  });

  it('bloqueado sin motivo conocido no deja escribir igualmente', () => {
    // Fallar hacia «no se puede» es lo correcto aquí: lo contrario sería
    // dejar al comerciante escribir para que el envío falle después.
    const estado = estadoCompositor(detalle({ canReply: false, replyBlockedReason: null }));
    expect(estado.habilitado).toBe(false);
    expect(estado.aviso).toBeTruthy();
  });

  it('el tope de caracteres viene del servidor, no de una constante copiada', () => {
    // Instagram corta en 1000 y WhatsApp en 4096; un número escrito a mano aquí
    // se desincroniza del canal en cuanto cambie.
    expect(estadoCompositor(detalle({ replyMaxChars: 4096 })).maxChars).toBe(4096);
  });
});

describe('avisoVentana — avisar del borde, no llevar un reloj', () => {
  const ahora = new Date('2026-08-23T12:00:00.000Z');

  it('no dice nada cuando queda mucho', () => {
    // Un contador permanente en una conversación de hace diez minutos es
    // ansiedad sin información.
    const cierre = new Date(ahora.getTime() + 20 * 60 * 60 * 1000).toISOString();
    expect(avisoVentana(cierre, ahora)).toBeNull();
  });

  it('avisa en las últimas horas', () => {
    const cierre = new Date(ahora.getTime() + 2 * 60 * 60 * 1000).toISOString();
    expect(avisoVentana(cierre, ahora)).toContain('h para responder');
  });

  it('en la última hora cuenta en minutos', () => {
    const cierre = new Date(ahora.getTime() + 25 * 60 * 1000).toISOString();
    expect(avisoVentana(cierre, ahora)).toBe('Te queda 25 min para responder por este canal.');
  });

  it('ya cerrada no avisa: de eso se encarga el cuadro deshabilitado', () => {
    const cierre = new Date(ahora.getTime() - 60 * 1000).toISOString();
    expect(avisoVentana(cierre, ahora)).toBeNull();
  });

  it('sin ventana (WhatsApp, widget web) no dice nada', () => {
    expect(avisoVentana(null, ahora)).toBeNull();
  });

  it('una fecha ilegible no rompe la pantalla', () => {
    expect(avisoVentana('mañana por la tarde', ahora)).toBeNull();
  });
});

describe('estiloDeMensaje — quién dijo qué', () => {
  it('la persona del equipo no se pinta como el agente', () => {
    // El punto entero del rol `human`: si los dos salieran iguales, el
    // transcripto no podría decir dónde entró una persona.
    expect(estiloDeMensaje('human')).toBe('equipo');
    expect(estiloDeMensaje('assistant')).toBe('agente');
    expect(estiloDeMensaje('human')).not.toBe(estiloDeMensaje('assistant'));
  });

  it('el cliente es el tercer estilo', () => {
    expect(estiloDeMensaje('user')).toBe('cliente');
  });

  it('un rol desconocido se pinta como del cliente, nunca como de la tienda', () => {
    // Atribuirle a la tienda algo que no dijo es el error que no se puede
    // cometer; atribuírselo al cliente es visible y no engaña a nadie.
    expect(estiloDeMensaje('lo-que-sea')).toBe('cliente');
  });

  it('cada estilo tiene un autor con nombre', () => {
    expect(AUTOR_MENSAJE.equipo).toBe('Tú');
    expect(AUTOR_MENSAJE.agente).toBe('Asistente');
    expect(AUTOR_MENSAJE.cliente).toBe('Cliente');
  });
});

describe('los intervalos de sondeo', () => {
  it('el detalle se refresca más a menudo que la lista', () => {
    // Es donde el comerciante está mirando y desde donde contesta.
    expect(INTERVALO_DETALLE_MS).toBeLessThan(INTERVALO_LISTA_MS);
  });

  it('ninguno baja de un segundo', () => {
    // Por debajo de eso el comerciante no nota nada y la base de datos sí.
    expect(INTERVALO_DETALLE_MS).toBeGreaterThanOrEqual(1000);
    expect(INTERVALO_LISTA_MS).toBeGreaterThanOrEqual(1000);
  });
});
