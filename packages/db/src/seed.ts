import { PLANS } from '@ventia/core';
import { platformDb } from './index.js';

const TENANTS = [
  {
    slug: 'demo-moda',
    name: 'Demo Moda',
    products: [
      { name: 'Camiseta básica', slug: 'camiseta-basica', priceCents: 4590000 },
      { name: 'Jean clásico', slug: 'jean-clasico', priceCents: 12990000 },
    ],
  },
  {
    slug: 'demo-tech',
    name: 'Demo Tech',
    products: [
      { name: 'Audífonos inalámbricos', slug: 'audifonos-inalambricos', priceCents: 18990000 },
      { name: 'Cargador rápido 30W', slug: 'cargador-rapido-30w', priceCents: 5990000 },
    ],
  },
];

async function main() {
  for (const t of TENANTS) {
    const tenant = await platformDb.tenant.upsert({
      where: { slug: t.slug },
      update: { status: 'live' },
      create: { slug: t.slug, name: t.name, status: 'live', plan: 'basico' },
    });
    await platformDb.tenantDomain.upsert({
      where: { domain: `${t.slug}.ventia.localhost` },
      update: {},
      create: { tenantId: tenant.id, domain: `${t.slug}.ventia.localhost`, isPrimary: true, verifiedAt: new Date() },
    });
    await platformDb.tenantLimits.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: { tenantId: tenant.id, ...PLANS.basico },
    });
    for (const p of t.products) {
      await platformDb.product.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: p.slug } },
        update: {},
        create: { tenantId: tenant.id, name: p.name, slug: p.slug, priceCents: p.priceCents, stock: 10, status: 'active' },
      });
    }
  }
  console.log('Seed complete');
}

main().finally(() => platformDb.$disconnect());
