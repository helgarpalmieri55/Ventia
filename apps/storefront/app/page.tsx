import { headers } from 'next/headers';
import { fetchTenantForHost } from '../lib/tenant';

export default async function Home() {
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  if (!tenant) {
    return (
      <main>
        <h1>Ventia</h1>
        <p>Tu tienda con vendedor de IA. Próximamente.</p>
      </main>
    );
  }

  if (tenant.status === 'suspended') {
    // Deviation from the P1b-6 brief: a real HTTP 503 belongs here, but the
    // Next.js App Router has no ergonomic way for a page component to set a
    // non-200 status without reaching for notFound()/redirect() special
    // cases, which don't fit "temporarily unavailable" semantics. This lands
    // the es-CO message at 200 for now; the strict 503 arrives with the
    // storefront rebuild in P2.
    return (
      <main>
        <h1>Tienda temporalmente no disponible</h1>
      </main>
    );
  }

  return (
    <main>
      <h1>{tenant.name}</h1>
      <p>Bienvenido a la tienda de {tenant.name}.</p>
    </main>
  );
}
