import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GraphProvider, INSTAGRAM_MAX_CHARS } from '../src/graph';
import { InstagramError } from '../src/errors';
import type { InstagramConfig } from '../src/index';

/**
 * El adaptador de la Graph API, contra la forma de payload publicada en
 * developers.facebook.com/docs/messenger-platform/instagram.
 *
 * No había ninguna app de Meta viva, así que estas fixtures son los ejemplos
 * de la documentación y no tráfico capturado — que es la diferencia entre
 * "esto parsea lo que Meta documenta" y "esto parsea lo que Meta manda".
 */

const provider = new GraphProvider();

const IG_ACCOUNT_ID = '17841405793187218';
const SHOPPER_IGSID = '6123456789012345';

const config: InstagramConfig = {
  igAccountId: IG_ACCOUNT_ID,
  token: 'EAAG...page-token',
  appSecret: 'app-secret-value',
  verifyToken: 'mi-token-de-verificacion',
};

/** Ahora, para que la ventana de 24 horas esté abierta en las fixtures. */
const NOW_MS = 1_756_000_000_000;

function inboundPayload(
  overrides: {
    text?: string;
    igAccountId?: string;
    mid?: string;
    timestamp?: number;
    senderId?: string;
    extraMessage?: Record<string, unknown>;
  } = {},
) {
  return {
    object: 'instagram',
    entry: [
      {
        id: overrides.igAccountId ?? IG_ACCOUNT_ID,
        time: overrides.timestamp ?? NOW_MS,
        messaging: [
          {
            sender: { id: overrides.senderId ?? SHOPPER_IGSID },
            recipient: { id: IG_ACCOUNT_ID },
            timestamp: overrides.timestamp ?? NOW_MS,
            message: {
              mid: overrides.mid ?? 'aWdfZAG1faXRlbToxOklHTWVzc2FnZUlEOjE3ODQx',
              text: overrides.text ?? '¿Tienen esta camisa en talla M?',
              ...overrides.extraMessage,
            },
          },
        ],
      },
    ],
  };
}

function sign(raw: string, secret = config.appSecret!): Record<string, string> {
  return { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}` };
}

function parse(payload: unknown, opts: { secret?: string; config?: InstagramConfig } = {}) {
  const raw = JSON.stringify(payload);
  return provider.verifyAndParseWebhook(raw, sign(raw, opts.secret ?? config.appSecret!), opts.config ?? config);
}

describe('GraphProvider.verifyAndParseWebhook — firma', () => {
  it('parsea una entrega bien firmada', () => {
    const messages = parse(inboundPayload());
    expect(messages).toEqual([
      {
        from: SHOPPER_IGSID,
        text: '¿Tienen esta camisa en talla M?',
        externalId: 'aWdfZAG1faXRlbToxOklHTWVzc2FnZUlEOjE3ODQx',
        sentAtMs: NOW_MS,
      },
    ]);
  });

  it('devuelve null con una firma de otro secreto', () => {
    expect(parse(inboundPayload(), { secret: 'secreto-falsificado' })).toBeNull();
  });

  it('devuelve null sin cabecera de firma', () => {
    expect(provider.verifyAndParseWebhook(JSON.stringify(inboundPayload()), {}, config)).toBeNull();
  });

  it('falla CERRADO si la configuración no tiene app secret', () => {
    // Meta documenta la firma como opcional; aquí no lo es. Sin ella, quien
    // conozca un id de cuenta puede gastar el presupuesto del comerciante.
    const raw = JSON.stringify(inboundPayload());
    expect(provider.verifyAndParseWebhook(raw, sign(raw), { ...config, appSecret: undefined })).toBeNull();
  });

  it('rechaza una firma calculada sobre otro cuerpo', () => {
    // Reserializar el JSON parseado da otros bytes: por eso la firma se
    // calcula sobre el cuerpo crudo y por eso `main.ts` monta express.raw.
    const signed = JSON.stringify(inboundPayload({ text: 'original' }));
    const tampered = JSON.stringify(inboundPayload({ text: 'manipulado' }));
    expect(provider.verifyAndParseWebhook(tampered, sign(signed), config)).toBeNull();
  });

  it('devuelve null con un cuerpo que no es JSON', () => {
    expect(provider.verifyAndParseWebhook('esto no es json', sign('esto no es json'), config)).toBeNull();
  });
});

describe('GraphProvider.verifyAndParseWebhook — enrutamiento', () => {
  it('devuelve null si el objeto no es de Instagram', () => {
    // Un payload de WhatsApp parseado aquí sería el canal equivocado
    // contestando el mensaje de otro canal.
    expect(parse({ ...inboundPayload(), object: 'whatsapp_business_account' })).toBeNull();
  });

  it('ignora la entrada de OTRA cuenta de Instagram', () => {
    // Una sola app de Meta entrega por todas las cuentas conectadas a ella.
    expect(parse(inboundPayload({ igAccountId: '17800000000000000' }))).toEqual([]);
  });

  it('saca todos los mensajes de una entrega con varios', () => {
    const payload = inboundPayload();
    payload.entry[0].messaging.push({
      sender: { id: SHOPPER_IGSID },
      recipient: { id: IG_ACCOUNT_ID },
      timestamp: NOW_MS + 1000,
      message: { mid: 'mid.segundo', text: 'y en azul?' },
    });

    const messages = parse(payload);
    expect(messages?.map((m) => m.text)).toEqual(['¿Tienen esta camisa en talla M?', 'y en azul?']);
  });
});

describe('GraphProvider.verifyAndParseWebhook — qué se descarta', () => {
  it('descarta nuestro propio eco', () => {
    // Sin esto el agente se contesta a sí mismo, para siempre, pagando.
    expect(parse(inboundPayload({ extraMessage: { is_echo: true } }))).toEqual([]);
  });

  it('descarta un mensaje cuyo remitente es la propia cuenta', () => {
    // La segunda señal, independiente de `is_echo`.
    expect(parse(inboundPayload({ senderId: IG_ACCOUNT_ID }))).toEqual([]);
  });

  it('descarta los mensajes borrados y los no soportados', () => {
    expect(parse(inboundPayload({ extraMessage: { is_deleted: true } }))).toEqual([]);
    expect(parse(inboundPayload({ extraMessage: { is_unsupported: true } }))).toEqual([]);
  });

  it('descarta un mensaje sin texto (una foto)', () => {
    const payload = inboundPayload();
    delete (payload.entry[0].messaging[0].message as Record<string, unknown>).text;
    (payload.entry[0].messaging[0].message as Record<string, unknown>).attachments = [
      { type: 'image', payload: { url: 'https://scontent.cdninstagram.com/x.jpg' } },
    ];
    expect(parse(payload)).toEqual([]);
  });

  it('descarta un texto que es solo espacios', () => {
    expect(parse(inboundPayload({ text: '   ' }))).toEqual([]);
  });

  it('ignora los eventos que no son mensajes (lecturas, reacciones)', () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: IG_ACCOUNT_ID,
          messaging: [
            { sender: { id: SHOPPER_IGSID }, recipient: { id: IG_ACCOUNT_ID }, read: { mid: 'mid.1' } },
            { sender: { id: SHOPPER_IGSID }, recipient: { id: IG_ACCOUNT_ID }, reaction: { emoji: '❤️' } },
          ],
        },
      ],
    };
    expect(parse(payload)).toEqual([]);
  });

  it('ignora las conversaciones en `standby` de otra app', () => {
    // Traspaso de Meta: otra app está atendiendo esa conversación. Contestar
    // sería hablar por encima de quien está al mando.
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: IG_ACCOUNT_ID,
          standby: [
            {
              sender: { id: SHOPPER_IGSID },
              recipient: { id: IG_ACCOUNT_ID },
              timestamp: NOW_MS,
              message: { mid: 'mid.standby', text: 'hola?' },
            },
          ],
        },
      ],
    };
    expect(parse(payload)).toEqual([]);
  });

  it('descarta un mensaje sin marca de tiempo usable', () => {
    // Sin marca de tiempo no se puede decidir la ventana de 24 horas.
    const payload = inboundPayload();
    delete (payload.entry[0].messaging[0] as Record<string, unknown>).timestamp;
    expect(parse(payload)).toEqual([]);
  });

  it('conserva la respuesta a una historia, que sí trae texto', () => {
    const messages = parse(
      inboundPayload({
        text: 'me encanta, cuánto vale?',
        extraMessage: { reply_to: { story: { id: '1', url: 'https://…' } } },
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages![0].text).toBe('me encanta, cuánto vale?');
  });

  it('acepta una marca de tiempo en segundos y la sube a milisegundos', () => {
    // Instagram manda milisegundos; WhatsApp segundos. Confundirlos deja la
    // ventana abierta para siempre o cerrada para siempre.
    const messages = parse(inboundPayload({ timestamp: 1_756_000_000 }));
    expect(messages![0].sentAtMs).toBe(1_756_000_000_000);
  });
});

describe('GraphProvider.verifyHandshake', () => {
  it('devuelve el challenge con el token correcto', () => {
    expect(
      GraphProvider.verifyHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'mi-token-de-verificacion', 'hub.challenge': '1158201444' },
        config,
      ),
    ).toBe('1158201444');
  });

  it('devuelve null con un token que no es', () => {
    expect(
      GraphProvider.verifyHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'adivinado', 'hub.challenge': '1158201444' },
        config,
      ),
    ).toBeNull();
  });

  it('devuelve null si el modo no es subscribe', () => {
    expect(
      GraphProvider.verifyHandshake(
        { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'mi-token-de-verificacion', 'hub.challenge': '1' },
        config,
      ),
    ).toBeNull();
  });

  it('devuelve null si la cuenta no tiene token de verificación guardado', () => {
    expect(
      GraphProvider.verifyHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' },
        { ...config, verifyToken: undefined },
      ),
    ).toBeNull();
  });
});

describe('GraphProvider.sendText', () => {
  it('llama a la Graph API con la cuenta en la ruta y el token en la cabecera', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message_id":"mid.1"}', { status: 200 }));
    await provider.sendText(SHOPPER_IGSID, 'Sí, nos queda en M.', config, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/v21.0/${IG_ACCOUNT_ID}/messages`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer EAAG...page-token');
    expect(JSON.parse(init.body as string)).toEqual({
      recipient: { id: SHOPPER_IGSID },
      message: { text: 'Sí, nos queda en M.' },
    });
  });

  it('nunca pone el token en la URL', async () => {
    // Una URL termina en logs de acceso, trazas y mensajes de error.
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await provider.sendText(SHOPPER_IGSID, 'hola', config, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).not.toContain('EAAG');
  });

  it('lanza InstagramError con el estado y el cuerpo cuando Meta rechaza', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":{"message":"fuera de la ventana","code":10,"error_subcode":2534022}}', { status: 400 }),
    );
    await expect(
      provider.sendText(SHOPPER_IGSID, 'tarde', config, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(InstagramError);
  });
});

describe('INSTAGRAM_MAX_CHARS', () => {
  it('es 1000, no los 4096 de WhatsApp', () => {
    // Si esto se copia de WhatsApp, Meta rechaza el mensaje entero y el
    // comprador no recibe nada.
    expect(INSTAGRAM_MAX_CHARS).toBe(1000);
  });
});
