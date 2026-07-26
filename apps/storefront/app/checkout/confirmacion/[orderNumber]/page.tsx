import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@ventia/ui';
import { fetchTenantForHost } from '../../../../lib/tenant';
import { fetchStorefront } from '../../../../lib/storefront-api';
import { formatCOP } from '../../../../lib/format';

/** Shape of `GET /v1/storefront/checkout/confirmacion/:orderNumber`'s
 * response (see
 * services/api/src/checkout/checkout.controller.ts#OrderConfirmationDto) —
 * kept local like `StorefrontProductDetail` in `productos/[slug]/page.tsx`
 * (no shared package between the API and this app). Deliberately narrow:
 * no full address, phone, or email — only city + departamento, matching the
 * DTO's own security-relevant "never leak the full address" contract. */
interface OrderConfirmationDto {
  orderNumber: number;
  totalCents: number;
  createdAt: string;
  items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
  shippingCiudad: string;
  shippingDepartamento: string;
}

/** Order numbers are always rendered with this prefix in customer-facing
 * text (spec's "never expose raw ids... e.g. VNT-1042") — same local-copy
 * convention as `services/api/src/mailer/order-emails.ts`'s `vnt()` (no
 * shared package between the API and this app). */
function vnt(orderNumber: number): string {
  return `VNT-${orderNumber}`;
}

/** Server Component, no client interactivity: unlike the checkout page
 * itself (a fully client-driven form), this is a read-only confirmation
 * screen — a plain server-rendered fetch-and-render, same shape as the PDP
 * (`app/productos/[slug]/page.tsx`). */
export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  const { orderNumber } = await params;
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // An unresolved tenant is a plain 404 here, same as the PDP/categorias
  // pages — no "platform landing" concept for a sub-route.
  if (!tenant) notFound();

  // `host` is guaranteed non-null here (tenant resolution above requires it).
  const tenantHost = host as string;

  // Plain fetchStorefront (not the OrNull variant), matching the PDP's
  // established convention: a missing order should genuinely 404 the page,
  // not silently degrade — a real upstream error surfaces as a real error
  // here instead of rendering "not found" the same way a nonexistent order
  // number does.
  const order = await fetchStorefront<OrderConfirmationDto>(
    tenantHost,
    `/v1/storefront/checkout/confirmacion/${encodeURIComponent(orderNumber)}`,
  );
  if (!order) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-2 text-2xl font-semibold">¡Gracias por tu compra!</h1>
      <p className="mb-6 text-sm text-muted-foreground">Pedido #{vnt(order.orderNumber)}</p>

      <Card>
        <CardHeader>
          <CardTitle>Resumen del pedido</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2 text-sm">
            {order.items.map((item, i) => (
              <li key={i} className="flex justify-between">
                <span>
                  {item.nameSnapshot} × {item.qty}
                </span>
                <span>{formatCOP(item.priceCentsSnapshot * item.qty)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-border pt-3 text-base font-semibold">
            <span>Total</span>
            <span>{formatCOP(order.totalCents)}</span>
          </div>
          {/* Only city + departamento, per the DTO's own restricted shape —
              never the full address. */}
          <p className="text-sm text-muted-foreground">
            Se envía a {order.shippingCiudad}, {order.shippingDepartamento}.
          </p>
        </CardContent>
      </Card>

      <p className="mt-6 text-sm text-muted-foreground">
        Te enviamos los detalles de tu pedido y confirmación de pago contra entrega a tu correo — revisa
        tu bandeja de entrada.
      </p>
    </main>
  );
}
