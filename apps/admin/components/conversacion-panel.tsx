'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Spinner } from '@ventia/ui';
import { ApiError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import {
  CHANNEL_LABEL,
  getConversation,
  handBackConversation,
  replyToConversation,
  resolveConversation,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
  type ConversationDetail,
} from '../lib/conversations-api';
import {
  AUTOR_MENSAJE,
  INTERVALO_DETALLE_MS,
  avisoVentana,
  estaAlFondo,
  estadoCompositor,
  estiloDeMensaje,
  mensajesNuevos,
} from '../lib/conversations-live';

/**
 * Una conversación abierta: el transcripto en vivo y el sitio desde el que una
 * persona contesta.
 *
 * Hasta ahora este panel solo leía, y leer no es atender: `escalate_to_human`
 * le prometía al cliente «te paso con una persona» y esa persona no tenía por
 * dónde escribir. Aquí está esa mitad.
 *
 * ## Lo que este componente cuida y no se ve en el diff
 *
 *  - **No parpadea.** El transcripto anterior se queda en pantalla mientras
 *    llega el siguiente sondeo; el `Spinner` solo aparece en la primera carga.
 *    Un panel que se vacía y se rellena cada tres segundos es inusable, y en un
 *    vídeo se ve fatal.
 *  - **No arrastra el scroll.** Solo baja solo si el comerciante ya estaba
 *    mirando el final. Si subió a releer algo —que es lo que uno hace justo
 *    antes de contestar—, la vista se queda donde la dejó.
 *  - **No pierde lo que estás escribiendo.** El borrador vive en este
 *    componente y ningún sondeo lo toca.
 */
export function ConversacionPanel({
  conversationId,
  onClose,
  onChanged,
}: {
  conversationId: string;
  onClose: () => void;
  /** Se llama cuando cambia algo que la lista de atrás debería reflejar (una
   * respuesta enviada, un traspaso, una conversación cerrada). */
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const [nuevos, setNuevos] = useState<Set<string>>(new Set());

  const listRef = useRef<HTMLUListElement>(null);
  /**
   * Si el comerciante estaba mirando el final la última vez que MOVIÓ el
   * scroll.
   *
   * Se actualiza en el evento `scroll` y no midiendo la caja después de pintar,
   * que es la trampa evidente y está mal: para cuando corre un efecto de
   * layout, el DOM ya tiene el mensaje nuevo y la caja ya creció, así que la
   * medida diría «no estás abajo» justo en el caso en que sí lo estabas. Este
   * valor solo cambia cuando lo cambia una persona.
   */
  const seguirAlFondo = useRef(true);

  /**
   * Una pasada de sondeo.
   *
   * `silencioso` distingue la primera carga (que sí puede mostrar un estado de
   * carga y sí puede fallar ruidosamente) de las siguientes: un corte de red de
   * dos segundos no puede borrar de la pantalla la conversación que el
   * comerciante está leyendo ni pintarle un error rojo por un sondeo que el
   * siguiente va a arreglar solo.
   */
  const cargar = useCallback(
    async (silencioso: boolean) => {
      try {
        const resultado = await getConversation(conversationId);
        setDetail((previo) => {
          if (previo) setNuevos(mensajesNuevos(previo.messages, resultado.messages));
          return resultado;
        });
        setError(null);
      } catch (e) {
        if (silencioso) return;
        setError(e instanceof ApiError ? errorMessage(e) : 'No pudimos abrir la conversación.');
      }
    },
    [conversationId],
  );

  useEffect(() => {
    // Estado limpio al cambiar de conversación: el borrador de una no puede
    // acabar enviándose en otra.
    setDetail(null);
    setDraft('');
    setNuevos(new Set());
    seguirAlFondo.current = true;

    let vivo = true;
    void cargar(false);
    const id = setInterval(() => {
      // Sin pestaña visible no se sondea: un panel abierto en una pestaña de
      // fondo durante horas no tiene por qué costarle consultas a nadie, y al
      // volver el primer sondeo trae el estado completo igual.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (vivo) void cargar(true);
    }, INTERVALO_DETALLE_MS);

    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [cargar]);

  // Se baja solo, y solo si el comerciante ya estaba mirando el final.
  // `useLayoutEffect` y no `useEffect`: se ajusta en el mismo cuadro en que se
  // pintó el mensaje, así que no hay un salto visible.
  useLayoutEffect(() => {
    const caja = listRef.current;
    if (caja && seguirAlFondo.current) caja.scrollTop = caja.scrollHeight;
  }, [detail?.messages.length]);

  async function enviar() {
    const texto = draft.trim();
    if (!texto || sending) return;
    setSending(true);
    setError(null);
    try {
      await replyToConversation(conversationId, texto);
      setDraft('');
      seguirAlFondo.current = true;
      await cargar(true);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'No pudimos enviar tu respuesta.');
      // El borrador NO se borra: el comerciante acaba de escribirlo y puede
      // reintentar sin volver a teclearlo.
    } finally {
      setSending(false);
    }
  }

  async function accion(fn: () => Promise<unknown>, cerrar: boolean) {
    setWorking(true);
    setError(null);
    try {
      await fn();
      onChanged();
      if (cerrar) onClose();
      else await cargar(true);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'No pudimos completar la acción.');
    } finally {
      setWorking(false);
    }
  }

  const compositor = detail ? estadoCompositor(detail) : null;
  const aviso = detail ? avisoVentana(detail.replyWindowClosesAt) : null;

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4" aria-label="Conversación">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{detail?.shopperRef ?? 'Cliente sin datos de contacto'}</h3>
          {detail ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={STATUS_BADGE_VARIANT[detail.status]}>{STATUS_LABEL[detail.status]}</Badge>
              <span>{CHANNEL_LABEL[detail.channel] ?? detail.channel}</span>
            </div>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {!detail ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Cargando…
        </p>
      ) : (
        <>
          {detail.status === 'human' ? (
            // Decirlo, y no dejar que se deduzca de un badge: el comerciante
            // tiene que saber que a partir de ahora el cliente le habla A ÉL.
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Estás atendiendo esta conversación. Mientras tanto el asistente no responde.
            </p>
          ) : null}

          <ul
            ref={listRef}
            onScroll={(e) => {
              seguirAlFondo.current = estaAlFondo(e.currentTarget);
            }}
            className="flex max-h-80 flex-col gap-2 overflow-y-auto"
            aria-live="polite"
            aria-relevant="additions"
          >
            {detail.messages.map((message) => {
              const estilo = estiloDeMensaje(message.role);
              const esNuevo = nuevos.has(message.id);
              return (
                <li
                  key={message.id}
                  className={[
                    'flex max-w-[85%] flex-col gap-0.5 rounded-lg px-3 py-2 text-sm',
                    estilo === 'cliente' ? 'self-start bg-muted' : 'self-end',
                    // El agente y la persona se distinguen por color: quién dijo
                    // qué es exactamente lo que este transcripto existe para
                    // contar.
                    estilo === 'agente' ? 'bg-primary text-primary-foreground' : '',
                    estilo === 'equipo' ? 'border border-primary bg-background text-foreground' : '',
                    // Que se NOTE que acaba de llegar, sin animación que
                    // distraiga en una grabación.
                    esNuevo ? 'ring-2 ring-primary/60' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span
                    className={[
                      'text-[10px] uppercase tracking-wide',
                      estilo === 'agente' ? 'text-primary-foreground/70' : 'text-muted-foreground',
                    ].join(' ')}
                  >
                    {AUTOR_MENSAJE[estilo]}
                  </span>
                  <span className="whitespace-pre-wrap">{message.content}</span>
                </li>
              );
            })}
          </ul>

          {aviso ? <p className="text-xs text-muted-foreground">{aviso}</p> : null}

          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void enviar();
            }}
          >
            <label className="sr-only" htmlFor="respuesta-humana">
              Escribe tu respuesta
            </label>
            <textarea
              id="respuesta-humana"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!compositor?.habilitado || sending}
              maxLength={compositor?.maxChars}
              placeholder={
                compositor?.habilitado ? 'Escribe tu respuesta al cliente…' : 'No puedes responder ahora mismo'
              }
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {compositor && !compositor.habilitado && compositor.aviso ? (
              <Alert variant="warning">{compositor.aviso}</Alert>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {draft.length}/{compositor?.maxChars ?? 0}
              </span>
              <div className="flex flex-wrap gap-2">
                {detail.status === 'human' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={working}
                    onClick={() => void accion(() => handBackConversation(conversationId), false)}
                  >
                    Devolver al asistente
                  </Button>
                ) : null}
                {detail.status !== 'resolved' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={working}
                    onClick={() => void accion(() => resolveConversation(conversationId), true)}
                  >
                    Marcar como atendida
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  disabled={!compositor?.habilitado || sending || draft.trim().length === 0}
                >
                  {sending ? 'Enviando…' : 'Responder'}
                </Button>
              </div>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
