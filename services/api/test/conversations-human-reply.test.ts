import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type { InstagramInboundService as InstagramInboundServiceType } from '../src/instagram/instagram-inbound.service';
import type { InstagramAccountsService as InstagramAccountsServiceType } from '../src/instagram/instagram-accounts.service';

/**
 * El comerciante contesta, como persona, desde el panel.
 *
 * Es la mitad que le faltaba a `escalate_to_human`: el producto sabía decir
 * «esta conversación necesita a alguien» y no sabía dejar que ese alguien
 * dijera nada. Lo que se fija aquí:
 *
 *  1. Lo que sale por el canal es EXACTAMENTE lo que escribió la persona. Sin
 *     revelación de experiencia automatizada — la del agente sí la lleva, y esa
 *     asimetría es el punto entero.
 *  2. La ventana de 24 horas de Instagram se respeta también para una respuesta
 *     humana, y se dice ANTES de escribir, no al enviar.
 *  3. Mientras atiende una persona, el agente calla; y cuando le devuelven la
 *     conversación, vuelve a revelarse.
 */

const APP_SECRET = 'meta-app-secret-humano';
const IG_ACCOUNT_ID = '17841400000000001';
const SHOPPER_IGSID = '6100000000000001';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let inbound: InstagramInboundServiceType;
let accounts: InstagramAccountsServiceType;
let signUpWithTenant: typeof SignUpWithTenant;

let cookie: string;
let tenantId: string;
let accountId: string;
let otherCookie: string;
let otherTenantId: string;
/** El dominio público de la tienda, para las peticiones del widget. */
let storefrontDomain: string;

/** Respuestas guionizadas del modelo falso, una por `messages.create`. */
let scripted: unknown[] = [];
/** Cuántas veces se llamó al modelo desde el último `beforeEach`. */
let modelCalls = 0;
/** Los envíos que el canal intentó contra la Graph API. */
let sent: { url: string; body: Record<string, unknown> | null }[] = [];

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 5, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';
  process.env.PAYMENTS_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');

  const { ANTHROPIC_CLIENT } = await import('../src/agent/agent.service');
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ANTHROPIC_CLIENT)
    .useValue({
      messages: {
        create: vi.fn(async () => {
          modelCalls += 1;
          const next = scripted.shift();
          if (!next) throw new Error('cliente anthropic falso: no queda respuesta guionizada');
          return next;
        }),
      },
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();

  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  ({ signUpWithTenant } = await import('./admin-helpers'));
  const { InstagramInboundService } = await import('../src/instagram/instagram-inbound.service');
  const { InstagramAccountsService } = await import('../src/instagram/instagram-accounts.service');
  inbound = app.get(InstagramInboundService);
  accounts = app.get(InstagramAccountsService);

  ({ cookie, tenantId } = await signUpWithTenant('humano-owner@demo.co', 'owner'));
  ({ cookie: otherCookie, tenantId: otherTenantId } = await signUpWithTenant('humano-otro@demo.co', 'owner'));

  for (const id of [tenantId, otherTenantId]) {
    await prisma.tenantLimits.create({
      data: { tenantId: id, productsMax: 100, aiCreditsMonth: 500, staffSeats: 2, instagramChannel: true },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: id, domain: `${id.slice(0, 8)}.ventia.localhost`, isPrimary: true },
    });
  }
  storefrontDomain = `${tenantId.slice(0, 8)}.ventia.localhost`;

  const account = await accounts.connect({
    tenantId,
    provider: 'graph',
    igAccountId: IG_ACCOUNT_ID,
    pageId: '102290129340398',
    username: 'mitienda',
    credentials: { token: 'page-token', appSecret: APP_SECRET, verifyToken: 'verificame' },
  });
  accountId = account.id;
}, 300_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(() => {
  scripted = [];
  sent = [];
  modelCalls = 0;
  // `GraphProvider.sendText` usa el `fetch` global, así que sustituirlo es
  // todo lo que hace falta para ver qué se manda sin tocar la red.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response('{"message_id":"mid.enviado"}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Un mensaje entrante de Instagram, por el camino real del canal. */
async function shopperWrites(text: string, opts: { sentAtMs?: number; from?: string } = {}): Promise<void> {
  const config = { igAccountId: IG_ACCOUNT_ID, token: 'page-token', appSecret: APP_SECRET };
  await inbound.handle({
    tenantId,
    accountId,
    provider: 'graph',
    config,
    message: {
      from: opts.from ?? SHOPPER_IGSID,
      text,
      externalId: `mid.${Math.random().toString(36).slice(2)}`,
      sentAtMs: opts.sentAtMs ?? Date.now(),
    },
  });
}

/** La conversación abierta de este comprador. */
async function currentConversation(from = SHOPPER_IGSID) {
  return prisma.conversation.findFirstOrThrow({
    where: { tenantId, channel: 'instagram', shopperRef: from },
    orderBy: { startedAt: 'desc' },
  });
}

/** Deja a este comprador sin conversación abierta, para que la siguiente
 * prueba empiece limpia. */
async function closeConversations(from = SHOPPER_IGSID) {
  await prisma.conversation.updateMany({
    where: { tenantId, channel: 'instagram', shopperRef: from },
    data: { status: 'resolved' },
  });
}

/** Los cuerpos de texto que salieron hacia el comprador. */
function sentBodies(): string[] {
  return sent.map((s) => String((s.body as { message?: { text?: string } } | null)?.message?.text ?? ''));
}

describe('POST /v1/admin/conversations/:id/reply — la respuesta la escribe una persona', () => {
  it('manda por el canal EXACTAMENTE lo que escribió el comerciante', async () => {
    scripted = [textResponse('Tenemos varias camisas.')];
    await shopperWrites('¿tienen camisas?');
    const conversation = await currentConversation();
    sent = [];

    const texto = 'Hola, soy Marcela. Te aparto la talla M hasta mañana.';
    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: texto });

    expect(res.status).toBe(201);
    expect(sentBodies()).toEqual([texto]);
    await closeConversations();
  });

  it('NO le antepone la revelación de que es automático, que es lo que la haría falsa', async () => {
    // La asimetría entera de esta función. Lo que manda el agente lleva «te
    // respondo de forma automática» porque quien escribe es una máquina; decir
    // eso de lo que escribe una persona no es cumplir la política de Meta, es
    // una afirmación falsa sobre quién está hablando.
    scripted = [textResponse('Con gusto te ayudo.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    // Primero, la mitad que SÍ tiene que llevarla: lo que ya mandó el agente.
    const delAgente = await prisma.message.findFirstOrThrow({
      where: { conversationId: conversation.id, role: 'assistant' },
    });
    expect(delAgente.content).toContain('asistente virtual');
    expect(delAgente.content).toMatch(/autom[áa]ti/i);

    sent = [];
    const texto = 'Claro que sí, ya te la reservo.';
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: texto });

    const humano = await prisma.message.findFirstOrThrow({
      where: { conversationId: conversation.id, role: 'human' },
    });
    expect(humano.content).toBe(texto);
    expect(humano.content).not.toContain('asistente virtual');
    expect(humano.content).not.toMatch(/autom[áa]ti/i);
    // Y lo que salió por el cable tampoco lleva nada delante.
    expect(sentBodies()).toEqual([texto]);
    await closeConversations();
  });

  it('lo deja en el transcripto con un rol que lo distingue del agente', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Te escribo yo, Marcela.' });

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${conversation.id}`)
      .set('cookie', cookie);

    const roles = res.body.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain('human');
    expect(roles).toContain('assistant');
    // Y el transcripto los devuelve como cosas distintas, que es lo que le
    // permite al panel enseñar quién dijo qué.
    const humano = res.body.messages.filter((m: { role: string }) => m.role === 'human');
    expect(humano).toHaveLength(1);
    expect(humano[0].content).toBe('Te escribo yo, Marcela.');
    await closeConversations();
  });

  it('parte un mensaje largo en cuerpos que Instagram acepta, sin perder nada', async () => {
    // Instagram rechaza el mensaje ENTERO por pasarse de 1000 caracteres: sin
    // partirlo, el comprador no recibe la mitad, no recibe nada.
    scripted = [textResponse('Hola.')];
    await shopperWrites('mándame la política de cambios');
    const conversation = await currentConversation();
    sent = [];

    const largo = Array.from({ length: 60 }, (_, i) => `Punto ${i}: cambios dentro de 30 días.`).join('\n');
    expect(largo.length).toBeGreaterThan(1000);

    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: largo });

    const cuerpos = sentBodies();
    expect(cuerpos.length).toBeGreaterThan(1);
    expect(cuerpos.every((c) => c.length <= 1000)).toBe(true);
    // Nada se truncó por el camino.
    expect(cuerpos.join('\n')).toBe(largo);
    await closeConversations();
  });

  it('rechaza un mensaje vacío en vez de mandar un hueco por el canal', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    sent = [];

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(sent).toHaveLength(0);
    await closeConversations();
  });

  it('nunca contesta la conversación de otra tienda', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    sent = [];

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', otherCookie)
      .send({ text: 'me cuelo en la conversación ajena' });

    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
    expect(await prisma.message.count({ where: { conversationId: conversation.id, role: 'human' } })).toBe(0);
    await closeConversations();
  });

  it('no guarda nada si el canal rechaza el envío', async () => {
    // El orden importa: un transcripto que dice «atendido» cuando el mensaje no
    // salió es peor que no tener transcripto, porque este panel existe
    // justamente para saber a quién falta contestar.
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"nope"}}', { status: 400 })));

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'esto no va a salir' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('REPLY_NOT_DELIVERED');
    expect(await prisma.message.count({ where: { conversationId: conversation.id, role: 'human' } })).toBe(0);
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.status).not.toBe('human');
    await closeConversations();
  });
});

describe('la ventana de 24 horas se aplica también a una persona', () => {
  it('el detalle avisa de que está cerrada ANTES de que el comerciante escriba', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${conversation.id}`)
      .set('cookie', cookie);

    expect(res.body.canReply).toBe(false);
    expect(res.body.replyBlockedReason).toBe('MESSAGING_WINDOW_CLOSED');
    await closeConversations();
  });

  it('se niega a enviar fuera de plazo, sin tocar la Graph API', async () => {
    // Intentarlo y que Meta lo rechace también «funcionaría», pero es
    // exactamente el uso que la plataforma vigila: fuera de plazo solo se puede
    // escribir con una etiqueta que esta app no tiene aprobada.
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    sent = [];

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'llego tarde' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('MESSAGING_WINDOW_CLOSED');
    expect(sent).toHaveLength(0);
    expect(await prisma.message.count({ where: { conversationId: conversation.id, role: 'human' } })).toBe(0);
    await closeConversations();
  });

  it('dentro de plazo deja contestar y dice cuándo se cierra', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${conversation.id}`)
      .set('cookie', cookie);

    expect(res.body.canReply).toBe(true);
    expect(res.body.replyBlockedReason).toBeNull();
    // Veinticuatro horas después del mensaje del comprador, para poder avisar
    // antes de que se cierre.
    const cierre = new Date(res.body.replyWindowClosesAt).getTime();
    expect(cierre - (conversation.lastInboundAt?.getTime() ?? 0)).toBe(24 * 60 * 60 * 1000);
    expect(res.body.replyMaxChars).toBe(1000);
    await closeConversations();
  });

  it('el camino de entrada anota la marca de tiempo DE META, no la nuestra', async () => {
    // Es contra ella contra la que se mide la ventana. Guardar la nuestra
    // dejaría la ventana abierta más de lo que Meta la considera abierta.
    const hace3h = Date.now() - 3 * 60 * 60 * 1000;
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola', { sentAtMs: hace3h });

    const conversation = await currentConversation();
    expect(conversation.lastInboundAt?.getTime()).toBe(hace3h);
    // Y la cuenta por la que entró, que es lo que permite contestar después.
    expect(conversation.channelAccountId).toBe(accountId);
    await closeConversations();
  });
});

describe('el bot no habla encima de la persona', () => {
  it('deja de contestar en cuanto el comerciante toma la conversación', async () => {
    scripted = [textResponse('Te ayudo con eso.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Sigo yo desde aquí.' });

    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe('human');

    sent = [];
    modelCalls = 0;
    // El comprador vuelve a escribir. Sin respuesta guionizada a propósito: si
    // el bucle llamara al modelo, el cliente falso lanzaría.
    await shopperWrites('¿y en talla M?');

    expect(modelCalls).toBe(0);
    expect(sent).toHaveLength(0);
    await closeConversations();
  });

  it('pero SÍ guarda lo que el comprador escribe mientras lo atiende una persona', async () => {
    // La mitad importante: el comerciante está mirando el panel. Si lo que
    // acaba de llegar no se guardara, la conversación se le quedaría muda justo
    // mientras la atiende.
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Cuéntame.' });

    await shopperWrites('quiero la roja, talla M');

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${conversation.id}`)
      .set('cookie', cookie);
    const contenidos = res.body.messages.map((m: { content: string }) => m.content);
    expect(contenidos).toContain('quiero la roja, talla M');
    await closeConversations();
  });

  it('devolverla al asistente lo vuelve a poner a contestar', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Ya te resolví eso.' });

    const devuelta = await request(app.getHttpServer())
      .patch(`/v1/admin/conversations/${conversation.id}/handback`)
      .set('cookie', cookie);
    expect(devuelta.status).toBe(200);
    expect(devuelta.body.status).toBe('open');

    scripted = [textResponse('Sigo yo, el asistente.')];
    sent = [];
    await shopperWrites('otra cosa');

    expect(modelCalls).toBeGreaterThan(0);
    expect(sentBodies().join('\n')).toContain('Sigo yo, el asistente.');
    await closeConversations();
  });

  it('y al volver, el agente VUELVE a revelar que es automatizado', async () => {
    // El comprador acaba de hablar con una persona y cree que sigue hablando
    // con ella. Ninguna ventana de tiempo detecta eso: lo que cambió no es que
    // pasara tiempo, es quién contesta.
    scripted = [textResponse('Primera del agente.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Hola, soy Marcela del equipo.' });
    await request(app.getHttpServer())
      .patch(`/v1/admin/conversations/${conversation.id}/handback`)
      .set('cookie', cookie);

    scripted = [textResponse('Claro que sí.')];
    sent = [];
    await shopperWrites('¿me lo envían hoy?');

    const ultimoDelAgente = await prisma.message.findFirstOrThrow({
      where: { conversationId: conversation.id, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
    });
    expect(ultimoDelAgente.content).toContain('asistente virtual');
    expect(ultimoDelAgente.content).toMatch(/autom[áa]ti/i);
    expect(ultimoDelAgente.content).toContain('Claro que sí.');
    await closeConversations();
  });

  it('sin traspaso humano de por medio, el agente NO repite la revelación', async () => {
    // El control de la prueba anterior: lo que dispara la revelación es que
    // hablara una persona, no el simple hecho de haber más de un turno.
    scripted = [textResponse('Primera.'), textResponse('Segunda.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    await shopperWrites('¿y el envío?');

    const mensajes = await prisma.message.findMany({
      where: { conversationId: conversation.id, role: 'assistant' },
      orderBy: { createdAt: 'asc' },
    });
    expect(mensajes[0].content).toContain('asistente virtual');
    expect(mensajes[1].content).toBe('Segunda.');
    await closeConversations();
  });
});

describe('la lista y el detalle sirven para sondear', () => {
  it('la lista dice cuándo y de quién fue lo último dicho', async () => {
    scripted = [textResponse('Ahí va.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    const res = await request(app.getHttpServer()).get('/v1/admin/conversations').set('cookie', cookie);
    const fila = res.body.items.find((c: { id: string }) => c.id === conversation.id);

    // Sin `lastMessageAt` el panel tendría que comparar textos para saber si
    // llegó algo nuevo — y dos mensajes iguales seguidos son normales.
    expect(typeof fila.lastMessageAt).toBe('string');
    expect(fila.lastMessageRole).toBe('assistant');
    await closeConversations();
  });

  it('una conversación atendida por una persona se puede filtrar', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'La atiendo yo.' });

    const res = await request(app.getHttpServer())
      .get('/v1/admin/conversations?status=human')
      .set('cookie', cookie);

    expect(res.body.items.map((c: { id: string }) => c.id)).toContain(conversation.id);
    expect(res.body.items.every((c: { status: string }) => c.status === 'human')).toBe(true);
    await closeConversations();
  });

  it('atender saca la conversación de «necesitan atención»', async () => {
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: 'escalated' } });

    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Ya estoy contigo.' });

    const res = await request(app.getHttpServer())
      .get('/v1/admin/conversations?status=escalated')
      .set('cookie', cookie);
    expect(res.body.items.map((c: { id: string }) => c.id)).not.toContain(conversation.id);
    await closeConversations();
  });
});

describe('canales sin cuenta conectada', () => {
  it('una conversación del widget web se puede contestar sin llamar a ningún proveedor', async () => {
    const web = await prisma.conversation.create({
      data: { tenantId, channel: 'web', status: 'escalated', shopperRef: null },
    });
    await prisma.message.create({
      data: { tenantId, conversationId: web.id, role: 'user', content: 'me pueden llamar?' },
    });
    sent = [];

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${web.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Claro, te escribo por aquí mismo.' });

    expect(res.status).toBe(201);
    expect(sent).toHaveLength(0);
    const guardado = await prisma.message.findFirstOrThrow({ where: { conversationId: web.id, role: 'human' } });
    expect(guardado.content).toBe('Claro, te escribo por aquí mismo.');
  });

  it('una tienda sin Instagram conectado no puede contestar por Instagram', async () => {
    // El otro inquilino tiene el canal en el plan pero ninguna cuenta: el panel
    // tiene que decirlo, no fallar al enviar.
    const huerfana = await prisma.conversation.create({
      data: {
        tenantId: otherTenantId,
        channel: 'instagram',
        status: 'open',
        shopperRef: '6199999999999999',
        lastInboundAt: new Date(),
      },
    });

    const detalle = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${huerfana.id}`)
      .set('cookie', otherCookie);
    expect(detalle.body.canReply).toBe(false);
    expect(detalle.body.replyBlockedReason).toBe('CHANNEL_NOT_CONNECTED');

    sent = [];
    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${huerfana.id}/reply`)
      .set('cookie', otherCookie)
      .send({ text: 'hola' });
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('una tienda cuyo plan ya no incluye el canal tampoco', async () => {
    await prisma.tenantLimits.update({ where: { tenantId: otherTenantId }, data: { instagramChannel: false } });
    const conversacion = await prisma.conversation.create({
      data: {
        tenantId: otherTenantId,
        channel: 'instagram',
        status: 'open',
        shopperRef: '6188888888888888',
        lastInboundAt: new Date(),
      },
    });

    const detalle = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${conversacion.id}`)
      .set('cookie', otherCookie);
    expect(detalle.body.canReply).toBe(false);
    expect(detalle.body.replyBlockedReason).toBe('CHANNEL_NOT_IN_PLAN');

    await prisma.tenantLimits.update({ where: { tenantId: otherTenantId }, data: { instagramChannel: true } });
  });
});


describe('GET /v1/storefront/agent/conversations/:id/replies — que el widget se entere', () => {
  /**
   * La entrega que le falta al canal web.
   *
   * Instagram y WhatsApp llevan una respuesta humana al teléfono del comprador
   * por su cuenta. El widget no: solo abre un stream mientras dura un turno. Sin
   * esto, contestar a una conversación del chat de la tienda sería un botón que
   * no le llega a nadie — un fallo silencioso, que es lo peor que le puede pasar
   * a una función de atención.
   */
  async function conversacionWeb() {
    const conversation = await prisma.conversation.create({
      data: { tenantId, channel: 'web', status: 'open', shopperRef: null },
    });
    await prisma.message.create({
      data: { tenantId, conversationId: conversation.id, role: 'user', content: '¿me lo envían hoy?' },
    });
    return conversation;
  }

  it('le entrega al comprador lo que escribió la persona', async () => {
    const conversation = await conversacionWeb();
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Sí, sale hoy mismo. — Marcela' });

    const res = await request(app.getHttpServer())
      .get(`/v1/storefront/agent/conversations/${conversation.id}/replies`)
      .set('Host', storefrontDomain);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('human');
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      'Sí, sale hoy mismo. — Marcela',
    ]);
  });

  it('solo devuelve lo que escribió la PERSONA, no lo del asistente', async () => {
    // Los mensajes del agente ya llegan por el stream del turno; repetirlos
    // aquí obligaría al widget a deduplicar dos fuentes de lo mismo.
    const conversation = await conversacionWeb();
    await prisma.message.create({
      data: { tenantId, conversationId: conversation.id, role: 'assistant', content: 'Soy el asistente.' },
    });
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'Y yo una persona.' });

    const res = await request(app.getHttpServer())
      .get(`/v1/storefront/agent/conversations/${conversation.id}/replies`)
      .set('Host', storefrontDomain);

    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].content).toBe('Y yo una persona.');
  });

  it('`after` evita repetir lo que el widget ya pintó', async () => {
    const conversation = await conversacionWeb();
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'primera' });

    const primera = await request(app.getHttpServer())
      .get(`/v1/storefront/agent/conversations/${conversation.id}/replies`)
      .set('Host', storefrontDomain);
    const corte = primera.body.messages[0].createdAt;

    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'segunda' });

    const segunda = await request(app.getHttpServer())
      .get(`/v1/storefront/agent/conversations/${conversation.id}/replies?after=${encodeURIComponent(corte)}`)
      .set('Host', storefrontDomain);

    expect(segunda.body.messages.map((m: { content: string }) => m.content)).toEqual(['segunda']);
  });

  it('un `after` ilegible devuelve todo en vez de nada', async () => {
    // El peor caso aceptable de un sondeo es repetir un mensaje; quedarse sin
    // él no lo es.
    const conversation = await conversacionWeb();
    await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversation.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'igual llega' });

    const res = await request(app.getHttpServer())
      .get(`/v1/storefront/agent/conversations/${conversation.id}/replies?after=mañana`)
      .set('Host', storefrontDomain);

    expect(res.body.messages).toHaveLength(1);
  });

  it('NUNCA deja leer una conversación de Instagram por esta vía', async () => {
    // Un id de conversación de Instagram lo tiene a la vista el comerciante en
    // su panel; que sirviera para leer ese hilo desde fuera convertiría una
    // captura de pantalla en una fuga.
    scripted = [textResponse('Hola.')];
    await shopperWrites('hola');
    const conversation = await currentConversation();

    const res = await request(app.getHttpServer())
      .get(`/v1/storefront/agent/conversations/${conversation.id}/replies`)
      .set('Host', storefrontDomain);

    expect(res.status).toBe(404);
    await closeConversations();
  });

  it('404 para la conversación de otra tienda y para un id mal formado', async () => {
    const ajena = await prisma.conversation.create({
      data: { tenantId: otherTenantId, channel: 'web', status: 'open' },
    });

    const deOtro = await request(app.getHttpServer())
      .get(`/v1/storefront/agent/conversations/${ajena.id}/replies`)
      .set('Host', storefrontDomain);
    expect(deOtro.status).toBe(404);

    const malFormado = await request(app.getHttpServer())
      .get('/v1/storefront/agent/conversations/no-es-un-uuid/replies')
      .set('Host', storefrontDomain);
    expect(malFormado.status).toBe(404);
  });
});


describe('con DOS cuentas de Instagram conectadas', () => {
  /**
   * El caso por el que existe `Conversation.channelAccountId`.
   *
   * Un IGSID identifica a una persona FRENTE A UNA CUENTA: el mismo comprador
   * tiene ids distintos ante dos cuentas de la misma tienda, y enviar por la
   * equivocada es —en el mejor caso— un rechazo de Meta. Con una sola cuenta
   * conectada la ambigüedad no existe y no hace falta nada de esto; con dos, no
   * se puede adivinar.
   */
  const SEGUNDA_IG = '17841400000000002';
  let segundaCuentaId: string;

  beforeAll(async () => {
    const cuenta = await accounts.connect({
      tenantId,
      provider: 'graph',
      igAccountId: SEGUNDA_IG,
      pageId: '102290129340399',
      username: 'mitienda-outlet',
      credentials: { token: 'page-token-2', appSecret: APP_SECRET, verifyToken: 'verificame-2' },
    });
    segundaCuentaId = cuenta.id;
  });

  afterAll(async () => {
    await accounts.deleteForTenant(tenantId, segundaCuentaId);
  });

  it('contesta por LA CUENTA por la que entró la conversación', async () => {
    const conversacion = await prisma.conversation.create({
      data: {
        tenantId,
        channel: 'instagram',
        status: 'open',
        shopperRef: '6177777777777777',
        lastInboundAt: new Date(),
        channelAccountId: segundaCuentaId,
      },
    });
    sent = [];

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversacion.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'desde la cuenta correcta' });

    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    // La Graph API enruta por el id de la cuenta que va en la URL: si se
    // resolviera la otra, este mensaje le llegaría a otra persona o a nadie.
    expect(sent[0].url).toContain(SEGUNDA_IG);
    expect(sent[0].url).not.toContain(IG_ACCOUNT_ID);
  });

  it('se niega, en vez de sortear, cuando la conversación no dice por cuál entró', async () => {
    // Conversaciones anteriores a la columna. Elegir una al azar sería mandarle
    // el mensaje de un cliente a la cuenta equivocada en silencio.
    const antigua = await prisma.conversation.create({
      data: {
        tenantId,
        channel: 'instagram',
        status: 'open',
        shopperRef: '6166666666666666',
        lastInboundAt: new Date(),
        channelAccountId: null,
      },
    });
    sent = [];

    const detalle = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${antigua.id}`)
      .set('cookie', cookie);
    expect(detalle.body.canReply).toBe(false);
    expect(detalle.body.replyBlockedReason).toBe('CHANNEL_NOT_CONNECTED');

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${antigua.id}/reply`)
      .set('cookie', cookie)
      .send({ text: 'no debería salir por ninguna' });
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('nunca envía con las credenciales de la cuenta de otra tienda', async () => {
    // `channelAccountId` viene de una fila que el comerciante puede ver; que
    // apunte fuera de su tienda no puede convertirse en un envío.
    const cuentaAjena = await prisma.instagramAccount.findFirstOrThrow({ where: { tenantId } });
    const conversacionAjena = await prisma.conversation.create({
      data: {
        tenantId: otherTenantId,
        channel: 'instagram',
        status: 'open',
        shopperRef: '6155555555555555',
        lastInboundAt: new Date(),
        channelAccountId: cuentaAjena.id,
      },
    });
    sent = [];

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/conversations/${conversacionAjena.id}/reply`)
      .set('cookie', otherCookie)
      .send({ text: 'con credenciales que no son mías' });

    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});
