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
export async function middleware(req: NextRequest) {
  const host = req.headers.get('host');
  if (!host) return NextResponse.next();
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${apiUrl}/v1/tenant`, { headers: { 'x-tenant-domain': host } });
    if (res.status === 200) {
      const tenant = (await res.json()) as { status: string };
      if (tenant.status === 'suspended') {
        return new NextResponse('<html><body><h1>Tienda temporalmente no disponible</h1></body></html>', {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }
  } catch {
    // API unreachable — let the request fall through to the page, which has its own unknown-tenant handling.
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
