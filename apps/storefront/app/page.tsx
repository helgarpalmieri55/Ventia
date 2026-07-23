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
  return (
    <main>
      <h1>{tenant.name}</h1>
      <p>Bienvenido a la tienda de {tenant.name}.</p>
    </main>
  );
}
