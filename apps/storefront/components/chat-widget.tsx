'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@ventia/ui';
import { formatCOP } from '../lib/format';
import {
  cartLinkFromTool,
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

interface ChatMessage {
  role: 'user' | 'agent';
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

  useEffect(() => {
    conversationId.current = sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  }, []);

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
        }
        // `done` carries no information the events above have not already
        // delivered; it exists so a caller that reconnects mid-turn has one
        // terminal frame to look for.
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
                {/* Plain <img>, not next/image: these URLs come from the
                    tenant's own object storage at runtime and next/image would
                    need each host allow-listed at build time. */}
                {product.thumbnail_url ? (
                  <img src={product.thumbnail_url} alt="" className="h-12 w-12 rounded object-cover" />
                ) : null}
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
