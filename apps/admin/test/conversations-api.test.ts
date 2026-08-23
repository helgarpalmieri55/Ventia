import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import {
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
  handBackConversation,
  listConversations,
  replyToConversation,
  type ConversationStatus,
} from '../lib/conversations-api';

/**
 * El cliente de la bandeja de atención.
 *
 * Lo que se fija aquí es el CABLE: qué se manda y con qué forma. En particular
 * que la respuesta del comerciante viaja tal cual, sin que este cliente le
 * añada nada por el camino — que es la mitad de «una respuesta humana no lleva
 * la revelación» que puede romperse en el navegador y no en el servidor.
 */

function okJson(body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('replyToConversation', () => {
  it('manda el texto del comerciante TAL CUAL', async () => {
    const fetchMock = okJson({ id: 'c1', status: 'human', message: {} });
    vi.stubGlobal('fetch', fetchMock);

    const texto = 'Hola Ana, soy Marcela. Te aparto la M hasta mañana.';
    await replyToConversation('c1', texto);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/conversations/c1/reply');
    expect(init.method).toBe('POST');
    // Sin prefijo, sin firma, sin revelación de automatización: lo que se
    // teclea es lo que sale.
    expect(JSON.parse(String(init.body))).toEqual({ text: texto });
  });
});

describe('handBackConversation', () => {
  it('devuelve la conversación al asistente con un PATCH', async () => {
    const fetchMock = okJson({ id: 'c1', status: 'open' });
    vi.stubGlobal('fetch', fetchMock);

    const res = await handBackConversation('c1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/conversations/c1/handback');
    expect(init.method).toBe('PATCH');
    expect(res.status).toBe('open');
  });
});

describe('listConversations', () => {
  it('el filtro «todas» no manda ningún estado', async () => {
    const fetchMock = okJson({ items: [], total: 0, page: 1, pageSize: 30, escalatedCount: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await listConversations('todas', 1);

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/v1/admin/conversations?page=1');
  });

  it('el filtro nuevo de atención humana viaja como estado', async () => {
    const fetchMock = okJson({ items: [], total: 0, page: 2, pageSize: 30, escalatedCount: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await listConversations('human', 2);

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      '/api/v1/admin/conversations?page=2&status=human',
    );
  });
});

describe('los estados que el panel sabe pintar', () => {
  it('los cuatro tienen etiqueta y color', () => {
    // Un estado sin entrada aquí se pintaría como `undefined` en la tabla.
    const estados: ConversationStatus[] = ['open', 'escalated', 'human', 'resolved'];
    for (const estado of estados) {
      expect(STATUS_LABEL[estado]).toBeTruthy();
      expect(STATUS_BADGE_VARIANT[estado]).toBeTruthy();
    }
  });

  it('«la atiendes tú» no compite por la atención con «necesita atención»', () => {
    // Una conversación que ya estás atendiendo no reclama tu atención: ya la
    // tiene. El color que llama es solo para lo que sigue sin contestar.
    expect(STATUS_BADGE_VARIANT.escalated).toBe('default');
    expect(STATUS_BADGE_VARIANT.human).not.toBe('default');
  });
});

describe('los errores del envío se explican en español', () => {
  it('cada motivo de bloqueo tiene su texto, sin caer en el genérico', async () => {
    const generico = errorMessage(new ApiError(500, 'UNKNOWN'));
    for (const code of [
      'MESSAGING_WINDOW_CLOSED',
      'CHANNEL_NOT_CONNECTED',
      'CHANNEL_NOT_IN_PLAN',
      'SHOPPER_UNREACHABLE',
      'REPLY_NOT_DELIVERED',
      'CONVERSATION_NOT_FOUND',
    ]) {
      expect(errorMessage(new ApiError(409, code))).not.toBe(generico);
    }
  });

  it('un envío que no salió lo dice sin rodeos', async () => {
    // El comerciante tiene que saber que ese cliente SIGUE sin respuesta; un
    // «algo salió mal» le dejaría creer que ya está contestado.
    const texto = errorMessage(new ApiError(502, 'REPLY_NOT_DELIVERED'));
    expect(texto).toContain('todavía no la recibió');
  });
});
