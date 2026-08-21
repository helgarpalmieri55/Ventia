/**
 * The es-CO *términos y condiciones* template — the contract that governs a
 * sale in this store — rendered from one tenant's own configuration.
 *
 * ## What this is, legally
 *
 * A Colombian online sale is a *venta a distancia* by *comercio electrónico*
 * (Ley 1480 de 2011 arts. 45 and 49), and the Estatuto del Consumidor puts a
 * specific, enumerable set of duties on the seller. Each numbered section
 * below exists because a rule requires it, not because it rounds out the
 * document:
 *
 *   Ley 1480 art. 50 lit. a) identity: nombre o razón social, NIT, dirección
 *      de notificación judicial, teléfono, correo   -> section 1
 *   art. 50 lit. d) condiciones generales publicadas, accesibles y
 *      descargables antes y después de la transacción; resumen del pedido;
 *      aceptación expresa; acuse de recibo          -> sections 2 and 7
 *   art. 23 + art. 50 lit. b) información cierta, suficiente y actualizada
 *      del producto, con la escala de las imágenes  -> section 4
 *   art. 50 lit. c) precio total con TODOS los impuestos, y los gastos de
 *      envío informados por separado                -> section 5
 *   art. 50 lit. h) disponibilidad, plazo de entrega de treinta (30) días
 *      calendario y resolución del contrato si se incumple
 *                                                   -> sections 6 and 9
 *   art. 46 num. 1 y 4) entrega efectiva en la dirección indicada; informar
 *      el retracto y su término ANTES de comprar    -> sections 9 and 11
 *   art. 47 derecho de retracto: cinco (5) días hábiles, devolución de todo
 *      el dinero sin descuentos en máximo treinta (30) días calendario,
 *      transporte de la devolución a cargo del consumidor, excepciones
 *                                                   -> section 11
 *   art. 51 reversión del pago: solo con instrumento de pago electrónico,
 *      cinco (5) días hábiles, queja al proveedor Y aviso al emisor
 *                                                   -> section 12
 *   arts. 7, 8, 11, 16 garantía legal: calidad e idoneidad, un (1) año para
 *      producto nuevo a falta de plazo anunciado, reparación gratuita ->
 *      reposición -> devolución del dinero, causales de exoneración
 *                                                   -> section 13
 *   art. 50 lit. g) + art. 58 num. 5) canal de PQR con constancia de fecha y
 *      hora, y respuesta en quince (15) días hábiles -> section 14
 *   art. 50 lit. e) prueba de la relación comercial en soporte duradero
 *                                                   -> section 15
 *   Ley 1581 de 2012                                -> section 16
 *
 * The PROVEEDOR is the merchant, never the platform. Art. 50 lit. f) is
 * explicit that the seller answers for security failures of the means they
 * put in place, "sean propios o ajenos" — so this document deliberately does
 * NOT name the platform or route any obligation to it. The "this is a
 * template, you are the one who answers" warning goes to the merchant through
 * `TERMS_DISCLAIMER`, never into the published body, for the same reason the
 * privacy template gives: a shopper reading a caveat about legal advice
 * learns nothing except doubt about who is answerable to them.
 *
 * ## Every promise is checked against what the code does
 *
 * The failure mode for a generated contract is not an empty section, it is a
 * plausible sentence promising something the software does not do. Each claim
 * below is tied to a mechanism:
 *
 *   - "los precios ya incluyen el IVA"  -> docs/SPEC.md §5 (Colombian retail
 *     convention; `Order` stores the tax portion OF the price, it is never
 *     added), rendered as "IVA incluido" in apps/storefront's cart, cart
 *     drawer and checkout. The rates named are the `TaxRate` enum's real
 *     members (0 / 5 / 19 / excluido).
 *   - "el costo de envío se muestra por separado" -> the checkout quote is a
 *     separate line added to the total (checkout.service.ts).
 *   - the shipping options listed ARE `settings.shipping.methods`, only the
 *     `enabled` ones, priced by the same four shapes `ShippingService`
 *     prices (flat / zone / free_over / pickup).
 *   - "le guardamos el inventario quince (15) minutos" -> `STOCK_RESERVATION_MS`
 *     in checkout.service.ts, released by the stock-reservation worker.
 *     Emitted ONLY when the store has an online gateway, because COD orders
 *     hold no reservation at all (`stockReservedUntil` is null for them).
 *   - "antes de despachar un pedido contra entrega lo confirmamos con usted"
 *     -> `confirm` is scoped to COD orders (orders/transitions.ts,
 *     `isBlockedByPendingOnlinePayment`), which is exactly the merchant
 *     phoning the shopper before the order moves on.
 *   - the order states in section 10 are `OrderStatus` as
 *     `ALLOWED_ACTIONS`/`ACTION_TARGET_STATUS` traverse them, in that order.
 *   - "puede consultarlo con el número del pedido y su correo o su teléfono"
 *     -> `OrderTrackingService.track`'s double factor, at /rastrear.
 *   - "los datos de su tarjeta nunca pasan por nuestros sistemas" -> every
 *     provider is a hosted redirect (`createCheckoutSession` returns a
 *     `redirectUrl`; packages/payments).
 *   - "el pago contra entrega no está disponible en ..." -> the departamentos
 *     in `settings.shipping.codRestrictedDepartamentos`, resolved to their
 *     DANE names, which `ShippingService.isCodAllowedIn` actually enforces at
 *     checkout.
 *
 * And, in the other direction, what it refuses to promise:
 *
 *   - No automated refund. `PaymentProvider.refund?` is marked Phase 2 in
 *     docs/SPEC.md §6 M5 and no adapter implements it, so the retracto and
 *     garantía sections say the merchant returns the money — never that a
 *     button does it.
 *   - No invoicing. `Order.billingFields` has no writer and there is no DIAN
 *     integration, so section 15 leaves a visible `[COMPLETAR: ...]` instead
 *     of describing a factura electrónica that does not exist.
 *   - No delivery-time estimate. Nothing in the schema holds one, and a
 *     guessed "2 a 5 días hábiles" in a contract is a term the merchant would
 *     be held to. It is a marker.
 *
 * Those last two mean a FULLY configured store still gets placeholders. That
 * is the difference from the privacy template (where a complete store gets
 * none) and it is deliberate: the alternative is inventing contractual terms.
 *
 * ## Formatting constraint (why there is no markdown syntax below)
 *
 * `TenantContent.bodyMd` is nominally markdown, but the storefront renders it
 * with `bodyMd.split('\n\n').map(p => <p>{p}</p>)`
 * (apps/storefront/components/policy-page.tsx) — no markdown parser. So `##`,
 * `**` and `- ` would all show up literally on a shopper's screen. Every block
 * below is therefore written to read correctly as a plain paragraph, one per
 * blank-line-separated chunk, and section titles are ordinary sentences on
 * their own line.
 *
 * Section NUMBERS are fixed, and every numbered heading is emitted
 * unconditionally even when its content varies — the document cross-refers to
 * "la sección 14" in half a dozen places, and a heading that disappears for
 * some stores would silently renumber those references into lies.
 */

import { DEPARTAMENTOS, type ShippingMethodInput } from '@ventia/core';
import {
  HINT,
  PlaceholderTracker,
  formatCop,
  formatSpanishDate,
  joinEs,
  type GeneratedDocument,
} from './document-template';

/** Payment gateways, keyed exactly as `PaymentProviderId` in
 * packages/payments, with the names a Colombian shopper recognises. Same map
 * as privacy-policy.template.ts's, kept local for the same reason the two
 * `VALID_TYPES` lists are: each document decides for itself which third
 * parties it names. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  wompi: 'Wompi de Bancolombia',
  mercadopago: 'Mercado Pago',
  epayco: 'ePayco',
};

/** Hints unique to this document — things the platform genuinely cannot know
 * about a merchant's business, as opposed to things it has simply not been
 * told yet. */
const TERMS_HINT = {
  deliveryTime:
    'tiempo estimado de entrega, por ejemplo "de 2 a 5 días hábiles en ciudades principales y de 3 a 8 en el resto del país"',
  invoicing: 'cómo entregas la factura electrónica o el documento equivalente y cuándo la recibe el cliente',
  paymentMethods: 'los medios de pago que aceptas',
  shippingOptions: 'las opciones de envío que ofreces y cuánto cuesta cada una',
} as const;

/**
 * Everything the generator can learn about one store. Every optional field is
 * `null`/empty when the platform genuinely does not hold it — see
 * `PlaceholderTracker.fill` for what happens then.
 */
export interface TermsTenantData {
  /** `Tenant.name` — always present. */
  storeName: string;
  /** Primary domain the store is served on, e.g. `mitienda.ventia.co`. */
  domain: string | null;
  /** `settings.storeInfo.contactEmail`. */
  contactEmail: string | null;
  /** `settings.storeInfo.contactPhone`. */
  contactPhone: string | null;
  /** `settings.storeInfo.legalName` — the *proveedor* named in section 1. */
  legalName: string | null;
  /** `settings.storeInfo.taxId` — the NIT art. 50 lit. a) requires. */
  taxId: string | null;
  /** `settings.storeInfo.address`. Doubles as the *dirección de notificación
   * judicial*, which art. 50 lit. a) demands and which this platform has no
   * separate field for. */
  addressLine: string | null;
  /** `settings.storeInfo.municipio`. */
  municipio: string | null;
  /** `settings.storeInfo.departamento`. */
  departamento: string | null;
  /** `settings.payments.codEnabled`. */
  codEnabled: boolean;
  /** `PaymentProviderId`s with saved credentials, in a stable order. */
  paymentProviders: string[];
  /** `settings.shipping.methods`, as `ShippingService.loadConfig` reads them —
   * unvalidated JSON, so this template narrows every field defensively. */
  shippingMethods: ShippingMethodInput[];
  /** `settings.shipping.codRestrictedDepartamentos` — DANE codes, resolved to
   * names here. */
  codRestrictedDepartamentos: string[];
  /** Whether the storefront chat widget is on this plan, so section 14 only
   * offers a channel the shopper can actually use. */
  agentEnabled: boolean;
  /** Whether a WhatsApp number is genuinely connected. */
  whatsappConnected: boolean;
  /** Fecha de entrada en vigencia. Defaults to "today" at the call site. */
  effectiveDate: Date;
}

/** {@link renderTerms}'s result — the shared shape, named for this document. */
export type GeneratedTerms = GeneratedDocument;

/**
 * The one thing the merchant — and only the merchant — must understand before
 * publishing. Returned by the generate endpoint and rendered in the admin UI,
 * never in the published body.
 */
export const TERMS_DISCLAIMER =
  'Este texto es una plantilla generada con los datos de tu tienda, no es asesoría jurídica. ' +
  'El proveedor frente a tus clientes eres tú (el comerciante): tú respondes por lo que aquí se ' +
  'promete, ante el cliente y ante la Superintendencia de Industria y Comercio. Revisa el texto, ' +
  'completa los campos marcados con [COMPLETAR: ...] y ajústalo a cómo funciona realmente tu ' +
  'negocio antes de publicarlo. Ten en cuenta dos cosas: los derechos que la Ley 1480 de 2011 le ' +
  'da al consumidor (retracto, reversión del pago, garantía legal) son mínimos y no puedes ' +
  'reducirlos por contrato — una cláusula que lo intente se tiene por no escrita; y el checkout de ' +
  'tu tienda registra hoy la autorización de datos personales, no una casilla aparte de aceptación ' +
  'de estos términos, así que tu constancia de aceptación es la publicación permanente de esta ' +
  'página más el resumen del pedido que el cliente confirma. Si vendes alimentos, medicamentos, ' +
  'bebidas alcohólicas, productos financiados, servicios de tracto sucesivo o le vendes a menores ' +
  'de edad, consulta a un abogado antes de publicar.';

/** Narrows one entry of the unvalidated `settings.shipping.methods` array to
 * a sentence, or `null` when the entry is malformed enough that no honest
 * sentence can be written about it. Malformed entries are DROPPED rather than
 * described with a guess: an unpriceable method is one `ShippingService`
 * would refuse at checkout anyway (`SHIPPING_METHOD_UNAVAILABLE`), and a
 * shipping price is a contractual term. */
function describeShippingMethod(method: ShippingMethodInput): string | null {
  if (!method || typeof method !== 'object') return null;
  const label = typeof method.label === 'string' ? method.label.trim() : '';
  if (label.length === 0) return null;

  switch (method.type) {
    case 'flat':
      if (typeof method.priceCents !== 'number') return null;
      return `${label}: ${formatCop(method.priceCents)} por pedido.`;
    case 'zone': {
      const fallback =
        typeof method.defaultPriceCents === 'number'
          ? ` Para los departamentos que no tienen tarifa propia, el costo es de ${formatCop(method.defaultPriceCents)}.`
          : '';
      return (
        `${label}: la tarifa depende del departamento al que enviamos y se la mostramos, ya calculada, ` +
        `en el resumen del pedido antes de que usted confirme.${fallback}`
      );
    }
    case 'free_over':
      if (typeof method.thresholdCents !== 'number' || typeof method.fallbackPriceCents !== 'number') return null;
      return (
        `${label}: sin costo de envío cuando los productos de su pedido suman ` +
        `${formatCop(method.thresholdCents)} o más. ` +
        `Por debajo de ese valor, el envío cuesta ${formatCop(method.fallbackPriceCents)}.`
      );
    case 'pickup': {
      const instructions =
        typeof method.instructions === 'string' && method.instructions.trim().length > 0
          ? ` ${method.instructions.trim()}`
          : '';
      return `${label}: usted recoge el pedido y no paga costo de envío.${instructions}`;
    }
    default:
      return null;
  }
}

/**
 * The overall delivery window across every enabled method: the fastest method's
 * floor and the slowest method's ceiling.
 *
 * Callers must have already established that every method has an estimate —
 * summarising a partial set would state a range narrower than the one a shopper
 * can actually end up with, which in a document governed by Ley 1480 is a
 * promise the merchant did not make.
 */
function etaSummary(methods: ShippingMethodInput[]): string {
  const mins = methods.map((m) => m.etaMinDays as number);
  const maxs = methods.map((m) => m.etaMaxDays as number);
  const min = Math.min(...mins);
  const max = Math.max(...maxs);
  if (min === max) return min === 1 ? '1 día hábil' : `${min} días hábiles`;
  return `entre ${min} y ${max} días hábiles`;
}

/**
 * The merchant's own delivery estimate for one method, as a clause that can be
 * appended to that method's sentence — or `null` when they have not given one.
 *
 * Business days, phrased as the shopper will read it. The singular case
 * ("1 día hábil") is spelled out because "entre 1 y 1 días hábiles" is the kind
 * of sentence that makes a legal document look machine-written, which is
 * exactly what undermines it.
 *
 * `shippingMethodSchema` already guarantees the two halves arrive together and
 * in order; the checks here are for shipping settings written before that
 * refinement existed, which are still sitting in `TenantSettings` JSON.
 */
function describeEta(method: ShippingMethodInput): string | null {
  const min = method.etaMinDays;
  const max = method.etaMaxDays;
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  if (min > max) return null;
  if (min === max) return min === 1 ? 'Entrega estimada: 1 día hábil.' : `Entrega estimada: ${min} días hábiles.`;
  return `Entrega estimada: entre ${min} y ${max} días hábiles.`;
}

/**
 * Renders the full términos y condiciones for one store. Pure: same input,
 * same output — no clock, no database, no environment. `effectiveDate` is an
 * input for exactly that reason.
 */
export function renderTerms(data: TermsTenantData): GeneratedTerms {
  const t = new PlaceholderTracker();
  const store = data.storeName.trim();

  const legalName = t.fill(data.legalName, HINT.legalName);
  const taxId = t.fill(data.taxId, HINT.taxId);
  const email = t.fill(data.contactEmail, HINT.contactEmail);
  const phone = t.fill(data.contactPhone, HINT.contactPhone);
  const address = t.fill(data.addressLine, HINT.address);
  const municipio = t.fill(data.municipio, HINT.municipio);
  const departamento = t.fill(data.departamento, HINT.departamento);
  const effective = formatSpanishDate(data.effectiveDate);

  const domain = data.domain?.trim() ?? null;
  const site = domain ? `https://${domain}` : null;
  /** A page on this store, or the single "we don't know your address" marker.
   * Degrading to ONE marker (rather than `[COMPLETAR: ...]/rastrear`) keeps
   * the sentence readable, and the hint dedupes across every call. */
  const pageUrl = (path: string) => (site ? `${site}${path}` : t.fill(null, HINT.site));
  const termsUrl = pageUrl('/terminos-y-condiciones');
  const siteOrMarker = site ?? t.fill(null, HINT.site);

  // "Teléfono o WhatsApp" only when a WhatsApp channel is genuinely connected
  // — same discipline as the privacy template's.
  const phoneLabel = data.whatsappConnected ? 'Teléfono o WhatsApp' : 'Teléfono';
  const byPhone = data.whatsappConnected ? 'por teléfono o WhatsApp' : 'por teléfono';

  const providers = data.paymentProviders.map((id) => PROVIDER_DISPLAY_NAMES[id] ?? id).filter((n) => n.length > 0);
  const hasOnlinePayment = providers.length > 0;

  const enabledMethods = data.shippingMethods.filter((m) => m && m.enabled === true);

  const shippingLines = enabledMethods
    .map((method) => {
      const line = describeShippingMethod(method);
      if (line === null) return null;
      const eta = describeEta(method);
      return eta === null ? line : `${line} ${eta}`;
    })
    .filter((line): line is string => line !== null);

  // The per-method clauses above are the specific answer; this is the summary
  // sentence art. 50 lit. h) expects, and it stays a `[COMPLETAR: …]` when no
  // enabled method carries an estimate — which is the honest outcome, because
  // the platform genuinely does not know how long this merchant takes.
  const deliveryTimeSummary =
    enabledMethods.length > 0 && enabledMethods.every((m) => describeEta(m) !== null)
      ? etaSummary(enabledMethods)
      : null;

  const restrictedNames = data.codRestrictedDepartamentos
    .map((code) => DEPARTAMENTOS.find((d) => d.code === code)?.name ?? null)
    .filter((name): name is string => name !== null);

  const blocks: string[] = [];
  const p = (text: string) => blocks.push(text);

  // ---- Encabezado -------------------------------------------------------
  p(
    `Estos términos y condiciones rigen la compra de productos en ${store} a través de nuestra tienda en ` +
      'línea. Léalos antes de hacer su pedido. Están escritos siguiendo la Ley 1480 de 2011 (Estatuto del ' +
      'Consumidor) y la Ley 527 de 1999 (comercio electrónico), que fijan los derechos mínimos de todo ' +
      'consumidor en Colombia: nada de lo que dice este documento puede reducirlos, y si alguna frase ' +
      'llegara a contradecir esas leyes, se aplica la ley y no la frase.',
  );

  // ---- 1. Identidad del proveedor (art. 50 lit. a) ----------------------
  p('1. Quién le vende');
  p(`Quien le vende es ${legalName}, responsable de la tienda ${store}. Estos son nuestros datos:`);
  p(`Razón social o nombre: ${legalName}`);
  p(`NIT o cédula: ${taxId}`);
  p(`Dirección, domicilio y dirección para notificaciones judiciales: ${address}, ${municipio}, ${departamento}, Colombia`);
  p(`Correo electrónico: ${email}`);
  p(`${phoneLabel}: ${phone}`);
  p(`Tienda en línea: ${siteOrMarker}`);

  // ---- 2. Naturaleza y aceptación (art. 50 lit. d) ----------------------
  p('2. Qué son estos términos y cuándo los acepta');
  p(
    'Estos términos son las condiciones generales del contrato de compraventa entre usted y nosotros. Los ' +
      `mantenemos publicados de forma permanente en ${termsUrl}, donde puede leerlos, imprimirlos y ` +
      'descargarlos antes y después de comprar.',
  );
  p(
    'Antes de terminar la compra le mostramos un resumen del pedido con lo que va a llevar y lo que va a ' +
      'pagar. Al confirmarlo usted acepta ese resumen y, con él, estos términos. Hasta ese momento puede ' +
      'modificar o abandonar el pedido sin ninguna consecuencia.',
  );
  p(
    'Su compra se rige por la versión de estos términos que estaba publicada el día en que usted hizo el ' +
      'pedido. Si los cambiamos después, el cambio no se le aplica a pedidos ya hechos.',
  );

  // ---- 3. Capacidad -----------------------------------------------------
  p('3. Quién puede comprar');
  p(
    'Para comprar en esta tienda usted debe ser mayor de edad y tener capacidad legal para contratar. Los ' +
      'datos que nos entrega — su nombre completo, su teléfono, su correo electrónico y la dirección de ' +
      'entrega con su departamento y municipio — deben ser verdaderos y estar completos: son los que usamos ' +
      'para despacharle y para comunicarnos con usted, y una dirección incompleta o equivocada puede impedir ' +
      'la entrega.',
  );

  // ---- 4. Información del producto (arts. 23 y 50 lit. b) ---------------
  p('4. La información de los productos');
  p(
    'De cada producto publicamos información cierta, clara, suficiente y actualizada: su nombre, su ' +
      'descripción, sus fotografías, su precio y su disponibilidad. Si un producto tiene variantes (talla, ' +
      'color u otra opción), cada una indica su propio precio y su propia disponibilidad.',
  );
  p(
    'Las fotografías son de referencia. El color y el tamaño con que usted las ve dependen de su pantalla, ' +
      'así que las medidas y las características que valen son las que están escritas en la descripción del ' +
      'producto. Si algo no le queda claro, escríbanos antes de comprar por los canales de la sección 14.',
  );

  // ---- 5. Precios e impuestos (art. 50 lit. c, SPEC §5) -----------------
  p('5. Precios, impuestos y costo de envío');
  p(
    'Todos los precios están en pesos colombianos (COP) y ya incluyen el IVA que corresponda a cada ' +
      'producto — 19%, 5%, 0% o excluido de IVA, según lo que la ley disponga para ese bien. El precio que ' +
      'usted ve en el producto y en el carrito es el que paga por ese producto: no le sumamos impuestos al ' +
      'final.',
  );
  p(
    'El costo de envío es un valor aparte del precio de los productos. Se lo informamos por separado y ya ' +
      'sumado al total en el resumen del pedido, antes de que usted confirme, de modo que el total que ve ' +
      'ahí es todo lo que va a pagar.',
  );
  p(
    'Los precios y las promociones pueden cambiar en cualquier momento, pero el precio que rige su compra ' +
      'es el que aparecía en el resumen del pedido cuando usted lo confirmó.',
  );
  p(
    'Si por un error evidente de digitación o de sistema llegáramos a publicar un precio que no corresponde, ' +
      'se lo informaremos antes de despachar; usted decide si confirma la compra al precio correcto o la ' +
      'cancela, y en ese caso le devolvemos todo lo que hubiera pagado sin descuento alguno.',
  );

  // ---- 6. Disponibilidad (art. 50 lit. h) -------------------------------
  p('6. Disponibilidad de los productos');
  p(
    'Mostramos las existencias disponibles de cada producto y solo aceptamos pedidos por lo que tenemos. ' +
      'Si aun así resulta que un producto que usted pidió no está disponible, se lo informamos de inmediato ' +
      'y usted decide: espera a que lo tengamos, lo cambia por otro o cancela el pedido. Si cancela, le ' +
      'devolvemos todo el dinero que haya pagado, sin retenciones ni descuentos, en un plazo máximo de ' +
      'treinta (30) días calendario.',
  );

  // ---- 7. El pedido y su confirmación (art. 50 lit. d) ------------------
  p('7. Cómo se hace un pedido y cómo se lo confirmamos');
  p(
    'Para comprar, agregue los productos al carrito y complete el formulario de pago con sus datos de ' +
      'contacto, su dirección de entrega, la opción de envío y el medio de pago. Antes de terminar le ' +
      'mostramos el resumen del pedido con cada producto, su cantidad, su precio individual, el costo de ' +
      'envío y el total a pagar.',
  );
  // WHEN the acuse de recibo goes out differs by payment method, and the
  // difference is real: `sendOrderEmails` fires at order creation only on the
  // `cod` branch of checkout.service.ts, while an online order's confirmation
  // is sent by `markPaid` when the gateway webhook settles. Saying both to a
  // store that offers only one would describe a flow that store never runs.
  const whenConfirmed =
    data.codEnabled && hasOnlinePayment
      ? ' En los pedidos con pago contra entrega la enviamos apenas recibimos el pedido; en los pedidos con ' +
        'pago en línea, apenas la pasarela nos confirma el pago.'
      : data.codEnabled
        ? ' La enviamos apenas recibimos el pedido.'
        : hasOnlinePayment
          ? ' La enviamos apenas la pasarela nos confirma el pago.'
          : '';
  p(
    'Al confirmar le mostramos en pantalla el número de su pedido y le enviamos la confirmación al correo ' +
      `electrónico que registró.${whenConfirmed} Guarde el número del pedido: con él y con su correo o su ` +
      `teléfono puede consultar el estado de su compra cuando quiera en ${pageUrl('/rastrear')}.`,
  );

  // ---- 8. Medios de pago ------------------------------------------------
  p('8. Medios de pago');
  if (hasOnlinePayment) {
    p(
      `Puede pagar en línea a través de ${joinEs(providers)}. El pago se hace directamente en la plataforma ` +
        'de la pasarela: los datos de su tarjeta o de su cuenta se digitan allí, nunca pasan por nuestros ' +
        'sistemas y nosotros no los almacenamos.',
    );
    p(
      'Mientras se confirma un pago en línea le reservamos las existencias de su pedido durante quince (15) ' +
        'minutos. Si el pago no se completa dentro de ese tiempo, liberamos las existencias y el pedido ' +
        'queda cancelado; usted puede volver a hacerlo cuando quiera, sujeto a la disponibilidad de ese ' +
        'momento.',
    );
  }
  if (data.codEnabled) {
    p(
      'También puede pagar contra entrega: usted paga el valor total del pedido en el momento en que lo ' +
        'recibe, directamente a quien se lo entrega. Antes de despachar un pedido contra entrega lo ' +
        `confirmamos con usted ${byPhone}, así que déjenos un número donde podamos ubicarlo; si no logramos ` +
        'confirmarlo, el pedido no se despacha.',
    );
    if (restrictedNames.length > 0) {
      // One per line above two, rather than `joinEs`: several DANE
      // departamento names contain their own "y" ("San Andrés, Providencia y
      // Santa Catalina"), and "en San Andrés, Providencia y Santa Catalina y
      // Amazonas" reads as four places instead of two. A list cannot be
      // misparsed, and this document already lists the shipping options the
      // same way.
      const alternative = hasOnlinePayment
        ? 'el formulario de pago no le ofrecerá esa opción y podrá pagar en línea.'
        : 'el formulario de pago no le ofrecerá esa opción y tendremos que acordar otro medio de pago con usted.';
      if (restrictedNames.length === 1) {
        p(
          `El pago contra entrega no está disponible para entregas en ${restrictedNames[0]}. Si su dirección ` +
            `de entrega queda allí, ${alternative}`,
        );
      } else {
        p('El pago contra entrega no está disponible para entregas en estos departamentos:');
        for (const name of restrictedNames) p(name);
        p(`Si su dirección de entrega queda en alguno de ellos, ${alternative}`);
      }
    }
  }
  if (!hasOnlinePayment && !data.codEnabled) {
    p(`Medios de pago que aceptamos: ${t.fill(null, TERMS_HINT.paymentMethods)}.`);
  }

  // ---- 9. Envíos y entrega (arts. 46 num. 1 y 50 lit. h) ----------------
  p('9. Envíos y entrega');
  if (shippingLines.length > 0) {
    p('Estas son las opciones de envío que puede elegir al momento de pagar:');
    for (const line of shippingLines) p(line);
  } else {
    p(`Opciones de envío y su costo: ${t.fill(null, TERMS_HINT.shippingOptions)}.`);
  }
  p(
    'Entregamos en la dirección que usted nos indique al momento de pagar, dentro del departamento y el ' +
      'municipio que seleccione. Nos aseguramos de que la entrega se haga efectivamente en esa dirección y ' +
      'de que la reciba usted o la persona que usted autorice.',
  );
  p(`Tiempo estimado de entrega: ${t.fill(deliveryTimeSummary, TERMS_HINT.deliveryTime)}.`);
  p(
    'En todo caso, y salvo que hayamos pactado expresamente otra cosa con usted, le entregamos su pedido a ' +
      'más tardar dentro de los treinta (30) días calendario siguientes al día en que lo hizo. Si no ' +
      'alcanzamos a entregárselo dentro de ese plazo, usted puede terminar el contrato y le devolvemos todo ' +
      'el dinero que haya pagado, sin retención ni descuento alguno, en un plazo máximo de treinta (30) ' +
      'días calendario.',
  );
  p(
    'Cuando despachamos su pedido le informamos la transportadora y el número de guía, y ese dato queda ' +
      'visible en la consulta de su pedido. Si no logramos entregárselo porque la dirección está incompleta ' +
      'o equivocada, o porque no fue posible ubicarlo, nos comunicamos con usted para reprogramar la ' +
      'entrega.',
  );

  // ---- 10. Estados del pedido (orders/transitions.ts) -------------------
  p('10. En qué estado está su pedido');
  p(
    `Su pedido pasa por los siguientes estados, que puede consultar en ${pageUrl('/rastrear')} con el número ` +
      'del pedido y el correo o el teléfono con el que compró:',
  );
  // "contra entrega" must not appear in a store that does not offer it — the
  // shopper would be told to expect a confirmation call that never comes, and
  // `PENDING -> CONFIRMED` for an online order is driven by the gateway
  // webhook, not by us phoning anyone (orders/transitions.ts's
  // `isBlockedByPendingOnlinePayment`).
  if (data.codEnabled && hasOnlinePayment) {
    p('Pendiente: recibimos su pedido y estamos esperando el pago en línea o la confirmación del pedido con usted.');
    p('Confirmado: el pago quedó registrado, o usted nos confirmó el pedido contra entrega.');
  } else if (data.codEnabled) {
    p('Pendiente: recibimos su pedido y estamos esperando confirmarlo con usted.');
    p('Confirmado: usted nos confirmó el pedido y lo vamos a despachar.');
  } else {
    p('Pendiente: recibimos su pedido y estamos esperando la confirmación de su pago.');
    p('Confirmado: el pago quedó registrado y su pedido sigue adelante.');
  }
  p('En preparación: estamos alistando y empacando sus productos.');
  p('Enviado: entregamos el pedido a la transportadora. Aquí verá la transportadora y el número de guía.');
  p('Entregado: el pedido llegó a la dirección de entrega.');
  p(
    'Cancelado: el pedido no continúa, y los productos vuelven a quedar disponibles. Si usted ya había ' +
      'pagado, le devolvemos el dinero.',
  );

  // ---- 11. Retracto (art. 47) -------------------------------------------
  p('11. Su derecho de retracto');
  p(
    'Como usted nos compra por internet, la suya es una venta a distancia y por eso tiene derecho de ' +
      'retracto: puede arrepentirse de la compra sin explicarnos por qué y sin pagar ninguna sanción, tal ' +
      'como lo dispone el artículo 47 de la Ley 1480 de 2011.',
  );
  p(
    'El plazo es de cinco (5) días hábiles contados desde el día en que usted recibe el producto. Dentro de ' +
      'ese plazo debe avisarnos que se retracta, por cualquiera de los canales de la sección 14.',
  );
  p(
    'Para que el retracto proceda, usted debe devolvernos el producto por los mismos medios y en las mismas ' +
      'condiciones en que lo recibió. Los costos de transporte y los demás gastos que implique devolverlo ' +
      'los asume usted.',
  );
  p(
    'Recibido el producto, le devolvemos en dinero todas las sumas que haya pagado, sin hacer descuentos ni ' +
      'retenciones por ningún concepto. Esa devolución no puede tardar más de treinta (30) días calendario ' +
      'contados desde el momento en que usted ejerció el derecho.',
  );
  if (data.codEnabled) {
    p(
      'Si usted pagó contra entrega, el derecho de retracto le aplica exactamente igual: haber pagado en el ' +
        'momento de recibir no le quita a la compra su carácter de venta a distancia. Como en ese caso no ' +
        'hubo un pago electrónico que reversar, le devolvemos el dinero por el medio que acordemos con ' +
        'usted — consignación, transferencia o efectivo — dentro del mismo plazo de treinta (30) días ' +
        'calendario.',
    );
  }
  p(
    'El retracto no aplica en los casos que excluye el propio artículo 47. En una tienda como la nuestra ' +
      'los que pueden presentarse son: los productos hechos o personalizados conforme a especificaciones ' +
      'suyas; los productos que por su naturaleza no pueden devolverse o que se deterioran o vencen ' +
      'rápidamente; los bienes perecederos; y los artículos de uso personal. Cuando un producto nuestro esté ' +
      'en alguno de esos casos, lo advertimos en su descripción antes de que usted lo compre.',
  );

  // ---- 12. Reversión del pago (art. 51) ---------------------------------
  p('12. Reversión del pago');
  p(
    'Si pagó con tarjeta de crédito, tarjeta débito, PSE, una billetera digital o cualquier otro ' +
      'instrumento de pago electrónico, además del retracto usted tiene derecho a pedir la reversión del ' +
      'pago, conforme al artículo 51 de la Ley 1480 de 2011, cuando fue víctima de fraude, cuando la ' +
      'operación no fue solicitada por usted, cuando no recibió el producto, cuando el producto que recibió ' +
      'no corresponde al que pidió, o cuando le llegó defectuoso.',
  );
  p(
    'Para que la reversión proceda, dentro de los cinco (5) días hábiles siguientes a que usted se enteró ' +
      'del hecho — o a la fecha en que debía haber recibido el producto — tiene que hacer dos cosas: ' +
      'presentarnos la queja a nosotros por los canales de la sección 14 y, además, notificarle la ' +
      'reclamación al banco o a la entidad que emitió el medio de pago que usó. Cuando sea procedente, debe ' +
      'devolvernos el producto.',
  );
  p(
    'Cumplido eso, nosotros y los demás participantes del proceso de pago procedemos a reversar la ' +
      'transacción. Si más adelante una autoridad judicial o administrativa resuelve la controversia a ' +
      'favor nuestro, el emisor del medio de pago podrá volver a cargarle el valor; si la resuelve a favor ' +
      'suyo, la reversión queda en firme.',
  );
  if (data.codEnabled) {
    p(
      'Esta reversión no aplica cuando usted pagó contra entrega en efectivo, porque no hubo un instrumento ' +
        'de pago electrónico que reversar. En ese caso siguen intactos su derecho de retracto (sección 11) ' +
        'y su garantía legal (sección 13), y cualquier devolución de dinero la hacemos nosotros ' +
        'directamente.',
    );
  }

  // ---- 13. Garantía legal (arts. 7, 8, 11, 16 y 58 num. 5) --------------
  p('13. Garantía legal');
  p(
    'Todo lo que le vendemos tiene garantía legal: respondemos por la calidad, la idoneidad, la seguridad y ' +
      'el buen estado y funcionamiento de los productos, en los términos de los artículos 7 y siguientes de ' +
      'la Ley 1480 de 2011. La garantía legal no se cobra aparte y no depende de que usted registre el ' +
      'producto en ningún lado.',
  );
  p(
    'Salvo que en la descripción del producto anunciemos un plazo mayor, la garantía es de un (1) año para ' +
      'productos nuevos, contado desde el día en que usted recibe el producto. En los productos perecederos, ' +
      'la garantía va hasta la fecha de vencimiento.',
  );
  p(
    'Si el producto sale defectuoso, lo reparamos gratis, incluido el transporte que la reparación ' +
      'requiera. Si el producto no admite reparación, se lo reponemos o le devolvemos el dinero. Y si la ' +
      'falla se repite, usted elige: una nueva reparación, el cambio del producto por otro igual o de ' +
      'características similares, o la devolución total o parcial de lo que pagó.',
  );
  p(
    'La garantía no cubre los daños causados por el uso indebido del producto, por no atender las ' +
      'instrucciones de uso o de instalación, por intervenciones o reparaciones hechas por terceros no ' +
      'autorizados, por fuerza mayor o caso fortuito, ni el desgaste normal derivado del uso.',
  );
  p(
    'Para hacer efectiva la garantía escríbanos por los canales de la sección 14, indicando el número de su ' +
      'pedido y qué le pasó al producto, y póngalo a nuestra disposición. Le respondemos por escrito y de ' +
      'forma sustentada dentro de los quince (15) días hábiles siguientes a que recibamos su reclamación.',
  );

  // ---- 14. PQR (art. 50 lit. g) -----------------------------------------
  p('14. Peticiones, quejas y reclamos');
  p('Puede escribirnos, para cualquier asunto, por estos canales:');
  p(`Correo electrónico: ${email}`);
  p(`${phoneLabel}: ${phone}`);
  if (data.agentEnabled) {
    p('Chat de nuestra tienda en línea, disponible en todas las páginas.');
  }
  p(
    'Cualquiera de estos canales deja constancia de la fecha y la hora en que usted radicó su solicitud, y ' +
      'por ese mismo canal le hacemos seguimiento y le damos la respuesta. Respondemos toda reclamación ' +
      'dentro de los quince (15) días hábiles siguientes a haberla recibido.',
  );

  // ---- 15. Soporte de la transacción y facturación (art. 50 lit. e) -----
  p('15. Constancia de su compra y facturación');
  p(
    'Conservamos el registro de cada compra — quién la hizo, qué llevó, cuánto pagó, con qué medio de pago ' +
      'y cuándo se entregó — como soporte de nuestra relación comercial y para atender cualquier ' +
      'reclamación posterior suya.',
  );
  p(`Sobre la factura: ${t.fill(null, TERMS_HINT.invoicing)}.`);

  // ---- 16. Datos personales ---------------------------------------------
  p('16. Sus datos personales');
  p(
    'Los datos que usted nos entrega para comprar los tratamos conforme a la Ley 1581 de 2012 y a nuestra ' +
      `política de tratamiento de datos personales, publicada en ${pageUrl('/privacidad')}. Allí encuentra ` +
      'qué datos recogemos, para qué los usamos, con quién los compartimos y cómo puede conocerlos, ' +
      'actualizarlos, rectificarlos, pedir que los eliminemos o revocar la autorización que nos dio.',
  );

  // ---- 17. Propiedad intelectual ----------------------------------------
  p('17. Contenido de la tienda y uso del sitio');
  p(
    'Los textos, las fotografías, los logotipos, las marcas y el diseño de esta tienda son nuestros o los ' +
      'usamos con autorización de su titular, y no pueden reproducirse con fines comerciales sin nuestro ' +
      'permiso escrito. Usted se compromete a usar la tienda de buena fe, sin intentar afectar su ' +
      'funcionamiento ni acceder a información de otros clientes.',
  );

  // ---- 18. Cambios -------------------------------------------------------
  p('18. Cambios en estos términos');
  p(
    'Podemos modificar estos términos cuando cambien nuestros productos, nuestra operación o la ley. La ' +
      `versión vigente estará siempre publicada en ${termsUrl}, con la fecha desde la cual rige. Como dice ` +
      'la sección 2, los pedidos que usted ya haya hecho se rigen por la versión publicada ese día.',
  );

  // ---- 19. Ley aplicable -------------------------------------------------
  p('19. Ley aplicable y cómo resolvemos un desacuerdo');
  p(
    'Estos términos se rigen por la ley colombiana, en especial por la Ley 1480 de 2011 y por la Ley 527 de ' +
      '1999, y por las normas que las modifiquen o reglamenten. Ninguna parte de este documento puede ' +
      'entenderse como una renuncia suya a los derechos que esas normas le reconocen.',
  );
  p(
    'Si tiene un problema con su compra, preséntenos primero la reclamación por los canales de la sección ' +
      '14: la ley exige haber agotado ese trámite con nosotros antes de acudir a la autoridad. Si no queda ' +
      'conforme con nuestra respuesta, puede acudir a la Superintendencia de Industria y Comercio, que ' +
      'atiende las quejas de los consumidores y tramita la acción de protección al consumidor.',
  );

  // ---- 20. Vigencia ------------------------------------------------------
  p('20. Vigencia');
  p(
    `Estos términos y condiciones rigen a partir del ${effective} y reemplazan cualquier versión anterior ` +
      `publicada por ${store}.`,
  );

  return {
    title: 'Términos y condiciones',
    bodyMd: blocks.join('\n\n'),
    placeholders: t.hints,
  };
}
