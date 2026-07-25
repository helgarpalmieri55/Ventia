'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';

type SessionState = 'checking' | 'anonymous' | 'signed-in';

interface AcceptResponse {
  tenantId: string;
  role: 'staff';
}

/** Public route, deliberately outside the `(app)` group (see that layout's
 * doc comment): this page must be reachable by someone with NO tenant yet
 * (a brand-new invitee) or even no session at all — both states the `(app)`
 * layout would redirect away from before this component ever ran. It sits
 * directly under `app/`, so it inherits only the root layout (no sidebar,
 * no session-gated redirect).
 *
 * Session state is resolved client-side against `GET /v1/admin/me`, which
 * has no `@Roles` restriction and is itself the only endpoint that can tell
 * "no session" (401 UNAUTHENTICATED) apart from "signed in but no tenant yet"
 * (403 NO_TENANT — see admin-session.guard.ts) — and the latter is exactly
 * the state a fresh signup accepting an invite is in, so it counts as
 * "signed in" for this page's purposes, not "anonymous". */
function AceptarInvitacionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await apiFetch('/v1/admin/me');
        if (!cancelled) setSessionState('signed-in');
      } catch (e) {
        if (!cancelled) setSessionState(e instanceof ApiError && e.status === 403 ? 'signed-in' : 'anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAccept() {
    if (!token) return;
    setError(null);
    setAccepting(true);
    try {
      await apiFetch<AcceptResponse>('/v1/staff/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      // The tenant/membership now exist server-side, so the '/' the (app)
      // layout's getMe() check runs on the next request already resolves to
      // `member` — no extra round-trip needed here first.
      router.push('/');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setAccepting(false);
    }
  }

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invitación no válida</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="error">{errorMessage(new ApiError(400, 'INVITE_INVALID'))}</Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aceptar invitación</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sessionState === 'checking' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Verificando tu sesión…
          </div>
        ) : sessionState === 'anonymous' ? (
          <>
            <p className="text-sm text-foreground">
              Inicia sesión o crea una cuenta para aceptar esta invitación. Cuando termines, vuelve a abrir este
              mismo enlace desde tu correo para completar el proceso.
            </p>
            <div className="flex gap-3">
              <Button href="/login">Inicia sesión</Button>
              <Button href="/registro" variant="secondary">
                Regístrate
              </Button>
            </div>
          </>
        ) : (
          <>
            {error ? <Alert variant="error">{error}</Alert> : null}
            <p className="text-sm text-foreground">Estás a un paso de unirte al equipo de esta tienda.</p>
            <Button onClick={() => void handleAccept()} disabled={accepting} className="self-start">
              {accepting ? 'Aceptando…' : 'Aceptar invitación'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AceptarInvitacionPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="w-full max-w-sm">
        <Suspense fallback={null}>
          <AceptarInvitacionContent />
        </Suspense>
      </div>
    </main>
  );
}
