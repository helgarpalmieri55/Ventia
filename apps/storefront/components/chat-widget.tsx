'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@ventia/ui';
import { formatCOP } from '../lib/format';
import { ProductImage } from './product-image';
import {
  cartLinkFromTool,
  fetchHumanReplies,
  productsFromTool,
  streamAgentMessage,
  type AgentProduct,
  type CartLinkData,
} from '../lib/agent-api';

/**
 * The storefront's AI sales agent (docs/SPEC.md §7): a floating launcher and
 * the chat panel it opens.
 *
 * Mounted once in `app/layout.tsx`, beside `CartDrawer`, which is what puts it
 * on every page.
 *
 * ## What it renders from tool results rather than from prose
 *
 * SPEC §7 asks for "product cards rendered from tool results". That is not a
 * cosmetic preference: the model is instructed never to invent a price, and
 * rendering the number the TOOL returned — rather than parsing one out of the
 * model's sentence — means a shopper cannot be shown a hallucinated price even
 * if the instruction fails. Same for the cart link: the button below opens the
 * URL `create_cart_link` returned, never one assembled from text.
 *
 * ## The conversation id lives in sessionStorage
 *
 * So a shopper who navigates from the PDP to the cart keeps their
 * conversation, and one who closes the tab starts fresh. `localStorage` would
 * resurrect a week-old conversation on a shared machine, which is both odd and
 * a small privacy problem; a cookie would be sent on every request to no
 * purpose. The id is not a secret — the server re-checks it against the
 * request's own tenant on every turn (agent.service.ts), so a copied id from
 * another store yields a new conversation rather than someone's transcript.
 */

const STORAGE_KEY = 'ventia_agent_conversation';
const NETWORK_ERROR = 'No pude responderte en este momento. Intenta de nuevo.';

/**
 * Cada cuánto se pregunta si alguien de la tienda escribió.
 *
 * Solo mientras el panel está abierto. Cinco segundos es lo mismo que sondea el
 * panel del comerciante: por debajo nadie nota la diferencia, y por encima una
 * respuesta escrita a mano tarda lo bastante como para que el comprador crea
 * que no le contestaron.
 */
const INTERVALO_RESPUESTAS_MS = 5000;

interface ChatMessage {
  /** `equipo` es una persona de la tienda escribiendo desde el panel. Es un
   * rol propio y no `agent` a propósito: quien escribe no es el asistente, y
   * pintarlo igual haría que el comprador creyera lo contrario. */
  role: 'user' | 'agent' | 'equipo';
  text: string;
  products: AgentProduct[];
  cartLink: CartLinkData | null;
}

function emptyAgentMessage(): ChatMessage {
  return { role: 'agent', text: '', products: [], cartLink: null };
}

export function ChatWidget({ agentName = 'Asesor' }: { agentName?: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** La marca del último mensaje de una persona que ya se pintó, para pedir
   * solo lo siguiente y no repetir nada. */
  const ultimaRespuestaHumana = useRef<string | null>(null);
  /** Si una persona de la tienda está atendiendo esta conversación. */
  const [atendidaPorPersona, setAtendidaPorPersona] = useState(false);

  useEffect(() => {
    conversationId.current = sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  }, []);

  /**
   * El sondeo de respuestas humanas.
   *
   * Los otros dos canales del producto no lo necesitan: una respuesta escrita
   * desde el panel sale por la Graph API y le llega al comprador al teléfono.
   * Este widget no tiene entrega propia —solo abre un stream mientras dura un
   * turno—, así que sin esto el comerciante contestaría y el comprador no
   * recibiría nunca nada.
   *
   * Solo mientras el panel está abierto y solo si ya hay conversación: un
   * lanzador cerrado en una pestaña de fondo no tiene por qué pedir nada.
   */
  useEffect(() => {
    if (!open) return;

    let vivo = true;
    const sondear = async () => {
      const id = conversationId.current;
      if (!id) return;
      const respuesta = await fetchHumanReplies(id, ultimaRespuestaHumana.current);
      if (!vivo || !respuesta) return;

      setAtendidaPorPersona(respuesta.status === 'human');
      if (respuesta.messages.length === 0) return;
      ultimaRespuestaHumana.current = respuesta.messages[respuesta.messages.length - 1].createdAt;
      setMessages((prev) => [
        ...prev,
        ...respuesta.messages.map((m) => ({
          role: 'equipo' as const,
          text: m.content,
          products: [],
          cartLink: null,
        })),
      ]);
    };

    void sondear();
    const timer = setInterval(() => void sondear(), INTERVALO_RESPUESTAS_MS);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [open]);

  // Keeps the newest message in view as the answer streams in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;

    setDraft('');
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: message, products: [], cartLink: null },
      emptyAgentMessage(),
    ]);

    /** Rewrites the in-progress agent message — the last entry, appended
     * above — as each event lands. */
    const updateLast = (patch: (msg: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((msg, i) => (i === prev.length - 1 ? patch(msg) : msg)));

    try {
      for await (const event of streamAgentMessage({ message, conversationId: conversationId.current })) {
        if (event.type === 'conversation') {
          conversationId.current = event.conversationId;
          sessionStorage.setItem(STORAGE_KEY, event.conversationId);
        } else if (event.type === 'tool') {
          const products = productsFromTool(event.name, event.result);
          const cartLink = cartLinkFromTool(event.name, event.result);
          updateLast((msg) => ({
            ...msg,
            products: products.length > 0 ? products : msg.products,
            cartLink: cartLink ?? msg.cartLink,
          }));
        } else if (event.type === 'message') {
          updateLast((msg) => ({ ...msg, text: event.text }));
        } else if (event.type === 'error') {
          updateLast((msg) => ({ ...msg, text: event.message }));
        } else if (event.type === 'done' && event.silenced) {
          // El asistente calló porque una persona está atendiendo esta
          // conversación. La burbuja vacía que se añadió al enviar se quita —
          // dejarla ahí sería un hueco esperando una respuesta que no va a
          // llegar por esa vía— y en su lugar se dice quién va a contestar.
          setAtendidaPorPersona(true);
          setMessages((prev) => prev.filter((msg, i) => i !== prev.length - 1 || msg.text.length > 0));
        }
        // Por lo demás `done` no trae nada que los eventos de arriba no hayan
        // entregado ya; existe para que quien se reconecte a mitad de turno
        // tenga un marco terminal que buscar.
      }
    } catch (err) {
      console.error('[agent] stream failed', err);
      updateLast((msg) => ({ ...msg, text: msg.text || NETWORK_ERROR }));
    } finally {
      setSending(false);
    }
  }, [draft, sending]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={open ? 'Cerrar chat' : `Chatear con ${agentName}`}
        aria-expanded={open}
        className="fixed bottom-4 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <span aria-hidden="true">{open ? '✕' : '💬'}</span>
      </button>

      {open ? (
        // Not the shared `Dialog`: that one is modal and traps focus, which is
        // right for the cart drawer and wrong here — a shopper should be able
        // to keep browsing the catalogue while the agent answers.
        <section
          aria-label={`Chat con ${agentName}`}
          className="fixed bottom-20 right-4 z-40 flex h-[28rem] w-[min(22rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-background shadow-xl"
        >
          <header className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{agentName}</h2>
            <p className="text-xs text-muted-foreground">Te ayudo a encontrar lo que buscas</p>
          </header>

          <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Hola 👋 Pregúntame por productos, envíos o el estado de tu pedido.
              </p>
            ) : null}

            {messages.map((msg, i) => (
              <ChatBubble key={i} message={msg} pending={sending && i === messages.length - 1} />
            ))}

            {atendidaPorPersona ? (
              // Decírselo al comprador, y no dejar que lo deduzca de un
              // silencio. Es también lo que la política de Meta busca en el
              // otro sentido: quien habla con una persona tiene que saberlo,
              // igual que quien habla con una máquina.
              <p className="self-center text-xs text-muted-foreground">
                Te está respondiendo una persona del equipo.
              </p>
            ) : null}
          </div>

          <form
            className="flex gap-2 border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              // `maxLength` mirrors the server's own bound (agentMessageInput
              // in @ventia/core) so an over-long message is stopped where the
              // shopper can see it happening, rather than as a 400 after send.
              maxLength={2000}
              aria-label="Escribe tu mensaje"
              placeholder="Escribe tu mensaje…"
              className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm"
            />
            <Button type="submit" size="sm" disabled={sending || draft.trim().length === 0}>
              Enviar
            </Button>
          </form>
        </section>
      ) : null}
    </>
  );
}

function ChatBubble({ message, pending }: { message: ChatMessage; pending: boolean }) {
  if (message.role === 'user') {
    return (
      <p className="self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{message.text}</p>
    );
  }

  if (message.role === 'equipo') {
    // Una burbuja distinta de la del asistente, con su etiqueta: el comprador
    // tiene que poder ver que ahora le contesta alguien del equipo.
    return (
      <div className="flex flex-col gap-0.5 self-start rounded-lg border border-primary bg-background px-3 py-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Equipo de la tienda</span>
        <p className="whitespace-pre-wrap text-sm">{message.text}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 self-start">
      {message.text ? (
        <p className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">{message.text}</p>
      ) : pending ? (
        <span className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <Spinner /> Pensando…
        </span>
      ) : null}

      {message.products.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {message.products.map((product) => (
            <li key={product.product_id}>
              <a
                href={product.url}
                className="flex items-center gap-3 rounded-md border border-border p-2 hover:bg-muted"
              >
                {/* Same box, same crop, same no-photo mark as the grid and
                    the PDP (components/product-image.tsx) — a suggestion from
                    the agent should look like the store it is selling. Always
                    rendered, unlike before: the agent's tool result says
                    outright whether the product has a photo, so a placeholder
                    here is a fact about the product, not a gap in what we
                    fetched. */}
                <ProductImage src={product.thumbnail_url} alt="" className="w-12 shrink-0 rounded-md" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{product.name}</span>
                  {/* The price comes from the TOOL result, never from the
                      model's prose — see this file's header. */}
                  <span className="text-sm">{formatCOP(product.price_cents)}</span>
                  {!product.in_stock ? <span className="text-xs text-muted-foreground">Agotado</span> : null}
                  {product.reason ? (
                    <span className="text-xs text-muted-foreground">{product.reason}</span>
                  ) : null}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {message.cartLink ? (
        <Button href={message.cartLink.cart_url} size="sm">
          Abrir carrito ({message.cartLink.item_count}) · {formatCOP(message.cartLink.subtotal_cents)}
        </Button>
      ) : null}
    </div>
  );
}
