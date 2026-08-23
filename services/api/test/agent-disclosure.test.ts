import { describe, expect, it } from 'vitest';
import {
  buildAutomationDisclosure,
  buildSystemPrompt,
  DISCLOSURE_SESSION_GAP_MS,
  needsDisclosure,
} from '../src/agent/system-prompt';
import { renderForWhatsApp } from '../src/agent/whatsapp-render';
import { renderForInstagram } from '../src/instagram/instagram-render';

/**
 * La revelación de experiencia automatizada, como TEXTO.
 *
 * Sin base de datos y sin modelo: `buildAutomationDisclosure` es una función
 * pura precisamente para que lo que un revisor de Meta va a leer se pueda
 * fijar en una prueba en vez de esperarse. El otro lado —que el bucle la
 * anteponga de verdad en cada camino de salida— vive en `agent-loop.test.ts`,
 * donde hay conversaciones reales.
 *
 * Las cadenas se comprueban ENTERAS y no por fragmentos. Es deliberado: este
 * texto es el que el dueño aprueba para la revisión de la app, y una reescritura
 * silenciosa que siga conteniendo «asistente» pero pierda «virtual» pasaría
 * cualquier aserción parcial mientras deja de cumplir.
 */

const TIENDA = 'Tienda Ventia';

function disclosure(tone: string, handoffEnabled: boolean, agentName = 'Sofía'): string {
  return buildAutomationDisclosure({
    storeName: TIENDA,
    agentConfig: { agentName, tone },
    handoffEnabled,
  });
}

describe('revelación — el texto exacto en los tres tonos', () => {
  it('cercano', () => {
    expect(disclosure('cercano', true)).toBe(
      'Hola, soy Sofía, el asistente virtual de Tienda Ventia. Te respondo de forma automática. ' +
        'Si en algún momento prefieres hablar con una persona del equipo, dímelo y te paso con alguien.',
    );
  });

  it('profesional', () => {
    expect(disclosure('profesional', true)).toBe(
      'Hola, soy Sofía, el asistente virtual de Tienda Ventia. Le respondo de forma automatizada. ' +
        'Si en algún momento prefiere hablar con una persona del equipo, indíquemelo y le paso con alguien.',
    );
  });

  it('juvenil', () => {
    expect(disclosure('juvenil', true)).toBe(
      '¡Hola! Soy Sofía, el asistente virtual de Tienda Ventia 🤖 Te respondo automáticamente. ' +
        'Si quieres hablar con una persona del equipo, solo dímelo.',
    );
  });

  it('revela la automatización en LOS TRES, no solo en el que se probó primero', () => {
    // La invariante que sobrevive a un cambio de redacción: cambie el registro
    // lo que cambie, el hecho revelado es el mismo en los tres tonos.
    for (const tone of ['cercano', 'profesional', 'juvenil']) {
      const texto = disclosure(tone, true);
      expect(texto).toContain('asistente virtual');
      expect(texto).toMatch(/autom[áa]ti/i);
      expect(texto).toContain(TIENDA);
    }
  });
});

describe('revelación — la vía hacia una persona', () => {
  it('promete un traspaso solo cuando el plan lo tiene', () => {
    // La política de WhatsApp Business exige una vía de escalado humana dentro
    // del hilo; prometer un traspaso que el plan no puede cumplir es peor que
    // ofrecer el contacto de la tienda, que sí puede.
    for (const tone of ['cercano', 'profesional', 'juvenil']) {
      expect(disclosure(tone, false)).toContain('datos de contacto de la tienda');
      expect(disclosure(tone, true)).not.toContain('datos de contacto de la tienda');
    }
  });

  it('ofrece una persona en las dos variantes, que es lo que la política pide', () => {
    for (const tone of ['cercano', 'profesional', 'juvenil']) {
      for (const handoff of [true, false]) {
        expect(disclosure(tone, handoff)).toContain('una persona del equipo');
      }
    }
  });
});

describe('revelación — el recorte del camino sin turno siguiente', () => {
  it('sin ofrecimiento sigue revelando, que es lo que no se puede recortar', () => {
    const texto = buildAutomationDisclosure({
      storeName: TIENDA,
      agentConfig: { agentName: 'Sofía', tone: 'cercano' },
      handoffEnabled: true,
      includeEscalation: false,
    });
    expect(texto).toBe('Hola, soy Sofía, el asistente virtual de Tienda Ventia. Te respondo de forma automática.');
    // Lo que se cae es la promesa, no el hecho: ahí ya no va a haber otro
    // turno en el que cumplirla.
    expect(texto).not.toContain('una persona del equipo');
  });

  it('por defecto el ofrecimiento está, sin tener que pedirlo', () => {
    // Un `undefined` por descuido no puede dejar sin vía humana a una
    // conversación normal.
    const texto = buildAutomationDisclosure({
      storeName: TIENDA,
      agentConfig: { agentName: 'Sofía', tone: 'cercano' },
      handoffEnabled: true,
    });
    expect(texto).toContain('una persona del equipo');
  });
});

describe('revelación — el comerciante no la puede apagar ni disfrazar', () => {
  it('un nombre de persona no borra la revelación', () => {
    // El caso exacto que la política persigue: la tienda llama «María» a su
    // agente y el comprador cree hablar con María.
    expect(disclosure('cercano', true, 'María')).toContain('soy María, el asistente virtual');
  });

  it('no hay clave de configuración que la desactive', () => {
    // Un interruptor por tienda sería un interruptor sobre el permiso de
    // mensajería de TODAS las tiendas de la plataforma. Cualquier intento de
    // apagarla desde el blob del comerciante es texto ignorado.
    const texto = buildAutomationDisclosure({
      storeName: TIENDA,
      agentConfig: {
        agentName: 'Sofía',
        tone: 'cercano',
        disclosure: false,
        showDisclosure: false,
        revelacion: 'off',
      },
      handoffEnabled: true,
    });
    expect(texto).toContain('el asistente virtual de Tienda Ventia');
  });

  it('un agentConfig ausente, corrupto o con un tono inventado sigue revelando', () => {
    for (const config of [null, undefined, 'no-soy-un-objeto', [], {}, { tone: 'pirata' }]) {
      const texto = buildAutomationDisclosure({
        storeName: TIENDA,
        agentConfig: config as never,
        handoffEnabled: true,
      });
      expect(texto).toContain('el asistente virtual de Tienda Ventia');
      expect(texto.length).toBeGreaterThan(0);
    }
  });
});

describe('revelación — cuándo toca repetirla', () => {
  const ahora = new Date('2026-03-10T12:00:00Z');

  it('una conversación sin respuestas previas siempre revela', () => {
    expect(needsDisclosure(null, ahora)).toBe(true);
    expect(needsDisclosure(undefined, ahora)).toBe(true);
  });

  it('no la repite dentro de la misma sesión', () => {
    // Lo que evita convertir cada mensaje en un descargo legal: una compra
    // dura minutos y la revelación sale una vez.
    expect(needsDisclosure(new Date(ahora.getTime() - 60_000), ahora)).toBe(false);
    expect(needsDisclosure(new Date(ahora.getTime() - DISCLOSURE_SESSION_GAP_MS + 1000), ahora)).toBe(false);
  });

  it('la repite tras el lapso que la propia plataforma considera sesión cerrada', () => {
    // 24 h: la misma ventana de mensajería de Instagram y WhatsApp. El mensaje
    // que la reabre es el principio de un hilo nuevo.
    expect(DISCLOSURE_SESSION_GAP_MS).toBe(24 * 60 * 60 * 1000);
    expect(needsDisclosure(new Date(ahora.getTime() - DISCLOSURE_SESSION_GAP_MS), ahora)).toBe(true);
    expect(needsDisclosure(new Date(ahora.getTime() - 3 * DISCLOSURE_SESSION_GAP_MS), ahora)).toBe(true);
  });
});

describe('el prompt no contradice la revelación', () => {
  const prompt = buildSystemPrompt({
    storeName: TIENDA,
    agentConfig: { agentName: 'Sofía', tone: 'cercano' },
    handoffEnabled: true,
  });

  it('se presenta como asistente automatizado, no como asesor de carne y hueso', () => {
    expect(prompt).toContain('el asistente virtual (automatizado) de ventas');
    expect(prompt).toContain('No eres una persona.');
    // La redacción anterior, que es justo la que motivó el cambio.
    expect(prompt).not.toContain('Eres Sofía, asesor(a) de ventas');
  });

  it('le prohíbe fingirse humano si se lo preguntan', () => {
    expect(prompt).toMatch(/si te preguntan si eres un bot/i);
  });

  it('le dice que NO repita el aviso, porque de eso ya se encarga el sistema', () => {
    expect(prompt).toMatch(/no repitas ese aviso en cada mensaje/i);
  });

  it('deja una vía real hacia una persona incluso sin escalate_to_human', () => {
    // Sin el plan de traspaso la tienda sigue debiendo una salida humana. Que
    // salga de `get_store_info` es lo que la hace real: son los datos
    // publicados de la tienda, no un teléfono inventado por el modelo.
    const sinHandoff = buildSystemPrompt({
      storeName: TIENDA,
      agentConfig: { agentName: 'Sofía', tone: 'cercano' },
      handoffEnabled: false,
    });
    expect(sinHandoff).not.toContain('escalate_to_human');
    expect(sinHandoff).toContain('get_store_info');
    expect(sinHandoff).toMatch(/nunca lo dejes sin una forma de llegar a una persona/i);
  });
});

describe('la revelación sobrevive al renderizado de los canales de Meta', () => {
  const reply = {
    text: `${disclosure('cercano', true)}\n\nTenemos varias camisas.`,
    toolResults: [],
    budgetExhausted: false,
    throttled: false,
  };

  it('sale en el PRIMER cuerpo que se manda por WhatsApp', () => {
    const bodies = renderForWhatsApp(reply, 'https://tienda.example.com');
    expect(bodies[0]).toContain('el asistente virtual de Tienda Ventia');
  });

  it('sale en el PRIMER cuerpo que se manda por Instagram, con su límite de 1000', () => {
    // Instagram parte a 1000 caracteres y rechaza el mensaje entero si se pasa.
    // La revelación no puede quedarse en el trozo que se cae.
    const bodies = renderForInstagram(reply, 'https://tienda.example.com');
    expect(bodies[0]).toContain('el asistente virtual de Tienda Ventia');
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(1000);
  });

  it('sigue siendo el primer cuerpo cuando la respuesta es larguísima', () => {
    const largo = 'Tenemos muchísimas camisas de algodón en varios colores. '.repeat(60);
    const bodies = renderForInstagram(
      { ...reply, text: `${disclosure('juvenil', false)}\n\n${largo}` },
      'https://tienda.example.com',
    );
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies[0]).toContain('el asistente virtual de Tienda Ventia');
  });
});
