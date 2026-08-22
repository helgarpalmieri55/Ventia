'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Spinner,
} from '@ventia/ui';
import { fetchMyOrders, requestMagicLink, updateMyName, type ShopperOrder } from '../lib/account-api';
import { GENERIC_ERROR, VERIFY_LINK_SENT_NOTICE } from '../lib/account-form';
import {
  formatOrderDate,
  formatOrderNumber,
  isEmailNotVerified,
  orderStatusLabel,
  paymentStatusLabel,
  paymentStatusTone,
} from '../lib/account-orders';
import { formatCOP } from '../lib/format';
import { useShopper } from '../lib/shopper-context';

/**
 * `/cuenta` — everything a shopper's account actually is: their name, whether
 * their address is confirmed, and what they have bought.
 *
 * ## Signed out is a redirect, not an error
 *
 * There is nothing on this page for a guest, and a guest arriving here (an
 * expired session, a bookmarked URL) is one tap from being able to use it, so
 * they go to `/cuenta/entrar` rather than reading about what they cannot see.
 * The redirect waits for `loading` to settle: firing it while `/me` is still
 * in flight would bounce every signed-in shopper off their own account page.
 */
export function AccountArea() {
  const router = useRouter();
  const { shopper, loading, setShopper, signOut } = useShopper();

  React.useEffect(() => {
    if (!loading && !shopper) router.replace('/cuenta/entrar');
  }, [loading, shopper, router]);

  if (loading || !shopper) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Cargando…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Mi cuenta</h1>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            // Navigate only AFTER the request has come back: leaving first
            // can have the browser drop an in-flight request, and the home
            // page would then render a header still showing a session that
            // was never actually ended. A failure is logged and still
            // navigates — the shopper asked to leave, and stranding them on
            // their account page helps nobody.
            void (async () => {
              try {
                await signOut();
              } catch (err) {
                console.error('[account] sign out failed', err);
              }
              router.replace('/');
            })();
          }}
        >
          Salir
        </Button>
      </div>

      <ProfileCard
        email={shopper.email}
        name={shopper.name}
        onSaved={(updated) => setShopper(updated)}
      />

      {shopper.emailVerified ? null : <UnverifiedCard email={shopper.email} />}

      <AccountLinksCard />

      <OrdersCard />
    </main>
  );
}

/**
 * The other two things an account holds, which live on their own screens.
 *
 * Links rather than sections inlined here: both are lists that mutate, each
 * loads its own data, and a shopper who came to check an order should not
 * wait on two more requests to see it. The order (addresses, then favourites)
 * follows what each is worth — the saved address is what makes the next
 * checkout shorter.
 */
function AccountLinksCard() {
  return (
    <Card>
      <CardContent className="flex flex-col divide-y divide-border py-0">
        <Link
          href="/cuenta/direcciones"
          className="flex flex-col gap-0.5 py-4 underline-offset-4 hover:underline"
        >
          <span className="font-medium">Mis direcciones</span>
          <span className="text-sm text-muted-foreground">
            Guarda dónde recibes tus pedidos y llena el pago más rápido.
          </span>
        </Link>
        <Link
          href="/cuenta/favoritos"
          className="flex flex-col gap-0.5 py-4 underline-offset-4 hover:underline"
        >
          <span className="font-medium">Mis favoritos</span>
          <span className="text-sm text-muted-foreground">
            Los productos que guardaste para después.
          </span>
        </Link>
      </CardContent>
    </Card>
  );
}

/** Name and address. The address is shown but not editable: changing it would
 * change who the account IS (it is the key the API matches orders against),
 * and the API offers no route for it — a field that silently did nothing
 * would be worse than none. */
function ProfileCard({
  email,
  name,
  onSaved,
}: {
  email: string;
  name: string | null;
  onSaved: (shopper: { email: string; name: string | null; emailVerified: boolean }) => void;
}) {
  const [value, setValue] = React.useState(name ?? '');
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const trimmed = value.trim();
    if (trimmed.length > 120) {
      setError('Usa máximo 120 caracteres.');
      return;
    }

    setSaving(true);
    try {
      // `null`, not `''`, when the field is empty: the API's schema accepts
      // null as "clear it" and rejects the empty string outright, so a
      // shopper deleting their name has to send the former.
      const updated = await updateMyName(trimmed.length > 0 ? trimmed : null);
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      console.error('[account] failed to save name', err);
      setError(GENERIC_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tus datos</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="text-sm">
          <span className="text-muted-foreground">Correo: </span>
          {email}
        </div>

        {error ? <Alert variant="error">{error}</Alert> : null}
        {saved ? <Alert variant="success">Guardamos tu nombre.</Alert> : null}

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <FormField label="Nombre" htmlFor="account-name">
            <Input
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
              autoComplete="name"
            />
          </FormField>
          <Button type="submit" disabled={saving} className="self-start">
            {saving ? (
              <>
                <Spinner /> Guardando…
              </>
            ) : (
              'Guardar'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * The "confirm your address" panel.
 *
 * The button asks for a MAGIC LINK, not for the verification email to be
 * resent — the API has no resend route, and opening a sign-in link verifies
 * the address as a side effect (`ShopperAuthService.consumeMagicLink` sets
 * `emailVerifiedAt` when it is not already set). So this uses the capability
 * that exists rather than inventing one, and the copy describes what the link
 * actually does.
 */
function UnverifiedCard({ email }: { email: string }) {
  const [sending, setSending] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function send() {
    setError(null);
    setNotice(null);
    setSending(true);
    try {
      await requestMagicLink(email);
      setNotice(VERIFY_LINK_SENT_NOTICE);
    } catch (err) {
      console.error('[account] failed to request verification link', err);
      setError('No pudimos enviar el correo. Intenta de nuevo.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirma tu correo</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Todavía no confirmamos tu correo. Mientras tanto no podemos mostrarte tu historial de
          pedidos: es lo que evita que alguien que se registre con un correo ajeno vea las compras de
          otra persona.
        </p>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {notice ? <Alert variant="success">{notice}</Alert> : null}
        <Button onClick={() => void send()} disabled={sending} className="self-start">
          {sending ? (
            <>
              <Spinner /> Enviando…
            </>
          ) : (
            'Enviarme un enlace'
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

/** The order history. Loads itself rather than being handed rows: the 403 for
 * an unconfirmed address is a state this card has to render, and hoisting the
 * fetch would push that branch into the page for no gain. */
function OrdersCard() {
  const [orders, setOrders] = React.useState<ShopperOrder[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [unverified, setUnverified] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchMyOrders()
      .then((rows) => {
        if (!cancelled) setOrders(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        // The 403 is not a fault — it is "confirm your address first", and
        // `UnverifiedCard` above is already saying so. This card just steps
        // aside instead of stacking a second, redder version of the same
        // message under it.
        if (isEmailNotVerified(err)) {
          setUnverified(true);
          return;
        }
        console.error('[account] failed to load orders', err);
        setError('No pudimos cargar tus pedidos. Intenta de nuevo.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unverified) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mis pedidos</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando tus pedidos…
          </p>
        ) : error ? (
          <Alert variant="error">{error}</Alert>
        ) : !orders || orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no tienes pedidos.{' '}
            <Link href="/" className="underline">
              Mira la tienda
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {orders.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="flex flex-col">
                  <span className="font-medium">{formatOrderNumber(order.number)}</span>
                  <span className="text-xs text-muted-foreground">{formatOrderDate(order.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{orderStatusLabel(order.status)}</Badge>
                  <Badge variant={paymentStatusTone(order.paymentStatus)}>
                    {paymentStatusLabel(order.paymentStatus)}
                  </Badge>
                  <span className="text-sm font-medium">{formatCOP(order.totalCents)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
