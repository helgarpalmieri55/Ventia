import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Route-level workaround for a real App Router limitation: page/layout
// Server Components cannot set an arbitrary HTTP status code (notFound()
// only gives 404, redirect() only gives 3xx), but a suspended tenant's
// storefront must answer with a genuine 503 — not a 200 carrying "no
// disponible" copy (see the removed branch this replaces in app/page.tsx).
// Middleware runs before Next.js routes to any page component and can
// construct a `Response` with any status directly, so the suspended check
// happens here via one extra `/v1/tenant` fetch, ahead of the route tree.
//
// Keyed off the upstream 503 itself (not a 200 body with a `status` field):
// `GET /v1/tenant` (services/api/src/tenants/tenant.controller.ts) was fixed
// in the same commit as this file to mirror PublicTenantGuard exactly — a
// suspended tenant now fails closed with a real 503 at the API layer too
// (previously it returned a plain 200 with `{status: 'suspended', ...}` in
// the body, which this middleware alone knew to translate into a 503; any
// caller hitting the API directly, bypassing this middleware, got a 200).
export async function middleware(req: NextRequest) {
  const host = req.headers.get('host');
  if (!host) return NextResponse.next();
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${apiUrl}/v1/tenant`, { headers: { 'x-tenant-domain': host } });
    if (res.status === 503) {
      return new NextResponse('<html><body><h1>Tienda temporalmente no disponible</h1></body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
  } catch {
    // API unreachable — let the request fall through to the page, which has its own unknown-tenant handling.
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
