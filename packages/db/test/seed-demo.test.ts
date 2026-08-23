import { describe, expect, it } from 'vitest';
import { createDecipheriv, randomBytes } from 'node:crypto';
import {
  agentSettingsSchema,
  checkoutAddressSchema,
  collectionSlugSchema,
  PLANS,
  productInputSchema,
  shippingSettingsSchema,
  storeSettingsSchema,
  themeSchema,
} from '@ventia/core';
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
} from '../src/seed-demo-datos';

/**
 * Estas pruebas no necesitan base de datos: comprueban los DATOS de la demo y
 * el cifrado de credenciales, que es todo lo que puede estar mal sin que nadie
 * se entere hasta que la cámara está grabando.
 *
 * Los datos se validan contra los MISMOS esquemas de Zod que usa la API cuando
 * un comerciante guarda el formulario. Si algo de aquí no pasaría por el
 * panel, no debería estar en la demo.
 */

const LLAVE = randomBytes(32);

/** Descifrado independiente, escrito contra el formato documentado en
 * `services/api/src/payments/encryption.ts` y NO llamando al `cifrar` que se
 * está probando. Es lo que convierte estas pruebas en una comprobación del
 * formato y no en una tautología. */
function descifrar(blob: string, llave: Buffer): string {
  const partes = blob.split(':');
  expect(partes).toHaveLength(3);
  const [iv, tag, datos] = partes.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', llave, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(datos!), decipher.final()]).toString('utf8');
}

describe('cifrar credenciales', () => {
  it('produce el formato base64(iv):base64(tag):base64(ciphertext)', () => {
    const blob = cifrar('hola', LLAVE);
    const partes = blob.split(':');
    expect(partes).toHaveLength(3);
    // IV de 12 bytes, que es lo que `createDecipheriv` de la API espera.
    expect(Buffer.from(partes[0]!, 'base64')).toHaveLength(12);
    // Etiqueta GCM de 16 bytes.
    expect(Buffer.from(partes[1]!, 'base64')).toHaveLength(16);
  });

  it('un descifrado independiente recupera el texto original', () => {
    const secreto = JSON.stringify({ token: 'EAA-token', appSecret: 'app-secret' });
    expect(descifrar(cifrar(secreto, LLAVE), LLAVE)).toBe(secreto);
  });

  it('usa un IV nuevo en cada llamada', () => {
    // Reutilizar el IV en GCM rompe la confidencialidad. Dos cifrados del
    // mismo texto tienen que salir distintos.
    expect(cifrar('mismo texto', LLAVE)).not.toBe(cifrar('mismo texto', LLAVE));
  });

  it('con otra llave, el descifrado falla en vez de devolver basura', () => {
    const blob = cifrar('secreto', LLAVE);
    expect(() => descifrar(blob, randomBytes(32))).toThrow();
  });

  it('un ciphertext alterado no pasa la autenticación', () => {
    const [iv, tag, datos] = cifrar('secreto', LLAVE).split(':');
    const alterado = Buffer.from(datos!, 'base64');
    alterado[0] = alterado[0]! ^ 0xff;
    expect(() => descifrar(`${iv}:${tag}:${alterado.toString('base64')}`, LLAVE)).toThrow();
  });

  it('acepta acentos y emoji sin corromperlos', () => {
    const texto = 'ñáéíóú — “comillas” 🙌';
    expect(descifrar(cifrar(texto, LLAVE), LLAVE)).toBe(texto);
  });
});

describe('cargarLlave', () => {
  it('exige PAYMENTS_ENCRYPTION_KEY', () => {
    expect(() => cargarLlave({})).toThrow(/PAYMENTS_ENCRYPTION_KEY/);
  });

  it('exige exactamente 32 bytes', () => {
    const corta = { PAYMENTS_ENCRYPTION_KEY: randomBytes(16).toString('base64') };
    expect(() => cargarLlave(corta)).toThrow(/32 bytes/);
  });

  it('devuelve los 32 bytes cuando la llave es válida', () => {
    const llave = randomBytes(32);
    expect(cargarLlave({ PAYMENTS_ENCRYPTION_KEY: llave.toString('base64') }).equals(llave)).toBe(true);
  });
});

describe('scripts/demo/demo.json', () => {
  const cfg = cargarConfigDemo();

  it('la tienda lleva un id UUID fijo', () => {
    expect(cfg.tienda.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('está en el plan que incluye Instagram', () => {
    // Emprende NO trae el canal de Instagram, y el servicio de entrada lo
    // comprueba en CADA mensaje: en el plan equivocado la demo enmudece sin
    // dar ningún error.
    expect(PLANS[cfg.tienda.plan].instagramChannel).toBe(true);
    expect(PLANS[cfg.tienda.plan].whatsappChannel).toBe(true);
    expect(cfg.tienda.plan).toBe('crece');
  });

  it('el dominio cuelga del slug de la tienda', () => {
    expect(cfg.tienda.dominio.startsWith(`${cfg.tienda.slug}.`)).toBe(true);
  });

  it('las URL que se imprimen en pantalla apuntan a la tienda de verdad', () => {
    // Se leen en voz alta durante la grabación: una que no exista es una toma
    // perdida.
    expect(cfg.urls.tienda).toContain(cfg.tienda.dominio);
    expect(cfg.urls.admin).toMatch(/^https?:\/\//);
    expect(cfg.urls.api).toMatch(/^https?:\/\//);
  });

  it('los app secrets de los dos canales son distintos entre sí y no están vacíos', () => {
    expect(cfg.instagram.appSecret.length).toBeGreaterThan(16);
    expect(cfg.whatsapp.appSecret.length).toBeGreaterThan(16);
    expect(cfg.instagram.appSecret).not.toBe(cfg.whatsapp.appSecret);
  });

  it('el comprador de Instagram no es la propia cuenta de la tienda', () => {
    // Un remitente igual a la cuenta lo descarta el parseo como eco.
    expect(cfg.instagram.compradorIgsid).not.toBe(cfg.instagram.igAccountId);
  });

  it('el teléfono de WhatsApp del comprador va en dígitos, como lo normaliza el adaptador', () => {
    expect(cfg.whatsapp.compradorTelefono).toMatch(/^\d{10,15}$/);
  });

  it('hay una lámina por producto, exactamente', () => {
    // `scripts/demo/fotos.mjs` es JavaScript plano y no puede leer el catálogo
    // de TypeScript, así que la lista de láminas vive en demo.json. Esta
    // prueba es lo que impide que se desvíen: sin ella, añadir un producto y
    // olvidar la lámina daría un hueco sin foto en mitad de una cuadrícula que
    // sí las tiene.
    const enCatalogo = PRODUCTOS.map((p) => p.slug).sort();
    const enLaminas = cfg.fotos.laminas.map((l) => l.slug).sort();
    expect(enLaminas).toEqual(enCatalogo);
  });

  it('cada lámina lleva un título corto que cabe en la tarjeta', () => {
    for (const lamina of cfg.fotos.laminas) {
      expect(lamina.titulo.length, lamina.slug).toBeGreaterThan(4);
      // 26 es lo que cabe en una línea de la lámina; más largo se parte en dos
      // y la tarjeta deja de leerse de un vistazo.
      expect(lamina.titulo.length, lamina.slug).toBeLessThanOrEqual(26);
    }
  });

  it('la clave de la dueña aguanta lo que pida better-auth', () => {
    expect(cfg.duena.clave.length).toBeGreaterThanOrEqual(8);
    expect(cfg.duena.email).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
  });
});

// ---------------------------------------------------------------------------

/** Todo lo que, visto en pantalla, delata un fixture. Dos expresiones porque
 * `TODO`/`FIXME` solo cuentan en mayúsculas: sin distinguir, «todos los días»
 * daría un falso positivo en cada descripción escrita en español. */
const RELLENO = [
  /lorem ipsum|\[COMPLETAR|placeholder|xxxx|Producto \d+|Categoría \d+/i,
  /\bTODO\b|\bFIXME\b|\bTBD\b/,
];

function textosVisibles(): string[] {
  return [
    ...PRODUCTOS.flatMap((p) => [p.nombre, p.descripcion, p.seo?.title ?? '', p.seo?.description ?? '']),
    ...CATEGORIAS.map((c) => c.nombre),
    ...COLECCIONES.flatMap((c) => [c.nombre, c.descripcion]),
    ...CONTENIDOS.flatMap((c) => [c.titulo, c.cuerpo]),
    ...CONVERSACIONES.flatMap((c) => c.turnos.map((t) => t.texto)),
    AGENTE.storeSummary,
    AGENTE.policiesSummary,
    INFO_TIENDA.description,
  ];
}

describe('catálogo', () => {
  it('no queda ni un texto de relleno', () => {
    for (const texto of textosVisibles()) {
      for (const patron of RELLENO) {
        expect(texto, `texto de relleno en: ${texto.slice(0, 60)}`).not.toMatch(patron);
      }
    }
  });

  it('los slugs de producto no se repiten', () => {
    const slugs = PRODUCTOS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('los SKU de producto no se repiten', () => {
    // `@@unique([tenantId, sku])`: un duplicado revienta el sembrado a mitad.
    const skus = PRODUCTOS.map((p) => p.sku);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('los SKU de variante no se repiten dentro de un producto', () => {
    for (const producto of PRODUCTOS) {
      const skus = (producto.variantes ?? []).map((v) => v.sku);
      expect(new Set(skus).size, producto.slug).toBe(skus.length);
    }
  });

  it('cada producto pasa el esquema con el que la API valida el formulario', () => {
    for (const producto of PRODUCTOS) {
      const resultado = productInputSchema.safeParse({
        name: producto.nombre,
        slug: producto.slug,
        descriptionMd: producto.descripcion,
        priceCents: producto.precio * 100,
        compareAtCents: producto.precioAntes ? producto.precioAntes * 100 : undefined,
        costCents: producto.costo * 100,
        sku: producto.sku,
        stock: producto.stock,
        taxRate: producto.iva,
        status: 'active',
        seo: producto.seo,
      });
      expect(resultado.success, `${producto.slug}: ${JSON.stringify(resultado.error?.issues)}`).toBe(true);
    }
  });

  it('los precios son pesos enteros y creíbles', () => {
    for (const producto of PRODUCTOS) {
      expect(Number.isInteger(producto.precio), producto.slug).toBe(true);
      // Ni $0 ni un precio de tres cifras que en cámara se lee como un error.
      expect(producto.precio, producto.slug).toBeGreaterThanOrEqual(1000);
      expect(producto.precio, producto.slug).toBeLessThanOrEqual(5_000_000);
      // Redondeados a la centena: un $46.937 delata un dato generado.
      expect(producto.precio % 100, producto.slug).toBe(0);
    }
  });

  it('el precio tachado es MAYOR que el precio de venta', () => {
    for (const producto of PRODUCTOS) {
      if (producto.precioAntes === undefined) continue;
      expect(producto.precioAntes, producto.slug).toBeGreaterThan(producto.precio);
    }
  });

  it('el costo deja margen y no supera el precio', () => {
    for (const producto of PRODUCTOS) {
      expect(producto.costo, producto.slug).toBeGreaterThan(0);
      expect(producto.costo, producto.slug).toBeLessThan(producto.precio);
    }
  });

  it('el café tostado lleva IVA del 5 % y los accesorios del 19 %', () => {
    // Partida 09.01: el café tostado está gravado al 5 % en Colombia. Es el
    // tipo de dato que un revisor mira y que, mal puesto, resta credibilidad.
    for (const producto of PRODUCTOS) {
      const esCafe = producto.categoria === 'origen-unico' || producto.categoria === 'mezclas';
      expect(producto.iva, producto.slug).toBe(esCafe ? '5' : '19');
    }
  });

  it('hay stock en todo lo que se muestra activo', () => {
    for (const producto of PRODUCTOS) {
      expect(producto.stock, producto.slug).toBeGreaterThan(0);
    }
  });

  it('las variantes suman como mucho el stock del producto', () => {
    for (const producto of PRODUCTOS) {
      if (!producto.variantes) continue;
      const suma = producto.variantes.reduce((s, v) => s + v.stock, 0);
      expect(suma, producto.slug).toBeLessThanOrEqual(producto.stock);
    }
  });

  it('un producto con variantes declara sus etiquetas de opción, y al revés', () => {
    for (const producto of PRODUCTOS) {
      expect(Boolean(producto.variantes?.length), producto.slug).toBe(Boolean(producto.opciones?.length));
      expect((producto.opciones ?? []).length, producto.slug).toBeLessThanOrEqual(3);
    }
  });

  it('cada producto cuelga de una categoría que existe', () => {
    const slugs = new Set(CATEGORIAS.map((c) => c.slug));
    for (const producto of PRODUCTOS) {
      expect(slugs.has(producto.categoria), producto.slug).toBe(true);
    }
  });

  it('ninguna categoría de primer nivel se queda vacía', () => {
    // Una categoría con "0 productos" en la portada es una toma repetida.
    const conProducto = new Set(PRODUCTOS.map((p) => p.categoria));
    for (const categoria of CATEGORIAS) {
      const hijas = CATEGORIAS.filter((c) => c.padre === categoria.slug);
      const tiene = conProducto.has(categoria.slug) || hijas.some((h) => conProducto.has(h.slug));
      expect(tiene, categoria.slug).toBe(true);
    }
  });

  it('el padre de cada categoría existe y no es ella misma', () => {
    const slugs = new Set(CATEGORIAS.map((c) => c.slug));
    for (const categoria of CATEGORIAS) {
      if (categoria.padre === null) continue;
      expect(slugs.has(categoria.padre), categoria.slug).toBe(true);
      expect(categoria.padre).not.toBe(categoria.slug);
    }
  });

  it('el árbol de categorías no tiene ciclos', () => {
    const padre = new Map(CATEGORIAS.map((c) => [c.slug, c.padre]));
    for (const categoria of CATEGORIAS) {
      const vistos = new Set<string>([categoria.slug]);
      let actual = categoria.padre;
      while (actual) {
        expect(vistos.has(actual), `ciclo en ${categoria.slug}`).toBe(false);
        vistos.add(actual);
        actual = padre.get(actual) ?? null;
      }
    }
  });
});

describe('colecciones', () => {
  it('los slugs pasan el esquema estricto de la API', () => {
    for (const coleccion of COLECCIONES) {
      expect(collectionSlugSchema.safeParse(coleccion.slug).success, coleccion.slug).toBe(true);
    }
  });

  it('todos sus productos existen y no se repiten dentro de la colección', () => {
    const slugs = new Set(PRODUCTOS.map((p) => p.slug));
    for (const coleccion of COLECCIONES) {
      expect(new Set(coleccion.productos).size, coleccion.slug).toBe(coleccion.productos.length);
      for (const slug of coleccion.productos) {
        expect(slugs.has(slug), `${coleccion.slug} → ${slug}`).toBe(true);
      }
    }
  });

  it('ninguna colección sale vacía', () => {
    // El storefront esconde las tiras vacías, así que una colección vacía es
    // trabajo que no se ve en cámara.
    for (const coleccion of COLECCIONES) {
      expect(coleccion.productos.length, coleccion.slug).toBeGreaterThan(0);
    }
  });
});

describe('configuración de la tienda', () => {
  it('los envíos pasan shippingSettingsSchema', () => {
    const resultado = shippingSettingsSchema.safeParse(ENVIOS);
    expect(resultado.success, JSON.stringify(resultado.error?.issues)).toBe(true);
  });

  it('hay al menos un método de envío habilitado', () => {
    expect(ENVIOS.methods.some((m) => m.enabled)).toBe(true);
  });

  it('el envío gratis exige un umbral mayor que su precio de respaldo', () => {
    for (const metodo of ENVIOS.methods) {
      if (metodo.type !== 'free_over') continue;
      expect(metodo.thresholdCents).toBeGreaterThan(metodo.fallbackPriceCents);
    }
  });

  it('la información de la tienda pasa storeSettingsSchema', () => {
    const resultado = storeSettingsSchema.safeParse({ name: 'Tostaduría La Cumbre', storeInfo: INFO_TIENDA });
    expect(resultado.success, JSON.stringify(resultado.error?.issues)).toBe(true);
  });

  it('están los cinco datos de identidad legal que pide la política de privacidad', () => {
    // Sin ellos el generador de la política deja cinco «[COMPLETAR: …]» en un
    // documento legal publicado.
    for (const campo of ['legalName', 'taxId', 'address', 'municipio', 'departamento'] as const) {
      expect(INFO_TIENDA[campo], campo).toBeTruthy();
    }
  });

  it('la configuración del agente pasa agentSettingsSchema', () => {
    const resultado = agentSettingsSchema.safeParse(AGENTE);
    expect(resultado.success, JSON.stringify(resultado.error?.issues)).toBe(true);
  });

  it('los resúmenes del agente caben en el tope de 600 caracteres', () => {
    expect(AGENTE.storeSummary.length).toBeLessThanOrEqual(600);
    expect(AGENTE.policiesSummary.length).toBeLessThanOrEqual(600);
    // Y dicen algo: un resumen de dos palabras no le sirve al prompt.
    expect(AGENTE.storeSummary.length).toBeGreaterThan(120);
    expect(AGENTE.policiesSummary.length).toBeGreaterThan(120);
  });

  it('el tema que siembra el seed pasa themeSchema', () => {
    const resultado = themeSchema.safeParse({ presetId: 'taller' });
    expect(resultado.success, JSON.stringify(resultado.error?.issues)).toBe(true);
  });
});

describe('páginas de contenido', () => {
  it('están las seis que lee el storefront y el agente', () => {
    const tipos = CONTENIDOS.map((c) => c.tipo).sort();
    expect(tipos).toEqual(['about', 'faq', 'policy_privacy', 'policy_returns', 'policy_shipping', 'policy_terms']);
  });

  it('ninguna se repite', () => {
    expect(new Set(CONTENIDOS.map((c) => c.tipo)).size).toBe(CONTENIDOS.length);
  });

  it('todas tienen título y un cuerpo con sustancia', () => {
    for (const contenido of CONTENIDOS) {
      expect(contenido.titulo.length, contenido.tipo).toBeGreaterThan(3);
      expect(contenido.cuerpo.length, contenido.tipo).toBeGreaterThan(300);
    }
  });

  it('la política de privacidad nombra la ley que la obliga', () => {
    const privacidad = CONTENIDOS.find((c) => c.tipo === 'policy_privacy')!;
    expect(privacidad.cuerpo).toMatch(/Ley 1581/);
  });

  it('los términos nombran el plazo de entrega del artículo 50', () => {
    const terminos = CONTENIDOS.find((c) => c.tipo === 'policy_terms')!;
    expect(terminos.cuerpo).toMatch(/Ley 1480/);
    expect(terminos.cuerpo).toMatch(/30\)? d[ií]as|treinta \(30\)/);
  });

  it('las devoluciones nombran el retracto de 5 días hábiles', () => {
    const devoluciones = CONTENIDOS.find((c) => c.tipo === 'policy_returns')!;
    expect(devoluciones.cuerpo).toMatch(/cinco \(5\) días hábiles/);
  });
});

describe('pedidos de muestra', () => {
  it('los números de pedido no se repiten', () => {
    const numeros = PEDIDOS.map((p) => p.numero);
    expect(new Set(numeros).size).toBe(numeros.length);
  });

  it('cada pedido apunta a un cliente y a productos que existen', () => {
    const correos = new Set(CLIENTES.map((c) => c.email));
    const slugs = new Set(PRODUCTOS.map((p) => p.slug));
    for (const pedido of PEDIDOS) {
      expect(correos.has(pedido.cliente), `pedido ${pedido.numero}`).toBe(true);
      expect(pedido.items.length, `pedido ${pedido.numero}`).toBeGreaterThan(0);
      for (const item of pedido.items) {
        expect(slugs.has(item.producto), `pedido ${pedido.numero} → ${item.producto}`).toBe(true);
        expect(item.cantidad).toBeGreaterThan(0);
      }
    }
  });

  it('la dirección de cada pedido pasa checkoutAddressSchema', () => {
    // El municipio se valida contra su departamento: "Cali" en Antioquia no
    // pasa, y en pantalla sería un pedido imposible.
    for (const pedido of PEDIDOS) {
      const cliente = CLIENTES.find((c) => c.email === pedido.cliente)!;
      const resultado = checkoutAddressSchema.safeParse({
        nombreCompleto: cliente.nombre,
        telefono: cliente.telefono,
        ...pedido.direccion,
      });
      expect(resultado.success, `pedido ${pedido.numero}: ${JSON.stringify(resultado.error?.issues)}`).toBe(true);
    }
  });

  it('el método de envío nombrado existe en la configuración', () => {
    const etiquetas = new Set(ENVIOS.methods.map((m) => m.label));
    for (const pedido of PEDIDOS) {
      expect(etiquetas.has(pedido.envioMetodo), `pedido ${pedido.numero}`).toBe(true);
    }
  });

  it('el envío cobrado concuerda con el método y el umbral de envío gratis', () => {
    const porSlug = new Map(PRODUCTOS.map((p) => [p.slug, p]));
    const gratisDesde = 120_000;
    for (const pedido of PEDIDOS) {
      const subtotal = pedido.items.reduce((s, i) => s + porSlug.get(i.producto)!.precio * i.cantidad, 0);
      if (pedido.envioMetodo === 'Envío nacional') {
        expect(pedido.envio, `pedido ${pedido.numero}`).toBe(subtotal >= gratisDesde ? 0 : 12_000);
      }
      if (pedido.envioMetodo.startsWith('Domicilio en Medellín')) {
        expect(pedido.envio, `pedido ${pedido.numero}`).toBe(8_000);
      }
    }
  });

  it('un pedido entregado o enviado está pagado o es contraentrega', () => {
    for (const pedido of PEDIDOS) {
      if (!['SHIPPED', 'DELIVERED'].includes(pedido.estado)) continue;
      expect(['PAID', 'COD'], `pedido ${pedido.numero}`).toContain(pedido.pago);
    }
  });

  it('un pedido hecho por el agente entró por un canal de mensajería', () => {
    for (const pedido of PEDIDOS) {
      if (pedido.origen !== 'agent') continue;
      expect(['whatsapp', 'instagram'], `pedido ${pedido.numero}`).toContain(pedido.canal);
    }
  });

  it('hay pedidos en varios estados, no todos iguales', () => {
    expect(new Set(PEDIDOS.map((p) => p.estado)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('conversaciones sembradas', () => {
  it('empiezan con el comprador y terminan con el agente', () => {
    for (const conversacion of CONVERSACIONES) {
      expect(conversacion.turnos[0]!.rol).toBe('user');
      expect(conversacion.turnos.at(-1)!.rol).toBe('assistant');
    }
  });

  it('los turnos alternan comprador y agente', () => {
    for (const conversacion of CONVERSACIONES) {
      for (let i = 1; i < conversacion.turnos.length; i++) {
        expect(conversacion.turnos[i]!.rol, `turno ${i}`).not.toBe(conversacion.turnos[i - 1]!.rol);
      }
    }
  });

  it('el chat de la tienda no lleva referencia de comprador y los canales de mensajería sí', () => {
    for (const conversacion of CONVERSACIONES) {
      if (conversacion.canal === 'web') expect(conversacion.referencia).toBeNull();
      else expect(conversacion.referencia, conversacion.canal).toBeTruthy();
    }
  });

  it('la conversación de WhatsApp usa el teléfono de un cliente real de la tienda', () => {
    // Es la que sostiene el pedido 1043: si el número no cuadrara, pasar del
    // chat al pedido durante la grabación no contaría la misma historia.
    const digitos = new Set(CLIENTES.map((c) => c.telefono.replace(/\D/g, '')));
    for (const conversacion of CONVERSACIONES) {
      if (conversacion.canal !== 'whatsapp') continue;
      expect(digitos.has(conversacion.referencia!)).toBe(true);
    }
  });
});
