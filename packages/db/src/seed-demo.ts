/**
 * Siembra la tienda de DEMOSTRACIÓN — la que se graba para el App Review de
 * Meta.
 *
 * No toca `seed.ts`, que sigue siendo el sembrado mínimo de desarrollo. Este
 * es otro: una sola tienda, en el plan **crece** (el que incluye Instagram),
 * con catálogo, políticas, pedidos, conversaciones y las dos cuentas de
 * mensajería conectadas, para que abrir el panel o la tienda parezca un
 * negocio y no un fixture.
 *
 * ## Se puede correr las veces que haga falta
 *
 * Todo es idempotente y la tienda tiene un id FIJO
 * (`scripts/demo/demo.json`), así que volver a sembrar no duplica nada ni
 * cambia enlaces que ya estuvieran abiertos en una pestaña.
 *
 * ## Modo de regrabación
 *
 * `--reiniciar` borra ANTES lo que una toma ensucia —conversaciones, pedidos,
 * carritos, movimientos de inventario y el consumo de IA del mes— y vuelve a
 * sembrar. Lo que NO borra: el inquilino, la dueña ni su membresía. Eso es
 * deliberado: borrarlos cerraría la sesión del panel en mitad de la grabación
 * y obligaría a volver a entrar, que es justo el minuto que este modo existe
 * para ahorrar.
 *
 * ## Uso
 *
 *   pnpm --filter @ventia/db exec tsx src/seed-demo.ts [--reiniciar] [--sin-fotos]
 *
 * o, desde la raíz, `pnpm run demo:seed` / `pnpm run demo:reiniciar`.
 */

import { createHash } from 'node:crypto';
import { generateOrderReference, PLANS } from '@ventia/core';
import { Prisma, platformDb } from './index.js';
import {
  AGENTE,
  CATEGORIAS,
  CLIENTES,
  COLECCIONES,
  CONTENIDOS,
  CONVERSACIONES,
  ENVIOS,
  INFO_TIENDA,
  PEDIDOS,
  PRODUCTOS,
  cargarConfigDemo,
  cargarLlave,
  cifrar,
  type ProductoDemo,
  type TarifaIva,
} from './seed-demo-datos.js';

/** Del valor que usa la API (`TAX_RATES`) al miembro del enum de Prisma. */
const IVA_PRISMA: Record<TarifaIva, 'ZERO' | 'FIVE' | 'NINETEEN' | 'EXCLUIDO'> = {
  '0': 'ZERO',
  '5': 'FIVE',
  '19': 'NINETEEN',
  excluido: 'EXCLUIDO',
};

const cfg = cargarConfigDemo();
const TENANT_ID = cfg.tienda.id;

function log(mensaje: string): void {
  console.log(`  ${mensaje}`);
}

/** Pesos enteros a la unidad que guarda la base (centavos). */
function aCentavos(pesos: number): number {
  return Math.round(pesos * 100);
}

// ---------------------------------------------------------------------------
// Reinicio
// ---------------------------------------------------------------------------

/**
 * Deja la tienda como recién sembrada sin desmontar nada.
 *
 * El orden va de las hojas hacia la raíz aunque casi todo esté en cascada:
 * depender de la cascada aquí obligaría a saber de memoria cuáles la tienen y
 * cuáles no, y una tabla nueva sin `onDelete: Cascade` dejaría filas huérfanas
 * de una toma anterior justo en la pantalla que se está grabando.
 */
async function reiniciar(): Promise<void> {
  await platformDb.message.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.conversation.deleteMany({ where: { tenantId: TENANT_ID } });

  // Las reseñas cuelgan a la vez de un pedido y de una cuenta de comprador, así
  // que se van antes que ninguno de los dos.
  await platformDb.review.deleteMany({ where: { tenantId: TENANT_ID } });

  await platformDb.payment.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.shipment.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.invoice.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.orderEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.orderItem.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.order.deleteMany({ where: { tenantId: TENANT_ID } });

  await platformDb.cartItem.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.cart.deleteMany({ where: { tenantId: TENANT_ID } });

  // Las cuentas que un comprador se haya creado durante la toma anterior. Sin
  // esto, volver a grabar el registro en la tienda choca contra
  // `@@unique([tenantId, email])` y el formulario dice que el correo ya existe
  // — con la cámara puesta.
  await platformDb.shopperToken.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.shopperSession.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.wishlistItem.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.shopperAddress.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.shopperAccount.deleteMany({ where: { tenantId: TENANT_ID } });

  await platformDb.inventoryMovement.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.agentUsage.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.webhookEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  await platformDb.notificationLog.deleteMany({ where: { tenantId: TENANT_ID } });

  log('reinicio: conversaciones, pedidos, carritos, cuentas de comprador y consumo de IA borrados');
}

// ---------------------------------------------------------------------------
// Inquilino
// ---------------------------------------------------------------------------

async function sembrarTienda(logoUrl: string | null): Promise<void> {
  const theme: Prisma.InputJsonValue = {
    // Preset "Taller": terracota sobre fondo cálido, bordes suaves. Es el que
    // el propio producto propone para producto hecho a mano con historia.
    presetId: 'taller',
    ...(logoUrl ? { logoUrl } : {}),
  };
  const settings: Prisma.InputJsonValue = {
    storeInfo: INFO_TIENDA,
    shipping: ENVIOS,
    payments: { codEnabled: true },
    // Los pasos del asistente de alta, todos dados: una tienda de demo con el
    // aviso de "termina de configurar tu tienda" encima no se puede grabar.
    onboarding: { store_info: true, catalog: true, shipping: true, payments: true, theme: true },
  };

  const datos = {
    name: cfg.tienda.nombre,
    status: 'live' as const,
    plan: cfg.tienda.plan,
    theme,
    agentConfig: AGENTE satisfies Prisma.InputJsonValue,
    settings,
  };

  await platformDb.tenant.upsert({
    where: { id: TENANT_ID },
    update: datos,
    create: { id: TENANT_ID, slug: cfg.tienda.slug, ...datos },
  });

  // El plan CRECE es el que incluye Instagram. Se copian los límites del plan
  // en vez de escribir valores a mano para que la demo no pueda desviarse de
  // lo que vende la página de planes.
  const limites = PLANS[cfg.tienda.plan];
  await platformDb.tenantLimits.upsert({
    where: { tenantId: TENANT_ID },
    update: limites,
    create: { tenantId: TENANT_ID, ...limites },
  });

  // Verificado en local: `.localhost` es un TLD reservado (RFC 6761) y Caddy
  // lo sirve por HTTP sin certificado, así que `verifiedAt` puesto es la
  // verdad aquí, no un atajo.
  await platformDb.tenantDomain.upsert({
    where: { domain: cfg.tienda.dominio },
    update: { tenantId: TENANT_ID, isPrimary: true, verifiedAt: new Date() },
    create: { tenantId: TENANT_ID, domain: cfg.tienda.dominio, isPrimary: true, verifiedAt: new Date() },
  });

  log(`tienda "${cfg.tienda.nombre}" en plan ${cfg.tienda.plan}, dominio ${cfg.tienda.dominio}`);
}

/**
 * Ata la cuenta de la dueña —creada por el camino real de registro, ver
 * `scripts/demo/usuario.mjs`— a la tienda de demo, y le da el correo por
 * verificado.
 *
 * No crea el usuario: la contraseña la calcula better-auth, que vive en
 * `services/api`, y `@ventia/db` no puede depender de allí. Reimplementar aquí
 * el formato del hash sería un segundo sitio donde tener la misma verdad, con
 * la garantía de que se desincroniza en la próxima actualización de
 * better-auth.
 */
async function vincularDuena(): Promise<void> {
  const usuario = await platformDb.user.findUnique({ where: { email: cfg.duena.email } });
  if (!usuario) {
    log(`AVISO: no existe el usuario ${cfg.duena.email}; el panel no tendrá con qué entrar.`);
    log('       Créalo con: node scripts/demo/usuario.mjs (necesita el API arriba).');
    return;
  }

  // El correo verificado es una de las cuatro condiciones de la lista de
  // lanzamiento, y sin él el panel muestra un aviso permanente.
  await platformDb.user.update({
    where: { id: usuario.id },
    data: { emailVerified: true, name: cfg.duena.nombre },
  });

  const membresia = await platformDb.membership.findFirst({
    where: { userId: usuario.id, tenantId: TENANT_ID },
  });
  if (!membresia) {
    // Una membresía anterior a OTRA tienda dejaría a la dueña entrando a la
    // tienda equivocada: el panel resuelve el inquilino por la membresía.
    await platformDb.membership.deleteMany({ where: { userId: usuario.id } });
    await platformDb.membership.create({ data: { userId: usuario.id, tenantId: TENANT_ID, role: 'owner' } });
  }
  log(`dueña ${cfg.duena.email} vinculada como owner`);
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

async function sembrarCategorias(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  // Dos pasadas: primero todas sin padre, luego se cuelgan. Una sola pasada
  // exigiría que el arreglo estuviera ordenado topológicamente, y eso es una
  // regla invisible que se rompe la primera vez que alguien añade una
  // subcategoría al final.
  for (const categoria of CATEGORIAS) {
    const fila = await platformDb.category.upsert({
      where: { tenantId_slug: { tenantId: TENANT_ID, slug: categoria.slug } },
      update: { name: categoria.nombre, position: categoria.posicion },
      create: { tenantId: TENANT_ID, slug: categoria.slug, name: categoria.nombre, position: categoria.posicion },
    });
    ids.set(categoria.slug, fila.id);
  }
  for (const categoria of CATEGORIAS) {
    if (!categoria.padre) continue;
    await platformDb.category.update({
      where: { id: ids.get(categoria.slug) },
      data: { parentId: ids.get(categoria.padre) },
    });
  }
  log(`${CATEGORIAS.length} categorías`);
  return ids;
}

/** La URL pública que tendría la foto de este producto en MinIO. */
function urlFoto(producto: ProductoDemo): string {
  const base = (process.env.S3_PUBLIC_URL ?? 'http://localhost:9000/ventia').replace(/\/+$/, '');
  return `${base}/${cfg.fotos.prefijo}/${producto.slug}`;
}

/**
 * ¿Existe de verdad ese objeto?
 *
 * Se comprueba con un HEAD antes de escribir la fila `ProductImage`, y no se
 * da por hecho, porque el storefront dibuja un marcador de "sin foto"
 * diseñado cuando no hay imagen y el glifo de imagen rota del navegador
 * cuando la hay y falla. Lo primero se puede grabar; lo segundo obliga a
 * repetir la toma.
 */
async function fotoDisponible(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function sembrarProductos(categorias: Map<string, string>, conFotos: boolean): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  let conFoto = 0;

  for (const producto of PRODUCTOS) {
    const fila = await platformDb.product.upsert({
      where: { tenantId_slug: { tenantId: TENANT_ID, slug: producto.slug } },
      update: {
        name: producto.nombre,
        descriptionMd: producto.descripcion,
        priceCents: aCentavos(producto.precio),
        compareAtCents: producto.precioAntes ? aCentavos(producto.precioAntes) : null,
        costCents: aCentavos(producto.costo),
        sku: producto.sku,
        stock: producto.stock,
        taxRate: IVA_PRISMA[producto.iva],
        status: 'active',
        options: producto.opciones ?? [],
        seo: producto.seo ?? Prisma.DbNull,
      },
      create: {
        tenantId: TENANT_ID,
        slug: producto.slug,
        name: producto.nombre,
        descriptionMd: producto.descripcion,
        priceCents: aCentavos(producto.precio),
        compareAtCents: producto.precioAntes ? aCentavos(producto.precioAntes) : null,
        costCents: aCentavos(producto.costo),
        sku: producto.sku,
        stock: producto.stock,
        taxRate: IVA_PRISMA[producto.iva],
        status: 'active',
        options: producto.opciones ?? [],
        seo: producto.seo ?? Prisma.DbNull,
      },
    });
    ids.set(producto.slug, fila.id);

    const categoriaId = categorias.get(producto.categoria);
    if (categoriaId) {
      await platformDb.productCategory.upsert({
        where: { productId_categoryId: { productId: fila.id, categoryId: categoriaId } },
        update: {},
        create: { tenantId: TENANT_ID, productId: fila.id, categoryId: categoriaId },
      });
    }

    // Las variantes no tienen clave única propia, así que se reemplazan en
    // bloque — que es exactamente lo que hace el endpoint del panel
    // (`variantsReplaceSchema`).
    await platformDb.productVariant.deleteMany({ where: { productId: fila.id } });
    for (const variante of producto.variantes ?? []) {
      await platformDb.productVariant.create({
        data: {
          tenantId: TENANT_ID,
          productId: fila.id,
          option1: variante.opcion1,
          sku: variante.sku,
          stock: variante.stock,
          priceCents: variante.precio ? aCentavos(variante.precio) : null,
        },
      });
    }

    await platformDb.productImage.deleteMany({ where: { productId: fila.id } });
    if (conFotos) {
      const url = urlFoto(producto);
      if (await fotoDisponible(url)) {
        await platformDb.productImage.create({
          data: { tenantId: TENANT_ID, productId: fila.id, url, alt: producto.nombre, position: 0 },
        });
        conFoto += 1;
      }
    }
  }

  log(`${PRODUCTOS.length} productos activos${conFotos ? `, ${conFoto} con foto` : ' (sin fotos)'}`);
  if (conFotos && conFoto === 0) {
    log('AVISO: ninguna foto respondió. Corre `node scripts/demo/fotos.mjs` con MinIO arriba y vuelve a sembrar.');
  }
  return ids;
}

async function sembrarColecciones(productos: Map<string, string>): Promise<void> {
  for (const coleccion of COLECCIONES) {
    const fila = await platformDb.collection.upsert({
      where: { tenantId_slug: { tenantId: TENANT_ID, slug: coleccion.slug } },
      update: { name: coleccion.nombre, descriptionMd: coleccion.descripcion, position: coleccion.posicion, isActive: true },
      create: {
        tenantId: TENANT_ID,
        slug: coleccion.slug,
        name: coleccion.nombre,
        descriptionMd: coleccion.descripcion,
        position: coleccion.posicion,
        isActive: true,
      },
    });
    await platformDb.collectionProduct.deleteMany({ where: { collectionId: fila.id } });
    await platformDb.collectionProduct.createMany({
      data: coleccion.productos.flatMap((slug, position) => {
        const productId = productos.get(slug);
        return productId ? [{ tenantId: TENANT_ID, collectionId: fila.id, productId, position }] : [];
      }),
    });
  }
  log(`${COLECCIONES.length} colecciones`);
}

async function sembrarContenidos(): Promise<string> {
  for (const contenido of CONTENIDOS) {
    await platformDb.tenantContent.upsert({
      where: { tenantId_type: { tenantId: TENANT_ID, type: contenido.tipo } },
      update: { title: contenido.titulo, bodyMd: contenido.cuerpo },
      create: { tenantId: TENANT_ID, type: contenido.tipo, title: contenido.titulo, bodyMd: contenido.cuerpo },
    });
  }
  log(`${CONTENIDOS.length} páginas de contenido (envíos, devoluciones, privacidad, términos, contacto, FAQ)`);

  // La misma huella que calcula `privacyPolicyVersionFor` en el checkout, para
  // que los pedidos sembrados lleven una prueba de autorización coherente con
  // la política que está publicada, y no una cadena inventada.
  const privacidad = CONTENIDOS.find((c) => c.tipo === 'policy_privacy')!;
  const huella = createHash('sha256').update(`${privacidad.titulo}\0${privacidad.cuerpo}`, 'utf8').digest('hex');
  return `sha256:${huella.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Canales de mensajería
// ---------------------------------------------------------------------------

/**
 * Conecta el número de WhatsApp y la cuenta de Instagram con las credenciales
 * cifradas con la MISMA llave y el mismo formato que usa la API.
 *
 * El `appSecret` que se cifra aquí es el que firman los simuladores
 * (`scripts/demo/ig.mjs` y `wa.mjs`). Si no coincidieran, el adaptador
 * devolvería `null`, el controlador contestaría 200 y no habría ni error ni
 * conversación: el fallo más caro de diagnosticar de toda la demo.
 */
async function sembrarCanales(): Promise<void> {
  const llave = cargarLlave();

  const wa = cfg.whatsapp;
  const waCred = cifrar(JSON.stringify({ token: wa.token, appSecret: wa.appSecret }), llave);
  await platformDb.whatsAppNumber.upsert({
    where: { externalId: wa.externalId },
    update: {
      tenantId: TENANT_ID,
      provider: wa.proveedor,
      displayPhone: wa.telefonoVisible,
      status: 'connected',
      credentialsEnc: waCred,
      verifyToken: wa.verifyToken,
    },
    create: {
      tenantId: TENANT_ID,
      provider: wa.proveedor,
      externalId: wa.externalId,
      displayPhone: wa.telefonoVisible,
      status: 'connected',
      credentialsEnc: waCred,
      verifyToken: wa.verifyToken,
    },
  });

  const ig = cfg.instagram;
  const igCred = cifrar(JSON.stringify({ token: ig.token, appSecret: ig.appSecret }), llave);
  await platformDb.instagramAccount.upsert({
    where: { igAccountId: ig.igAccountId },
    update: {
      tenantId: TENANT_ID,
      provider: ig.proveedor,
      pageId: ig.pageId,
      username: ig.usuario,
      status: 'connected',
      credentialsEnc: igCred,
      verifyToken: ig.verifyToken,
    },
    create: {
      tenantId: TENANT_ID,
      provider: ig.proveedor,
      igAccountId: ig.igAccountId,
      pageId: ig.pageId,
      username: ig.usuario,
      status: 'connected',
      credentialsEnc: igCred,
      verifyToken: ig.verifyToken,
    },
  });

  log(`WhatsApp ${wa.telefonoVisible} e Instagram @${ig.usuario} conectados`);
}

// ---------------------------------------------------------------------------
// Clientes, pedidos y conversaciones
// ---------------------------------------------------------------------------

async function sembrarClientes(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const cliente of CLIENTES) {
    const existente = await platformDb.customer.findFirst({
      where: { tenantId: TENANT_ID, email: cliente.email },
    });
    const fila = existente
      ? await platformDb.customer.update({
          where: { id: existente.id },
          data: { name: cliente.nombre, phone: cliente.telefono },
        })
      : await platformDb.customer.create({
          data: { tenantId: TENANT_ID, email: cliente.email, name: cliente.nombre, phone: cliente.telefono },
        });
    ids.set(cliente.email, fila.id);
  }
  return ids;
}

const IVA_FRACCION: Record<TarifaIva, number> = { '0': 0, '5': 0.05, '19': 0.19, excluido: 0 };

async function sembrarPedidos(
  productos: Map<string, string>,
  clientes: Map<string, string>,
  huellaPrivacidad: string,
): Promise<void> {
  const porSlug = new Map(PRODUCTOS.map((p) => [p.slug, p]));
  let vendidos = 0;

  for (const pedido of PEDIDOS) {
    const cliente = CLIENTES.find((c) => c.email === pedido.cliente)!;
    const creado = new Date(Date.now() - pedido.haceDias * 24 * 60 * 60 * 1000);

    // El precio y el IVA se recalculan desde el catálogo en vez de escribirse
    // a mano: un total que no cuadre con sus líneas es exactamente el detalle
    // que se ve en pantalla y obliga a repetir la toma.
    const lineas = pedido.items.map((item) => {
      const producto = porSlug.get(item.producto)!;
      return {
        producto,
        cantidad: item.cantidad,
        precio: aCentavos(producto.precio),
        subtotal: aCentavos(producto.precio) * item.cantidad,
      };
    });
    const subtotalCents = lineas.reduce((suma, l) => suma + l.subtotal, 0);
    const taxCents = lineas.reduce(
      (suma, l) => suma + Math.round(l.subtotal * IVA_FRACCION[l.producto.iva]),
      0,
    );
    const shippingCents = aCentavos(pedido.envio);

    const direccion = {
      nombreCompleto: cliente.nombre,
      telefono: cliente.telefono,
      departamentoCode: pedido.direccion.departamentoCode,
      municipioName: pedido.direccion.municipioName,
      direccion: pedido.direccion.direccion,
      ...(pedido.direccion.barrio ? { barrio: pedido.direccion.barrio } : {}),
    };

    const comunes = {
      status: pedido.estado,
      paymentStatus: pedido.pago,
      paymentProvider: pedido.proveedorPago,
      customerId: clientes.get(cliente.email) ?? null,
      email: cliente.email,
      phone: cliente.telefono,
      shippingAddress: direccion as Prisma.InputJsonValue,
      shippingMethod: pedido.envioMetodo,
      shippingCents,
      subtotalCents,
      taxCents,
      totalCents: subtotalCents + taxCents + shippingCents,
      source: pedido.origen,
      channel: pedido.canal,
      privacyAcceptedAt: creado,
      privacyPolicyVersion: huellaPrivacidad,
      createdAt: creado,
    };

    const fila = await platformDb.order.upsert({
      where: { tenantId_number: { tenantId: TENANT_ID, number: pedido.numero } },
      update: comunes,
      create: { tenantId: TENANT_ID, number: pedido.numero, reference: generateOrderReference(), ...comunes },
    });

    await platformDb.orderItem.deleteMany({ where: { orderId: fila.id } });
    for (const linea of lineas) {
      await platformDb.orderItem.create({
        data: {
          tenantId: TENANT_ID,
          orderId: fila.id,
          productId: productos.get(linea.producto.slug) ?? null,
          nameSnapshot: linea.producto.nombre,
          priceCentsSnapshot: linea.precio,
          qty: linea.cantidad,
          taxRateSnapshot: IVA_PRISMA[linea.producto.iva],
        },
      });
      vendidos += linea.cantidad;
    }

    await platformDb.orderEvent.deleteMany({ where: { orderId: fila.id } });
    const eventos: { type: string; actor: string; desfaseHoras: number }[] = [
      { type: 'created', actor: pedido.origen === 'agent' ? 'agent' : 'shopper', desfaseHoras: 0 },
    ];
    if (pedido.pago === 'PAID') eventos.push({ type: 'payment_paid', actor: 'system', desfaseHoras: 1 });
    if (['PREPARING', 'SHIPPED', 'DELIVERED'].includes(pedido.estado)) {
      eventos.push({ type: 'status_preparing', actor: 'merchant', desfaseHoras: 4 });
    }
    if (['SHIPPED', 'DELIVERED'].includes(pedido.estado)) {
      eventos.push({ type: 'status_shipped', actor: 'merchant', desfaseHoras: 20 });
    }
    if (pedido.estado === 'DELIVERED') eventos.push({ type: 'status_delivered', actor: 'system', desfaseHoras: 48 });
    for (const evento of eventos) {
      await platformDb.orderEvent.create({
        data: {
          tenantId: TENANT_ID,
          orderId: fila.id,
          type: evento.type,
          actor: evento.actor,
          createdAt: new Date(creado.getTime() + evento.desfaseHoras * 60 * 60 * 1000),
        },
      });
    }

    // El pedido en camino lleva guía, para que la página de rastreo tenga algo
    // real que mostrar.
    await platformDb.shipment.deleteMany({ where: { orderId: fila.id } });
    if (['SHIPPED', 'DELIVERED'].includes(pedido.estado)) {
      await platformDb.shipment.create({
        data: {
          tenantId: TENANT_ID,
          orderId: fila.id,
          provider: 'Coordinadora',
          trackingNumber: `COORD${String(pedido.numero).padStart(9, '0')}`,
          status: pedido.estado === 'DELIVERED' ? 'entregado' : 'en_transito',
        },
      });
    }
  }

  // Los contadores del CRM, coherentes con los pedidos que se acaban de
  // escribir. Un cliente que dice "0 pedidos" al lado de su lista de pedidos
  // es de las cosas que se notan en cámara.
  for (const cliente of CLIENTES) {
    const suyos = await platformDb.order.findMany({
      where: { tenantId: TENANT_ID, email: cliente.email, paymentStatus: { in: ['PAID', 'COD'] } },
      select: { totalCents: true },
    });
    await platformDb.customer.update({
      where: { id: clientes.get(cliente.email) },
      data: { ordersCount: suyos.length, totalSpentCents: suyos.reduce((s, o) => s + o.totalCents, 0) },
    });
  }

  log(`${PEDIDOS.length} pedidos (${vendidos} unidades) y ${CLIENTES.length} clientes`);
}

async function sembrarConversaciones(): Promise<void> {
  for (const conversacion of CONVERSACIONES) {
    const inicio = new Date(Date.now() - conversacion.haceHoras * 60 * 60 * 1000);
    const existente = await platformDb.conversation.findFirst({
      where: { tenantId: TENANT_ID, channel: conversacion.canal, shopperRef: conversacion.referencia },
    });
    if (existente) continue;

    const fila = await platformDb.conversation.create({
      data: {
        tenantId: TENANT_ID,
        channel: conversacion.canal,
        shopperRef: conversacion.referencia,
        status: conversacion.estado,
        startedAt: inicio,
      },
    });
    for (const [i, turno] of conversacion.turnos.entries()) {
      await platformDb.message.create({
        data: {
          tenantId: TENANT_ID,
          conversationId: fila.id,
          role: turno.rol,
          content: turno.texto,
          // Aproximado a ojo y a propósito: son turnos ya ocurridos, y lo
          // único que importa es que el desglose de consumo no salga en cero.
          inputTokens: turno.rol === 'assistant' ? 1800 + i * 120 : 0,
          outputTokens: turno.rol === 'assistant' ? 140 + i * 20 : 0,
          createdAt: new Date(inicio.getTime() + i * 90 * 1000),
        },
      });
    }
  }
  log(`${CONVERSACIONES.length} conversaciones ya atendidas`);
}

/**
 * El consumo de IA del mes en curso.
 *
 * Sin esta fila la pantalla de Consumo sale en cero, que para una tienda con
 * pedidos hechos por el agente se lee como si algo estuviera roto. Los números
 * son los de una tienda pequeña que lleva media semana usándolo, muy por
 * debajo de los 1.200 créditos del plan Crece.
 */
async function sembrarConsumo(): Promise<void> {
  const ahora = new Date();
  const mes = `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, '0')}`;
  const datos = {
    inputTokens: 214_800,
    outputTokens: 18_640,
    cacheWriteTokens: 22_400,
    cacheReadTokens: 168_300,
    costMicroUsd: 1_284_000n,
    messagesCount: 96,
    creditsUsed: 112,
  };
  await platformDb.agentUsage.upsert({
    where: { tenantId_month: { tenantId: TENANT_ID, month: mes } },
    update: datos,
    create: { tenantId: TENANT_ID, month: mes, ...datos },
  });
  log(`consumo de IA de ${mes}: ${datos.creditsUsed} de ${PLANS[cfg.tienda.plan].aiCreditsMonth} créditos`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const conFotos = !args.has('--sin-fotos');

  console.log(`\n== Sembrando la demo: ${cfg.tienda.nombre} ==\n`);

  if (args.has('--reiniciar')) await reiniciar();

  const logoUrl = conFotos ? await logoDisponible() : null;
  await sembrarTienda(logoUrl);
  await vincularDuena();
  const categorias = await sembrarCategorias();
  const productos = await sembrarProductos(categorias, conFotos);
  await sembrarColecciones(productos);
  const huella = await sembrarContenidos();
  await sembrarCanales();
  const clientes = await sembrarClientes();
  await sembrarPedidos(productos, clientes, huella);
  await sembrarConversaciones();
  await sembrarConsumo();

  console.log(`\n== Listo ==`);
  console.log(`   Tienda:    ${cfg.urls.tienda}`);
  console.log(`   Panel:     ${cfg.urls.admin}  (${cfg.duena.email} / ${cfg.duena.clave})`);
  console.log(`   Instagram: node scripts/demo/ig.mjs "tu mensaje"`);
  console.log(`   WhatsApp:  node scripts/demo/wa.mjs "tu mensaje"\n`);
  // La resolución de dominio a inquilino se cachea 60 s en Redis
  // (`DomainResolver`). Nada de lo que siembra este script lo invalida, así
  // que un cambio de nombre, tema o logo con el API ya arriba puede tardar ese
  // minuto en verse. `pnpm run demo:reiniciar` vacía esa clave.
  console.log('   (si acabas de cambiar el tema o el logo con el API arriba, puede tardar');
  console.log('    hasta 60 s en verse: es la caché de resolución de dominio)\n');
}

/** El logo, con la misma comprobación que las fotos de producto: la cabecera
 * de la tienda lo pinta con un `<img>` sin manejo de error, así que una URL
 * rota deja el glifo del navegador arriba del todo en cada pantalla. */
async function logoDisponible(): Promise<string | null> {
  const base = (process.env.S3_PUBLIC_URL ?? 'http://localhost:9000/ventia').replace(/\/+$/, '');
  const url = `${base}/${cfg.fotos.prefijo}/logo`;
  return (await fotoDisponible(url)) ? url : null;
}

main()
  .catch((err) => {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error(`\nFalló el sembrado de la demo: ${mensaje}`);
    // Los dos fallos que se dan de verdad, con su remedio al lado: sin esto
    // hay que leer una traza de Prisma en mitad de una grabación.
    if (/ECONNREFUSED|Can't reach database|P1001/i.test(mensaje)) {
      console.error('La base no responde. Levántala con: docker compose -f docker/compose.yaml up -d');
    }
    if (/PAYMENTS_ENCRYPTION_KEY/.test(mensaje)) {
      console.error('Usa `pnpm run demo:seed`, que carga el entorno, en vez de llamar a tsx a pelo.');
    }
    process.exitCode = 1;
  })
  .finally(() => platformDb.$disconnect());
