'use client';

import { useState } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { ApiError } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { askAssistant, TOOL_LABELS, type AssistantAnswer } from '../../../lib/assistant-api';

/**
 * "Asistente" — the merchant asks about their own business and gets an answer
 * grounded in their own numbers (`POST /v1/admin/ai/command`).
 *
 * Deliberately modest: one box, one answer. The endpoint is the deliverable
 * and the interesting decisions all live server-side. Two things this page
 * does carry, because nothing else in the product can:
 *
 *  1. **What the question cost.** The assistant and the storefront's sales
 *     agent spend ONE monthly allowance, so asking here is spending the budget
 *     that answers customers. `remainingTotal` is shown next to
 *     `remainingForCommands` for exactly that reason — a merchant seeing only
 *     "te quedan 380 preguntas" would have no idea their shop was involved.
 *  2. **What it looked at.** The tools that ran are listed under the answer, so
 *     a surprising figure can be told apart from an invented one.
 *
 * There is no thread: each question stands alone (see `agentCommandInput` in
 * `@ventia/core` for why), so the examples below are written as complete
 * questions rather than as the start of a conversation.
 */

/** Starters, because a blank box is the hardest thing to answer. These are the
 * three questions this assistant was built around. */
const EXAMPLES = [
  '¿Por qué vendí menos esta semana?',
  '¿Qué producto se está quedando quieto?',
  '¿Cuántos pedidos van hoy?',
];

export default function AsistentePage() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    try {
      setAnswer(await askAssistant(trimmed));
    } catch (err) {
      // The previous answer is cleared: leaving it on screen under a fresh
      // error reads as though it answered the new question.
      setAnswer(null);
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Asistente</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Pregúntale por tus ventas, tus pedidos o tu inventario. Responde con los mismos números de tu tablero, y te
            dice cuando no sabe algo en vez de estimarlo.
          </p>

          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(question);
            }}
          >
            <textarea
              className="min-h-24 w-full rounded-md border border-border bg-background p-3 text-sm text-foreground"
              placeholder="¿Cómo vamos esta semana?"
              value={question}
              maxLength={1000}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={loading || question.trim().length === 0}>
                {loading ? <Spinner /> : null} Preguntar
              </Button>
            </div>
          </form>

          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={() => {
                  setQuestion(example);
                  void submit(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error ? <Alert variant="error">{assistantErrorMessage(error)}</Alert> : null}

      {answer ? (
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <p className="whitespace-pre-wrap text-sm text-foreground">{answer.answer}</p>

            {answer.usedTools.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Consultó: {answer.usedTools.map((tool) => TOOL_LABELS[tool.name] ?? tool.name).join(' · ')}
              </p>
            ) : (
              // Worth saying out loud rather than rendering nothing: an answer
              // with figures in it and no lookup behind it is one the merchant
              // should not act on.
              <p className="text-xs text-muted-foreground">No consultó tus datos para responder esto.</p>
            )}

            <div className="border-t border-border pt-3 text-xs text-muted-foreground">
              <p>
                Usaste {answer.budget.used} de {answer.budget.limit} mensajes de IA este mes. Te quedan{' '}
                {answer.budget.remainingForCommands} preguntas aquí.
              </p>
              {/* The consequence a merchant would otherwise never see: these
                  questions come out of the same allowance their storefront
                  uses to answer customers. */}
              <p>
                Tu tienda tiene {answer.budget.remainingTotal} mensajes para responderles a tus clientes ({
                  answer.budget.shopperReserve
                }{' '}
                están reservados solo para ellos).
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * The generic `PLAN_LIMIT_EXCEEDED` copy is wrong for one of the two ways this
 * endpoint refuses.
 *
 * `shopper_reserve` is not "you ran out" — the store still has messages, and
 * the assistant is deliberately leaving them for customers. Showing the
 * standard upgrade prompt there would push a merchant to pay to fix something
 * that is not broken.
 */
function assistantErrorMessage(error: ApiError): string {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (error.code === 'PLAN_LIMIT_EXCEEDED' && reason === 'shopper_reserve') {
    return 'Pausé las preguntas del asistente para dejarle mensajes de IA a tus clientes: tu tienda los necesita para venderles. Vuelve el próximo mes o mejora tu plan.';
  }
  return errorMessage(error);
}
