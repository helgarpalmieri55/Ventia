/**
 * The es-CO *política de tratamiento de datos personales* template required by
 * docs/SPEC.md §9 ("per-tenant privacy policy template (autofilled with store
 * data)"), rendered from one tenant's own configuration.
 *
 * ## What this is, legally
 *
 * Under Ley 1581 de 2012 (Habeas Data) and its reglamento — Decreto 1377 de
 * 2013, compiled into Decreto 1074 de 2015 — every Responsable del Tratamiento
 * must have a written política de tratamiento, in plain language, made known
 * to the Titulares. Art. 2.2.2.25.3.1 of Decreto 1074 fixes the MINIMUM
 * contents, and this template hits each one in order:
 *
 *   1. Nombre o razón social, domicilio, dirección, correo electrónico y
 *      teléfono del Responsable            -> section 1
 *   2. Tratamiento al cual serán sometidos los datos y su finalidad
 *                                          -> sections 2 and 3
 *   3. Derechos que le asisten al Titular (Ley 1581 art. 8: conocer,
 *      actualizar, rectificar, SUPRIMIR, revocar la autorización, prueba de
 *      la autorización, acceso gratuito, quejas ante la SIC)
 *                                          -> section 6
 *   4. Persona o área responsable de atender peticiones, consultas y reclamos
 *                                          -> section 7
 *   5. Procedimiento para ejercer esos derechos (con los plazos de los arts.
 *      14 y 15: consulta 10 días hábiles + 5; reclamo 15 días hábiles + 8, y
 *      el requisito de procedibilidad del art. 16 antes de acudir a la SIC)
 *                                          -> section 7
 *   6. Fecha de entrada en vigencia de la política y período de vigencia de la
 *      base de datos                       -> sections 8 and 12
 *
 * The RESPONSABLE is the merchant, never the platform: the platform is an
 * Encargado del Tratamiento acting on the merchant's instructions (Ley 1581
 * art. 3 lit. d). That distinction is surfaced to the merchant in the admin UI
 * (see `PRIVACY_POLICY_DISCLAIMER`), deliberately NOT inside the published
 * body, where a shopper reading "this is a template, not legal advice" would
 * only be confused about who is answerable to them. The answer to that
 * question, on the page, must be: this store.
 *
 * ## What it says about data, and why every claim is checkable
 *
 * Nothing here is generic filler. Every category in section 2 and every
 * recipient in section 5 corresponds to something this codebase actually does:
 *
 *   - name / email / phone / departamento / municipio / dirección /
 *     complemento / barrio / notas  -> `checkoutAddressSchema`
 *     (packages/core/src/address-schemas.ts) + `Order.email` / `Order.phone`
 *     (parsed in services/api/src/checkout/checkout.controller.ts)
 *   - order history, totals               -> `Order`, `OrderItem`, `Customer`
 *     (`ordersCount`, `totalSpentCents`) in packages/db/prisma/schema.prisma
 *   - conversations, incl. the WhatsApp number a shopper writes from
 *                                         -> `Conversation` / `Message`
 *   - cart cookie                         -> `ventia_cart`, see
 *     services/api/src/checkout/cart-cookie.guard.ts
 *   - payment gateways get the order, not us the card: every provider issues a
 *     redirect (`createCheckoutSession(): Promise<{ redirectUrl: string }>` in
 *     packages/payments/src/index.ts), so no card number ever reaches this
 *     system — which is why section 2 says so explicitly.
 *   - transactional email through a third party -> Resend
 *     (services/api/src/mailer/mailer.module.ts)
 *   - agent messages processed by an AI provider -> Anthropic
 *     (services/api/src/agent/agent.module.ts)
 *   - human escalation, when the plan includes it -> Chatwoot
 *     (services/api/src/chatwoot/*, gated on `humanHandoff`)
 *
 * Conversely, `Order.billingFields` (documento / razón social for DIAN
 * invoicing) exists in the schema but has no writer yet, so the template does
 * NOT claim to collect it. Same discipline in reverse: sections about the AI
 * agent, WhatsApp and human handoff are emitted only for tenants that actually
 * have those channels on.
 *
 * ## Formatting constraint (why there is no markdown syntax below)
 *
 * `TenantContent.bodyMd` is nominally markdown, but the storefront renders it
 * with `bodyMd.split('\n\n').map(p => <p>{p}</p>)`
 * (apps/storefront/components/policy-page.tsx) — no markdown parser. So `##`,
 * `**` and `- ` would all show up literally on a shopper's screen. Every block
 * below is therefore written to read correctly as a plain paragraph, one per
 * blank-line-separated chunk, and section titles are ordinary sentences on
 * their own line. If a real markdown renderer is added later this still
 * renders sanely; the reverse would not have been true.
 */

/** Product name of the platform this store runs on. Named in the policy
 * because a shopper is entitled to know who stores their data on the
 * merchant's behalf (the Encargado del Tratamiento), and because the merchant
 * cannot honestly claim to hold it all themselves. */
const PLATFORM_NAME = 'Ventia';

/** Payment gateways, keyed exactly as `PaymentProviderId` in
 * packages/payments, with the names a Colombian shopper recognises. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  // "Wompi de Bancolombia", not "Wompi (Bancolombia)": every use site already
  // sits inside a parenthetical, and nested parens read badly in prose.
  wompi: 'Wompi de Bancolombia',
  mercadopago: 'Mercado Pago',
  epayco: 'ePayco',
};

/**
 * Everything the generator can learn about one store. Every optional field is
 * `null` when the platform genuinely does not hold it — see `fill()` for what
 * happens then.
 */
export interface PrivacyPolicyTenantData {
  /** `Tenant.name` — always present. */
  storeName: string;
  /** Primary domain the store is served on, e.g. `mitienda.ventia.co`. */
  domain: string | null;
  /** `settings.storeInfo.contactEmail`. */
  contactEmail: string | null;
  /** `settings.storeInfo.contactPhone`. */
  contactPhone: string | null;
  /** Razón social / legal name of the merchant. Not collected by the store
   * settings form today, hence usually null -> placeholder. */
  legalName: string | null;
  /** NIT or cédula of the merchant. Not collected today -> placeholder. */
  taxId: string | null;
  /** Street address of the merchant's domicilio. Not collected today. */
  addressLine: string | null;
  /** Municipio of the merchant's domicilio. Not collected today. */
  municipio: string | null;
  /** Departamento of the merchant's domicilio. Not collected today. */
  departamento: string | null;
  /** `settings.payments.codEnabled` — contra entrega changes what section 3
   * has to say about handing an address to a delivery person. */
  codEnabled: boolean;
  /** `PaymentProviderId`s with saved credentials, in a stable order. */
  paymentProviders: string[];
  /** Whether this store's plan includes the AI agent at all. */
  agentEnabled: boolean;
  /** `agentConfig.agentName`, when the merchant named their agent. */
  agentName: string | null;
  /** Whether a WhatsApp number is actually connected (not merely allowed). */
  whatsappConnected: boolean;
  /** Whether escalation to a human agent (Chatwoot) is on this plan. */
  humanHandoffEnabled: boolean;
  /** Fecha de entrada en vigencia. Defaults to "today" at the call site. */
  effectiveDate: Date;
}

export interface GeneratedPrivacyPolicy {
  /** Suggested `TenantContent.title`. */
  title: string;
  /** Suggested `TenantContent.bodyMd`. */
  bodyMd: string;
  /**
   * Human-readable list of the `[COMPLETAR: ...]` markers the merchant still
   * has to fill in, so the admin UI can show a checklist instead of making
   * them hunt through the text. Empty for a fully-configured store.
   */
  placeholders: string[];
}

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * "19 de agosto de 2026", in Colombian civil time.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat('es-CO')` for two reasons: the
 * output must not depend on the Node build's ICU data (a `small-icu` runtime
 * would silently produce English), and the date must be Colombia's, not the
 * server's. Colombia is UTC-5 year-round with no DST, so a fixed offset is
 * exact here rather than an approximation.
 */
function formatSpanishDate(date: Date): string {
  const bogota = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  return `${bogota.getUTCDate()} de ${MONTHS_ES[bogota.getUTCMonth()]} de ${bogota.getUTCFullYear()}`;
}

/** Collects `[COMPLETAR: ...]` markers as the document is built. */
class PlaceholderTracker {
  readonly hints: string[] = [];

  /**
   * The value, or a loud, self-explanatory marker in its place.
   *
   * The whole point is that a missing field NEVER produces `undefined`, an
   * empty gap, or — worst of all — a sentence that silently reads as a
   * complete legal statement while missing the fact that made it one. A
   * merchant scanning the generated text has to be able to see what is still
   * theirs to write.
   */
  fill(value: string | null | undefined, hint: string): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length > 0) return trimmed;
    if (!this.hints.includes(hint)) this.hints.push(hint);
    return `[COMPLETAR: ${hint}]`;
  }
}

/** Joins a list the way Spanish does: "a, b y c". */
function joinEs(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * The one thing the merchant — and only the merchant — must understand before
 * publishing. Returned by the generate endpoint and rendered in the admin UI,
 * never in the published body.
 */
export const PRIVACY_POLICY_DISCLAIMER =
  'Este texto es una plantilla generada con los datos de tu tienda, no es asesoría jurídica. ' +
  'Frente a tus clientes, el Responsable del Tratamiento eres tú (el comerciante), no ' +
  `${PLATFORM_NAME}: ${PLATFORM_NAME} actúa como Encargado del Tratamiento y solo trata los datos ` +
  'por cuenta tuya. Revisa el texto, completa los campos marcados con [COMPLETAR: ...] y ' +
  'ajústalo a cómo funciona realmente tu negocio antes de publicarlo. Si manejas datos sensibles, ' +
  'datos de menores de edad o bases de datos que deban inscribirse en el Registro Nacional de ' +
  'Bases de Datos de la SIC, consulta a un abogado.';

/**
 * Renders the full policy for one store. Pure: same input, same output — no
 * clock, no database, no environment. `effectiveDate` is an input for exactly
 * that reason.
 */
export function renderPrivacyPolicy(data: PrivacyPolicyTenantData): GeneratedPrivacyPolicy {
  const t = new PlaceholderTracker();
  const store = data.storeName.trim();

  const legalName = t.fill(data.legalName, 'razón social o nombre completo del titular de la tienda');
  const taxId = t.fill(data.taxId, 'NIT o número de cédula');
  const email = t.fill(data.contactEmail, 'correo electrónico de contacto de la tienda');
  const phone = t.fill(data.contactPhone, 'teléfono o WhatsApp de contacto');
  const address = t.fill(data.addressLine, 'dirección del domicilio del negocio');
  const municipio = t.fill(data.municipio, 'municipio del domicilio');
  const departamento = t.fill(data.departamento, 'departamento del domicilio');
  const domain = data.domain?.trim() ?? null;
  const site = domain ? `https://${domain}` : t.fill(null, 'dirección web de la tienda');
  const effective = formatSpanishDate(data.effectiveDate);

  // "nuestro asistente virtual Sofía" reads badly; "Sofía, nuestro asistente
  // virtual" reads right — and an unnamed agent is just "nuestro asistente
  // virtual", never a dangling comma. "Asistente" rather than "asesor" because
  // it is epicene: merchants name these agents anything, and "Sofía, nuestro
  // asesor virtual" jars in a way "nuestro asistente virtual" does not. Only
  // ever used inside `agentEnabled` branches.
  const agentName = data.agentName?.trim() ?? '';
  const agentPhrase = agentName.length > 0 ? `${agentName}, nuestro asistente virtual` : 'nuestro asistente virtual';

  const providers = data.paymentProviders
    .map((id) => PROVIDER_DISPLAY_NAMES[id] ?? id)
    .filter((name) => name.length > 0);

  const blocks: string[] = [];
  const p = (text: string) => blocks.push(text);

  // ---- Encabezado -------------------------------------------------------
  p(
    `En ${store} tratamos los datos personales de nuestros clientes con responsabilidad. Este documento ` +
      'explica qué información recogemos cuando usted nos compra o nos escribe, para qué la usamos, con ' +
      'quién la compartimos y cómo puede conocerla, actualizarla, rectificarla o pedir que la eliminemos. ' +
      'Lo escribimos siguiendo la Ley 1581 de 2012 (Habeas Data), el Decreto 1074 de 2015 y el artículo 15 ' +
      'de la Constitución Política.',
  );

  // ---- 1. Responsable ---------------------------------------------------
  p('1. Quién responde por sus datos');
  p(
    `El Responsable del Tratamiento de sus datos personales es ${legalName}, propietario de la tienda ` +
      `${store}. Estos son nuestros datos de contacto:`,
  );
  p(`Razón social o nombre: ${legalName}`);
  p(`NIT o cédula: ${taxId}`);
  p(`Domicilio: ${address}, ${municipio}, ${departamento}, Colombia`);
  p(`Correo electrónico: ${email}`);
  p(`Teléfono${data.whatsappConnected ? ' o WhatsApp' : ''} de contacto: ${phone}`);
  p(`Tienda en línea: ${site}`);
  p(
    `Nuestra tienda funciona sobre la plataforma de comercio electrónico ${PLATFORM_NAME}, que almacena y ` +
      'procesa la información por cuenta nuestra y siguiendo nuestras instrucciones. En los términos de la ' +
      `Ley 1581 de 2012, ${PLATFORM_NAME} es Encargado del Tratamiento y nosotros seguimos siendo los ` +
      'Responsables frente a usted.',
  );

  // ---- 2. Datos recogidos ----------------------------------------------
  p('2. Qué datos personales recogemos');
  p('Recogemos únicamente los datos que necesitamos para venderle, entregarle y atenderle:');
  p(
    'Datos de identificación y contacto: su nombre completo, su correo electrónico y su número de teléfono ' +
      'o celular.',
  );
  p(
    'Datos de entrega: el departamento, el municipio, la dirección, el complemento (apartamento, torre, ' +
      'oficina), el barrio y las indicaciones que usted nos deje para llegar a su casa o a su oficina.',
  );
  p(
    'Datos de sus compras: los productos y cantidades que pide, el valor de su pedido (los precios incluyen ' +
      'IVA), el medio de pago que elige, el estado de cada pedido y el historial de las compras que nos ha ' +
      'hecho.',
  );

  if (data.agentEnabled || data.whatsappConnected) {
    const canales = data.whatsappConnected
      ? 'el chat de nuestra tienda en línea y nuestro WhatsApp'
      : 'el chat de nuestra tienda en línea';
    p(
      `Conversaciones: guardamos los mensajes que usted intercambia con nosotros por ${canales}, junto con ` +
        'la fecha y la hora. ' +
        (data.whatsappConnected
          ? 'Cuando usted nos escribe por WhatsApp, guardamos también el número desde el cual escribe. '
          : '') +
        'Los conservamos para darle continuidad a su conversación, resolver reclamos y mejorar nuestra ' +
        'atención.',
    );
  }

  p(
    'Datos técnicos: una cookie en su navegador que identifica su carrito de compras para que no pierda lo ' +
      'que ya agregó. No la usamos para publicidad ni para seguirlo por otros sitios.',
  );
  p(
    'No le pedimos datos sensibles (origen racial o étnico, convicciones políticas o religiosas, ' +
      'afiliación sindical, datos de salud, datos biométricos o información sobre su vida sexual) y le ' +
      'agradecemos no enviárnoslos. Tampoco almacenamos los números de sus tarjetas débito o crédito: ' +
      'cuando usted paga en línea, los datos de la tarjeta se digitan directamente en la pasarela de pagos ' +
      'y nunca pasan por nuestros sistemas.',
  );

  // ---- 3. Finalidades ---------------------------------------------------
  p('3. Para qué usamos sus datos');
  p('Tratamos sus datos personales con estas finalidades y no con otras distintas:');
  p('Procesar su pedido: confirmarlo, prepararlo, facturarlo y entregarlo en la dirección que nos indique.');
  p(
    'Comunicarnos con usted sobre su compra: confirmación del pedido, estado del pago, despacho, número de ' +
      'guía y entrega, por correo electrónico, teléfono o WhatsApp.',
  );
  p(
    providers.length > 0
      ? `Gestionar el pago: enviar a ${providers.length > 1 ? 'las pasarelas' : 'la pasarela'} de pago ` +
          `(${joinEs(providers)}) los datos necesarios para ` +
          'procesar y verificar su transacción.' +
          (data.codEnabled
            ? ' Si elige pago contra entrega, entregamos sus datos de envío a quien realiza la entrega para ' +
              'recaudar el valor del pedido.'
            : '')
      : data.codEnabled
        ? 'Gestionar el pago contra entrega: entregar sus datos de envío a quien realiza la entrega para ' +
          'recaudar el valor del pedido.'
        : 'Gestionar el pago de su pedido con el medio de pago que usted elija.',
  );
  p('Atender sus preguntas, peticiones, quejas, reclamos y solicitudes de garantía, cambio o devolución.');

  if (data.agentEnabled) {
    p(
      `Atenderlo con ${agentPhrase}: responder sus preguntas sobre productos, precios, disponibilidad, ` +
        'envíos y el estado de sus pedidos.',
    );
  }

  p(
    'Llevar el historial de nuestra relación comercial y nuestros registros contables, y cumplir las ' +
      'obligaciones legales, tributarias y comerciales que nos exigen conservar información sobre las ' +
      'ventas que hacemos.',
  );
  p(
    'No vendemos ni alquilamos sus datos personales, y no los usamos para enviarle publicidad de terceros. ' +
      'Si en algún momento queremos enviarle información comercial de nuestra propia tienda, se lo ' +
      'preguntaremos primero y usted podrá decir que no en cualquier momento.',
  );

  // ---- 4. Autorización --------------------------------------------------
  p('4. Cómo obtenemos su autorización');
  p(
    'Usted nos autoriza a tratar sus datos personales cuando completa un pedido en nuestra tienda en ' +
      (data.whatsappConnected ? 'línea, cuando nos escribe por WhatsApp o cuando nos ' : 'línea o cuando nos ') +
      'entrega sus datos para atender una solicitud suya. Antes de hacerlo puede leer esta política, que ' +
      `está publicada de forma permanente en ${site}.`,
  );
  p(
    'Su autorización es voluntaria: usted no está obligado a darnos datos sensibles ni datos de niñas, ' +
      'niños o adolescentes. Puede revocarla en cualquier momento por los canales de la sección 7, ' +
      'teniendo en cuenta que sin los datos mínimos de contacto y de entrega no podemos despachar un ' +
      'pedido ni cumplir un contrato ya celebrado con usted.',
  );

  // ---- 5. Terceros ------------------------------------------------------
  p('5. Con quién compartimos sus datos');
  p(
    'Compartimos sus datos únicamente con quienes nos ayudan a cumplir las finalidades de la sección 3, y ' +
      'solo con la información que cada uno necesita:',
  );
  p(
    `La plataforma ${PLATFORM_NAME}, que opera esta tienda en línea y almacena de forma segura los pedidos, ` +
      'los datos de contacto y las conversaciones, actuando como Encargado del Tratamiento por cuenta ' +
      'nuestra.',
  );
  if (providers.length > 0) {
    p(
      `Las pasarelas de pago con las que trabajamos (${joinEs(providers)}), que reciben los datos ` +
        'necesarios para procesar su pago y que son responsables del tratamiento de la información ' +
        'financiera que usted digita directamente en sus plataformas.',
    );
  }
  p(
    'La empresa de transporte, la mensajería o la persona que realiza la entrega, a quien entregamos su ' +
      'nombre, su teléfono y su dirección para poder llevarle el pedido.',
  );
  p(
    'El proveedor de correo electrónico transaccional que utilizamos para enviarle la confirmación de su ' +
      'pedido y las notificaciones sobre su estado.',
  );
  if (data.agentEnabled) {
    p(
      'El proveedor de inteligencia artificial (Anthropic) que procesa el texto de su conversación para ' +
        `generar las respuestas de ${agentPhrase}. Le pedimos no escribir en el chat datos sensibles ni ` +
        'números de tarjetas.',
    );
  }
  if (data.whatsappConnected) {
    p(
      'El proveedor del canal de WhatsApp a través del cual usted nos escribe, que transmite y entrega los ' +
        'mensajes.',
    );
  }
  if (data.humanHandoffEnabled) {
    p(
      'La herramienta de atención al cliente que usamos cuando su conversación pasa del chat automático a ' +
        'una persona de nuestro equipo, y que recibe el resumen de lo que usted nos escribió.',
    );
  }
  p(
    'Las autoridades administrativas o judiciales que nos lo soliciten en ejercicio de sus funciones, y ' +
      'nuestro contador o revisor fiscal para efectos tributarios y contables.',
  );
  p(
    'Algunos de estos proveedores prestan sus servicios desde fuera de Colombia, por lo que al autorizar ' +
      'esta política usted autoriza también la transmisión internacional de sus datos a dichos ' +
      'proveedores, quienes están obligados contractualmente a tratarlos únicamente conforme a nuestras ' +
      'instrucciones y a esta política.',
  );

  // ---- 6. Derechos ------------------------------------------------------
  p('6. Sus derechos como titular de los datos');
  p(
    'Como titular de sus datos personales, la Ley 1581 de 2012 le garantiza los siguientes derechos, que ' +
      'puede ejercer gratuitamente:',
  );
  p('Conocer qué datos suyos tenemos y cómo los estamos usando.');
  p('Actualizarlos y rectificarlos cuando estén desactualizados, incompletos o equivocados.');
  p(
    'Solicitar la supresión (eliminación) de sus datos cuando no exista un deber legal o contractual que ' +
      'nos obligue a conservarlos.',
  );
  p(
    'Revocar la autorización que nos dio para tratarlos, en los mismos términos y con las mismas ' +
      'excepciones del punto anterior.',
  );
  p('Solicitar prueba de la autorización que usted nos otorgó, salvo en los casos que la ley exceptúa.');
  p('Ser informado, cuando lo solicite, sobre el uso que le hemos dado a sus datos personales.');
  p('Acceder de forma gratuita a los datos suyos que estemos tratando.');
  p(
    'Presentar quejas ante la Superintendencia de Industria y Comercio (SIC) por infracciones a la ley, ' +
      'después de haber agotado el trámite de consulta o reclamo ante nosotros.',
  );

  // ---- 7. Procedimiento -------------------------------------------------
  p('7. Cómo ejercer sus derechos');
  p(
    'La atención de peticiones, consultas y reclamos sobre datos personales está a cargo del propietario ' +
      `de ${store}, quien puede ser contactado en los siguientes canales:`,
  );
  p(`Correo electrónico: ${email}`);
  p(`Teléfono${data.whatsappConnected ? ' o WhatsApp' : ''}: ${phone}`);
  p(
    'Para atenderlo, por favor indíquenos su nombre completo, su documento de identidad, el correo o el ' +
      'teléfono con el que nos compró, una descripción clara de lo que solicita y los documentos que ' +
      'quiera hacer valer. Si su solicitud está incompleta, le pediremos que la complete dentro de los ' +
      'cinco (5) días hábiles siguientes; si pasan dos (2) meses sin que recibamos la información, ' +
      'entenderemos que desistió.',
  );
  p(
    'Las consultas (por ejemplo, "díganme qué datos míos tienen") las respondemos en un máximo de diez ' +
      '(10) días hábiles contados desde que las recibimos. Si no alcanzamos, se lo informamos explicando ' +
      'por qué y le damos una nueva fecha, que no pasará de cinco (5) días hábiles más.',
  );
  p(
    'Los reclamos (por ejemplo, corregir, actualizar o suprimir un dato, o revocar la autorización) los ' +
      'atendemos en un máximo de quince (15) días hábiles contados desde el día siguiente a su recibo. Si ' +
      'no alcanzamos, se lo informamos explicando por qué y le damos una nueva fecha, que no pasará de ' +
      'ocho (8) días hábiles más. Mientras el reclamo está en curso, marcamos su registro como "reclamo ' +
      'en trámite".',
  );
  p(
    'Si no está conforme con nuestra respuesta, puede acudir a la Superintendencia de Industria y ' +
      'Comercio. La ley exige haber agotado antes este trámite con nosotros.',
  );

  // ---- 8. Conservación --------------------------------------------------
  p('8. Por cuánto tiempo conservamos sus datos');
  p(
    'Conservamos sus datos personales mientras dure nuestra relación comercial y, después, durante los ' +
      'términos que nos exige la ley para los libros y papeles del comerciante y para nuestras ' +
      'obligaciones tributarias.',
  );
  p(
    'Cuando usted solicita la supresión de sus datos y no hay un pedido en curso, eliminamos su nombre, ' +
      'su correo, su teléfono, su dirección y sus conversaciones, y conservamos únicamente el registro ' +
      'contable de las compras (fechas y valores) sin información que permita identificarlo, porque ese ' +
      'registro respalda nuestra contabilidad y no puede eliminarse.',
  );

  // ---- 9. Seguridad -----------------------------------------------------
  p('9. Cómo protegemos su información');
  p(
    'Su información viaja cifrada entre su navegador y nuestra tienda, se almacena en una base de datos ' +
      'con acceso restringido y separada de la de otras tiendas, y solo pueden consultarla las personas de ' +
      'nuestro equipo que la necesitan para atenderlo, con usuario y contraseña propios. Aun así, ningún ' +
      'sistema es infalible: si llegara a ocurrir un incidente que afecte sus datos, se lo informaremos y ' +
      'daremos aviso a la autoridad competente.',
  );

  // ---- 10. Menores ------------------------------------------------------
  p('10. Datos de niñas, niños y adolescentes');
  p(
    'Nuestra tienda está dirigida a personas mayores de edad y no recolectamos deliberadamente datos de ' +
      'menores de edad. Si un padre, madre o representante legal advierte que un menor nos entregó sus ' +
      'datos, puede escribirnos a los canales de la sección 7 y los eliminaremos.',
  );

  // ---- 11. Cambios ------------------------------------------------------
  p('11. Cambios en esta política');
  p(
    'Podemos actualizar esta política cuando cambien nuestros servicios o la ley. Publicaremos siempre la ' +
      `versión vigente en ${site} e indicaremos la fecha desde la cual rige. Si el cambio afecta la ` +
      'finalidad del tratamiento, se lo informaremos antes de aplicarlo y, cuando la ley lo exija, le ' +
      'pediremos una nueva autorización.',
  );

  // ---- 12. Vigencia -----------------------------------------------------
  p('12. Vigencia');
  p(
    `Esta política de tratamiento de datos personales rige a partir del ${effective}. Nuestras bases de ` +
      'datos permanecerán vigentes mientras se mantengan las finalidades descritas en la sección 3 y ' +
      'mientras subsistan las obligaciones legales de conservación mencionadas en la sección 8.',
  );

  return {
    title: 'Política de tratamiento de datos personales',
    bodyMd: blocks.join('\n\n'),
    placeholders: t.hints,
  };
}
