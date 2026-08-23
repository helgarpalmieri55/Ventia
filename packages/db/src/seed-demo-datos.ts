/**
 * Los DATOS de la tienda de demostración, separados de quien los escribe
 * (`seed-demo.ts`).
 *
 * Están aparte por un motivo práctico: son lo único de la demo que se ve en
 * cámara. Un precio absurdo, una categoría vacía o un "lorem ipsum" obligan a
 * repetir la toma, y eso se puede comprobar sin base de datos —
 * `test/seed-demo.test.ts` valida todo lo de aquí contra los MISMOS esquemas
 * de Zod que usa la API cuando un comerciante guarda el formulario. Si un dato
 * no pasaría por el panel, no entra en la demo.
 *
 * La tienda es ficticia pero coherente: una tostaduría de café de Medellín,
 * con precios en pesos de verdad, IVA del 5 % en el café tostado (partida
 * 09.01) y del 19 % en los accesorios, envíos y devoluciones redactados según
 * la Ley 1480 de 2011, y un catálogo del tamaño que tiene un negocio así.
 */

import { readFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// La configuración compartida con los simuladores
// ---------------------------------------------------------------------------

export interface ConfigDemo {
  tienda: { id: string; slug: string; nombre: string; plan: 'emprende' | 'crece' | 'escala'; dominio: string };
  duena: { email: string; nombre: string; clave: string };
  instagram: {
    proveedor: 'graph';
    igAccountId: string;
    pageId: string;
    usuario: string;
    token: string;
    appSecret: string;
    verifyToken: string;
    compradorIgsid: string;
    compradorNombre: string;
  };
  whatsapp: {
    proveedor: 'cloud';
    externalId: string;
    wabaId: string;
    telefonoVisible: string;
    telefonoMeta: string;
    token: string;
    appSecret: string;
    verifyToken: string;
    compradorTelefono: string;
    compradorNombre: string;
  };
  urls: { api: string; apiPublica: string; admin: string; tienda: string };
  fotos: { prefijo: string; laminas: { slug: string; titulo: string }[] };
}

/**
 * Lee `scripts/demo/demo.json`.
 *
 * La ruta relativa funciona igual desde `src/` (con tsx) y desde `dist/` (tras
 * `tsc`) porque las dos están al mismo nivel dentro de `packages/db`. Es un
 * archivo JSON leído en tiempo de ejecución y no un `import`, precisamente
 * para que esa equivalencia se mantenga sin depender de cómo resuelva el
 * empaquetador.
 *
 * Se lee de allí y no se define aquí porque los simuladores de webhook
 * (`scripts/demo/*.mjs`) necesitan los MISMOS secretos: el app secret con el
 * que firman tiene que ser el que este seed cifra en `credentialsEnc`. Dos
 * copias del mismo secreto es la forma más barata de que la demo falle sin
 * ningún mensaje de error — una firma que no cuadra recibe un 200 igual que
 * una que sí.
 */
export function cargarConfigDemo(): ConfigDemo {
  const url = new URL('../../../scripts/demo/demo.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ConfigDemo;
}

// ---------------------------------------------------------------------------
// Cifrado de credenciales
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM con el formato EXACTO que lee
 * `services/api/src/payments/encryption.ts#decrypt`:
 * `base64(iv):base64(tag):base64(ciphertext)`, IV de 12 bytes.
 *
 * Está reescrito aquí y no importado porque `@ventia/db` no puede depender de
 * `services/api` (la dependencia va al revés). Es el único trozo duplicado de
 * toda la demo, y por eso `test/seed-demo.test.ts` comprueba el formato campo
 * a campo: si se desviara, las credenciales de WhatsApp e Instagram quedarían
 * ilegibles y el webhook se rechazaría por firma sin decir por qué.
 */
export function cifrar(textoPlano: string, llave: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', llave, iv);
  const cifrado = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), cifrado.toString('base64')].join(':');
}

/**
 * La llave de `PAYMENTS_ENCRYPTION_KEY`, con el mismo mensaje de error que da
 * la API. Falla en el seed, que es donde alguien lo está mirando, en vez de
 * más tarde al descifrar dentro de un webhook que nadie ve.
 */
export function cargarLlave(entorno: NodeJS.ProcessEnv = process.env): Buffer {
  const crudo = entorno.PAYMENTS_ENCRYPTION_KEY;
  if (!crudo) throw new Error('PAYMENTS_ENCRYPTION_KEY no está definida');
  const llave = Buffer.from(crudo, 'base64');
  if (llave.length !== 32) {
    throw new Error(
      `PAYMENTS_ENCRYPTION_KEY tiene que decodificar en base64 a exactamente 32 bytes (son ${llave.length})`,
    );
  }
  return llave;
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

/** Los valores de tarifa tal y como los acepta la API (`TAX_RATES` de
 * `@ventia/core`). El seed los traduce al miembro del enum de Prisma. */
export type TarifaIva = '0' | '5' | '19' | 'excluido';

export interface CategoriaDemo {
  slug: string;
  nombre: string;
  /** Slug de la categoría padre, o `null` si es de primer nivel. */
  padre: string | null;
  posicion: number;
}

export interface VarianteDemo {
  opcion1: string;
  sku: string;
  stock: number;
  /** Sobrescribe el precio del producto. Sin esto, la variante hereda. */
  precio?: number;
}

export interface ProductoDemo {
  slug: string;
  nombre: string;
  /** En PESOS enteros. El seed multiplica por 100 para llegar a `priceCents`. */
  precio: number;
  /** Precio tachado. Solo donde hay una rebaja de verdad. */
  precioAntes?: number;
  /** Costo del comerciante, en pesos. Alimenta el margen del panel. */
  costo: number;
  sku: string;
  stock: number;
  iva: TarifaIva;
  categoria: string;
  descripcion: string;
  /** Etiquetas de las opciones de variante, máximo 3. */
  opciones?: string[];
  variantes?: VarianteDemo[];
  seo?: { title: string; description: string };
}

export const CATEGORIAS: CategoriaDemo[] = [
  { slug: 'cafe', nombre: 'Café', padre: null, posicion: 0 },
  { slug: 'origen-unico', nombre: 'Origen único', padre: 'cafe', posicion: 0 },
  { slug: 'mezclas', nombre: 'Mezclas de la casa', padre: 'cafe', posicion: 1 },
  { slug: 'accesorios', nombre: 'Accesorios de preparación', padre: null, posicion: 1 },
  { slug: 'kits', nombre: 'Kits y regalos', padre: null, posicion: 2 },
];

const MOLIENDAS = ['En grano', 'Molido para prensa', 'Molido para filtro', 'Molido para espresso'];

/** Cuatro variantes de molienda con el mismo precio, que es como se vende el
 * café: la molienda no cuesta más, solo hay que decir cuál. */
function moliendas(prefijoSku: string, stocks: [number, number, number, number]): VarianteDemo[] {
  const sufijos = ['GR', 'PR', 'FL', 'ES'];
  return MOLIENDAS.map((opcion1, i) => ({ opcion1, sku: `${prefijoSku}-${sufijos[i]}`, stock: stocks[i] }));
}

export const PRODUCTOS: ProductoDemo[] = [
  {
    slug: 'cafe-narino-el-mirador-340g',
    nombre: 'Café Nariño — Finca El Mirador 340 g',
    precio: 46900,
    costo: 21500,
    sku: 'LC-NAR-340',
    stock: 48,
    iva: '5',
    categoria: 'origen-unico',
    descripcion:
      'Lavado, de la vereda El Mirador en Buesaco, Nariño. Cultivado entre 1.850 y 2.000 msnm por la familia Chamorro, y tostado aquí en El Poblado cada martes.\n\n**En taza:** panela, mandarina y un final a nuez. Acidez media-alta, cuerpo sedoso.\n\n**Variedad:** Caturra · **Proceso:** lavado, secado al sol 18 días · **Tueste:** medio\n\nLo empacamos con válvula desgasificadora y le ponemos la fecha de tueste en la bolsa. Rinde para unas 24 tazas.',
    opciones: ['Molienda'],
    variantes: moliendas('LC-NAR-340', [20, 10, 12, 6]),
    seo: {
      title: 'Café Nariño Finca El Mirador 340 g | Tostaduría La Cumbre',
      description: 'Café lavado de Buesaco, Nariño. Panela, mandarina y nuez. Tostado en Medellín cada semana.',
    },
  },
  {
    slug: 'cafe-huila-pitalito-340g',
    nombre: 'Café Huila — Pitalito 340 g',
    precio: 42900,
    costo: 19800,
    sku: 'LC-HUI-340',
    stock: 62,
    iva: '5',
    categoria: 'origen-unico',
    descripcion:
      'De Pitalito, Huila, a 1.700 msnm. El más equilibrado de la casa y el que recomendamos a quien está empezando.\n\n**En taza:** caramelo, naranja dulce y chocolate con leche. Acidez media, cuerpo redondo.\n\n**Variedad:** Castillo · **Proceso:** lavado · **Tueste:** medio\n\nAguanta bien la leche, así que funciona igual de bien en greca que en prensa.',
    opciones: ['Molienda'],
    variantes: moliendas('LC-HUI-340', [26, 14, 14, 8]),
  },
  {
    slug: 'cafe-antioquia-jardin-340g',
    nombre: 'Café Antioquia — Jardín 340 g',
    precio: 39900,
    costo: 18200,
    sku: 'LC-ANT-340',
    stock: 35,
    iva: '5',
    categoria: 'origen-unico',
    descripcion:
      'De Jardín, a tres horas de la tostaduría. Lo compramos directamente a don Hernán Ospina, que nos vende desde 2021.\n\n**En taza:** panela, almendra y cacao. Acidez baja, cuerpo alto.\n\n**Variedad:** Colombia · **Proceso:** lavado · **Tueste:** medio-oscuro\n\nEs el que más se pide para greca y para tinto de la tarde.',
    opciones: ['Molienda'],
    variantes: moliendas('LC-ANT-340', [15, 8, 7, 5]),
  },
  {
    slug: 'mezcla-la-cumbre',
    nombre: 'Mezcla La Cumbre',
    precio: 52900,
    costo: 24000,
    sku: 'LC-MEZ-500',
    stock: 40,
    iva: '5',
    categoria: 'mezclas',
    descripcion:
      'Nuestra mezcla de todos los días: 60 % Huila y 40 % Antioquia. La armamos para que sepa igual todo el año, aunque cambien las cosechas.\n\n**En taza:** chocolate, panela y un toque cítrico al final.\n\nLa presentación de 1 kg es la que se llevan las oficinas y las cafeterías.',
    opciones: ['Presentación'],
    variantes: [
      { opcion1: '500 g', sku: 'LC-MEZ-500', stock: 28 },
      { opcion1: '1 kg', sku: 'LC-MEZ-1000', stock: 12, precio: 98900 },
    ],
  },
  {
    slug: 'descafeinado-tolima-340g',
    nombre: 'Descafeinado Tolima 340 g',
    precio: 48900,
    costo: 23400,
    sku: 'LC-DES-340',
    stock: 22,
    iva: '5',
    categoria: 'mezclas',
    descripcion:
      'Descafeinado por el método del agua (sin solventes), en Manizales. Conserva mucho más sabor del que la gente espera de un descafeinado.\n\n**En taza:** cacao, panela y frutos secos. Cuerpo medio.\n\nEs el que se llevan quienes toman café después de las 6 p. m.',
    opciones: ['Molienda'],
    variantes: moliendas('LC-DES-340', [9, 5, 5, 3]),
  },
  {
    slug: 'prensa-francesa-600ml',
    nombre: 'Prensa francesa 600 ml',
    precio: 89900,
    costo: 46000,
    sku: 'LC-ACC-PRE600',
    stock: 18,
    iva: '19',
    categoria: 'accesorios',
    descripcion:
      'Vidrio borosilicado y filtro de acero inoxidable. 600 ml, que son tres tazas.\n\nEs la forma más sencilla de preparar buen café en casa: no necesita filtros de papel ni báscula. Va con una guía impresa de proporciones.',
  },
  {
    slug: 'molino-manual-ceramica',
    nombre: 'Molino manual de cerámica',
    precio: 165000,
    precioAntes: 189000,
    costo: 92000,
    sku: 'LC-ACC-MOL01',
    stock: 9,
    iva: '19',
    categoria: 'accesorios',
    descripcion:
      'Muelas de cerámica, cuerpo de acero y 18 puntos de ajuste, de prensa francesa a espresso.\n\nMoler justo antes de preparar es lo que más cambia el sabor de una taza, más que el café que uno compre. Si va a llevar un solo accesorio, que sea este.',
  },
  {
    slug: 'greca-italiana-6-tazas',
    nombre: 'Greca italiana 6 tazas',
    precio: 78500,
    costo: 39000,
    sku: 'LC-ACC-GRE06',
    stock: 24,
    iva: '19',
    categoria: 'accesorios',
    descripcion:
      'Aluminio fundido, 6 tazas (unos 300 ml). Apta para estufa de gas y eléctrica; no para inducción.\n\nUse molienda para greca, más gruesa que la de espresso, y no apriete el café.',
  },
  {
    slug: 'filtro-v60-mas-100-filtros',
    nombre: 'Filtro V60 + 100 filtros de papel',
    precio: 64900,
    costo: 31000,
    sku: 'LC-ACC-V60',
    stock: 15,
    iva: '19',
    categoria: 'accesorios',
    descripcion:
      'Cono de plástico tritán (no se rompe) del tamaño 02, con 100 filtros de papel blanqueado.\n\nEs el método que mejor deja ver las notas de un café de origen. Va con la receta que usamos en la barra: 22 g de café, 360 g de agua a 93 °C, en tres vertidos.',
  },
  {
    slug: 'taza-ceramica-la-cumbre-300ml',
    nombre: 'Taza de cerámica La Cumbre 300 ml',
    precio: 34900,
    costo: 15500,
    sku: 'LC-ACC-TAZ300',
    stock: 46,
    iva: '19',
    categoria: 'accesorios',
    descripcion:
      'Gres esmaltado, hecha a mano en un taller de Carmen de Viboral. 300 ml, apta para lavavajillas y microondas.\n\nCada una sale con pequeñas diferencias de color: es cerámica de taller, no de fábrica.',
  },
  {
    slug: 'kit-primer-origen',
    nombre: 'Kit Primer Origen',
    precio: 129900,
    precioAntes: 154700,
    costo: 62000,
    sku: 'LC-KIT-PRIM',
    stock: 12,
    iva: '19',
    categoria: 'kits',
    descripcion:
      'Todo lo necesario para empezar: el filtro V60 con 100 filtros de papel, la bolsa de Nariño 340 g y la bolsa de Huila 340 g.\n\nVa en caja de regalo con la guía de preparación. Si es para regalo, escríbanos por WhatsApp y le ponemos una tarjeta con su mensaje, sin costo.',
  },
  {
    slug: 'caja-regalo-tres-origenes',
    nombre: 'Caja Regalo Tres Orígenes',
    precio: 159900,
    costo: 76000,
    sku: 'LC-KIT-TRES',
    stock: 8,
    iva: '19',
    categoria: 'kits',
    descripcion:
      'Tres bolsas de 250 g —Nariño, Huila y Antioquia— y una taza de cerámica de Carmen de Viboral, en caja de madera.\n\nEs el regalo corporativo que más nos piden en diciembre. Desde 10 cajas hacemos precio y le ponemos el logo de la empresa en la tarjeta.',
  },
];

export interface ColeccionDemo {
  slug: string;
  nombre: string;
  descripcion: string;
  posicion: number;
  /** Slugs de producto, EN EL ORDEN en que se muestran. */
  productos: string[];
}

export const COLECCIONES: ColeccionDemo[] = [
  {
    slug: 'los-mas-pedidos',
    nombre: 'Los más pedidos',
    descripcion: 'Lo que más sale de la tostaduría, semana tras semana.',
    posicion: 0,
    productos: ['cafe-narino-el-mirador-340g', 'mezcla-la-cumbre', 'prensa-francesa-600ml', 'cafe-huila-pitalito-340g'],
  },
  {
    slug: 'para-regalar',
    nombre: 'Para regalar',
    descripcion: 'Cajas y kits que salen listos, con tarjeta y sin costo adicional de empaque.',
    posicion: 1,
    productos: ['kit-primer-origen', 'caja-regalo-tres-origenes', 'taza-ceramica-la-cumbre-300ml', 'molino-manual-ceramica'],
  },
];

// ---------------------------------------------------------------------------
// Configuración de la tienda
// ---------------------------------------------------------------------------

export const INFO_TIENDA = {
  category: 'Alimentos y bebidas',
  contactEmail: 'hola@lacumbre.co',
  contactPhone: '+57 300 214 8890',
  description:
    'Tostaduría de café colombiano de origen en Medellín. Compramos directo a las fincas, tostamos cada semana y despachamos a todo el país.',
  legalName: 'Tostaduría La Cumbre S.A.S.',
  taxId: '901.456.789-3',
  address: 'Carrera 43A #18-95, local 204, El Poblado',
  municipio: 'Medellín',
  departamento: 'Antioquia',
} as const;

/** `Tenant.settings.shipping`, con la forma que valida `shippingSettingsSchema`. */
export const ENVIOS = {
  methods: [
    {
      id: 'medellin',
      type: 'flat' as const,
      label: 'Domicilio en Medellín y Área Metropolitana',
      priceCents: 8_000_00,
      enabled: true,
      etaMinDays: 1,
      etaMaxDays: 2,
    },
    {
      id: 'nacional',
      type: 'free_over' as const,
      label: 'Envío nacional',
      thresholdCents: 120_000_00,
      fallbackPriceCents: 12_000_00,
      enabled: true,
      etaMinDays: 2,
      etaMaxDays: 5,
    },
    {
      id: 'recoger',
      type: 'pickup' as const,
      label: 'Recoger en la tostaduría',
      instructions:
        'Carrera 43A #18-95, local 204, El Poblado, Medellín. Lunes a sábado de 8:00 a. m. a 6:00 p. m. Le avisamos por WhatsApp cuando su pedido esté listo, normalmente el mismo día.',
      enabled: true,
      etaMinDays: 0,
      etaMaxDays: 1,
    },
  ],
  // Amazonía y Orinoquía: las transportadoras no ofrecen contraentrega allí.
  codRestrictedDepartamentos: ['91', '94', '95', '97', '99', '88'],
};

/** `Tenant.agentConfig`. Los dos resúmenes van tal cual al prompt del sistema,
 * así que están escritos como se los diría el comerciante a una persona nueva
 * en el mostrador — y dentro del tope de 600 caracteres que impone
 * `agentSettingsSchema`. */
export const AGENTE = {
  agentName: 'Manuela',
  tone: 'cercano' as const,
  storeSummary:
    'Tostaduría La Cumbre tuesta café colombiano de origen en Medellín desde 2019. Compramos directo a fincas de Nariño, Huila y Antioquia, tostamos cada martes y viernes, y ponemos la fecha de tueste en cada bolsa. Vendemos café en grano o molido (prensa, filtro, espresso), accesorios de preparación y kits de regalo. Atendemos en el local de El Poblado, por WhatsApp e Instagram, y despachamos a todo el país.',
  policiesSummary:
    'Envío gratis desde $120.000. Medellín y Área Metropolitana $8.000 (1 a 2 días hábiles); resto del país $12.000 (2 a 5 días hábiles). También se puede recoger en el local. Aceptamos tarjeta, PSE, Nequi y contraentrega, salvo en Amazonía, Orinoquía y San Andrés. Retracto dentro de los 5 días hábiles siguientes a la entrega, con el producto sin abrir. Las bolsas de café abiertas no se cambian por sanidad, pero si el café llegó en mal estado lo reponemos.',
};

export interface ContenidoDemo {
  tipo: 'faq' | 'policy_shipping' | 'policy_returns' | 'policy_privacy' | 'policy_terms' | 'about';
  titulo: string;
  cuerpo: string;
}

export const CONTENIDOS: ContenidoDemo[] = [
  {
    tipo: 'policy_shipping',
    titulo: 'Envíos',
    cuerpo: `## A dónde despachamos

A todo el territorio nacional, con Coordinadora y Servientrega.

## Cuánto cuesta

| Destino | Costo | Tiempo |
| --- | --- | --- |
| Medellín y Área Metropolitana | $8.000 | 1 a 2 días hábiles |
| Resto del país | $12.000 | 2 a 5 días hábiles |
| Pedidos desde $120.000 | Gratis | según destino |

También puede recoger sin costo en el local: Carrera 43A #18-95, local 204, El Poblado.

## Cuándo sale su pedido

Despachamos de lunes a viernes. Los pedidos confirmados antes de las 2:00 p. m. salen el mismo día; los de después, al día hábil siguiente. Sábados, domingos y festivos no hay despacho.

Tostamos martes y viernes. Si pide un café que se acabó de agotar, se lo despachamos con el tueste de la semana y se lo avisamos antes por WhatsApp.

## Seguimiento

Al despachar le enviamos el número de guía por correo y por WhatsApp. También puede consultarlo en la página de rastreo con el número de su pedido.

## Zonas sin contraentrega

Las transportadoras no ofrecen pago contraentrega en Amazonas, Guainía, Guaviare, Vaupés, Vichada ni San Andrés. A esos destinos sí despachamos, pero con el pago hecho por anticipado.`,
  },
  {
    tipo: 'policy_returns',
    titulo: 'Cambios y devoluciones',
    cuerpo: `## Retracto (5 días hábiles)

De acuerdo con el artículo 47 de la Ley 1480 de 2011, usted puede retractarse de su compra dentro de los **cinco (5) días hábiles** siguientes a la entrega, sin tener que dar explicaciones. El producto debe estar sin usar y en su empaque original, y el transporte de devolución corre por su cuenta. Devolvemos el 100 % del valor pagado dentro de los treinta (30) días calendario siguientes a recibirlo.

## Bolsas de café abiertas

Por sanidad no recibimos devoluciones de bolsas de café ya abiertas. Es la única excepción y la decimos de frente.

**Si el café llegó mal** —bolsa rota, tueste vencido, sabor defectuoso— eso no es un retracto, es un producto con defecto: escríbanos con una foto dentro de los 8 días siguientes y le reponemos la bolsa o le devolvemos el dinero, como usted prefiera. No tiene que devolver el café.

## Garantía de los accesorios

Los accesorios tienen garantía de **seis (6) meses** por defectos de fabricación, contados desde la entrega (Ley 1480, artículos 7 a 11). Cubre fallas de fábrica; no cubre roturas por caída ni desgaste normal de uso.

## Cómo se pide

Escríbanos a hola@lacumbre.co o por WhatsApp al +57 300 214 8890 con el número de su pedido. Le respondemos el mismo día hábil y le indicamos a dónde enviar el producto.`,
  },
  {
    tipo: 'about',
    titulo: 'Contacto',
    cuerpo: `## Dónde estamos

**Tostaduría La Cumbre**
Carrera 43A #18-95, local 204
El Poblado, Medellín, Antioquia

## Horarios

- Lunes a viernes: 8:00 a. m. – 7:00 p. m.
- Sábados: 9:00 a. m. – 5:00 p. m.
- Domingos y festivos: cerrado

## Cómo contactarnos

- WhatsApp: +57 300 214 8890 *(es el más rápido)*
- Correo: hola@lacumbre.co
- Instagram: [@tostaduria.lacumbre](https://instagram.com/tostaduria.lacumbre)

Contestamos los mensajes de lunes a sábado en horario de local. Fuera de ese horario le responde Manuela, nuestra asistente, y si necesita algo que requiera a una persona nos lo pasa a primera hora.

## Datos de la empresa

Tostaduría La Cumbre S.A.S. — NIT 901.456.789-3`,
  },
  {
    tipo: 'faq',
    titulo: 'Preguntas frecuentes',
    cuerpo: `**¿Cada cuánto tuestan?**
Martes y viernes. En cada bolsa va impresa la fecha de tueste.

**¿Cuánto dura el café?**
En grano y con la bolsa cerrada, hasta 3 meses desde el tueste. Ya molido, entre 2 y 3 semanas. Guárdelo en un lugar seco y oscuro, nunca en la nevera.

**¿Me lo pueden moler?**
Sí, sin costo. Al agregar el producto elija la molienda: prensa, filtro o espresso. Si no está seguro, díganos con qué prepara y nosotros elegimos.

**¿Cuánto café uso por taza?**
Unos 15 g por cada 250 ml de agua. Una bolsa de 340 g rinde para unas 22 a 24 tazas.

**¿Hacen envíos el mismo día?**
En Medellín, sí, si el pedido queda confirmado antes de las 2:00 p. m. de lunes a viernes.

**¿Venden al por mayor?**
Sí, desde 5 kg al mes para cafeterías, restaurantes y oficinas, con precio de mayorista y despacho programado. Escríbanos a hola@lacumbre.co.

**¿Puedo recoger en el local?**
Sí, sin costo, en Carrera 43A #18-95, local 204, El Poblado. Le avisamos por WhatsApp cuando esté listo.

**¿Aceptan Nequi?**
Sí: tarjeta, PSE, Nequi y contraentrega (esta última no está disponible en Amazonas, Guainía, Guaviare, Vaupés, Vichada ni San Andrés).

**¿Hacen regalos corporativos?**
Sí. Desde 10 cajas hacemos precio especial y ponemos el logo de la empresa en la tarjeta. Pídalo con dos semanas de anticipación.`,
  },
  {
    tipo: 'policy_privacy',
    titulo: 'Política de tratamiento de datos personales',
    cuerpo: `## 1. Responsable del tratamiento

**Tostaduría La Cumbre S.A.S.**, NIT 901.456.789-3, con domicilio en Carrera 43A #18-95, local 204, El Poblado, Medellín, Antioquia. Correo: hola@lacumbre.co. Teléfono: +57 300 214 8890.

## 2. Datos que recogemos

Nombre, documento cuando la facturación lo exige, correo, teléfono, dirección de entrega e historial de pedidos. Cuando usted nos escribe por WhatsApp o por Instagram guardamos también el contenido de esa conversación, porque es lo que nos permite retomarla y resolver un reclamo.

## 3. Para qué los usamos

Para procesar y entregar sus pedidos, cobrarlos, atender sus preguntas y reclamos, cumplir obligaciones contables y tributarias, y —solo si usted lo autoriza aparte— enviarle novedades de la tostaduría.

## 4. Con quién los compartimos

Con la transportadora que entrega su pedido, con la pasarela de pagos que procesa el cobro y con la plataforma de comercio que opera esta tienda. Cada una recibe únicamente lo que necesita para su parte. No vendemos ni cedemos datos personales a terceros con fines publicitarios.

## 5. Sus derechos

Conforme a la Ley 1581 de 2012 usted puede conocer, actualizar y rectificar sus datos, pedir prueba de la autorización que otorgó, ser informado del uso que les hemos dado, presentar quejas ante la Superintendencia de Industria y Comercio y solicitar la supresión de sus datos cuando no exista un deber legal de conservarlos.

## 6. Cómo ejercerlos

Escriba a hola@lacumbre.co indicando su nombre, su solicitud y un dato de contacto. Respondemos consultas en máximo diez (10) días hábiles y reclamos en máximo quince (15) días hábiles, según los artículos 14 y 15 de la Ley 1581 de 2012.

## 7. Vigencia

Sus datos se conservan mientras dure la relación comercial y durante el tiempo que exijan las obligaciones legales, contables y tributarias aplicables.`,
  },
  {
    tipo: 'policy_terms',
    titulo: 'Términos y condiciones',
    cuerpo: `## 1. Quién vende

Esta tienda es operada por **Tostaduría La Cumbre S.A.S.**, NIT 901.456.789-3, con domicilio en Carrera 43A #18-95, local 204, El Poblado, Medellín, Antioquia. Correo: hola@lacumbre.co. Teléfono: +57 300 214 8890.

## 2. Precios

Todos los precios están en pesos colombianos (COP) e incluyen los impuestos aplicables: 5 % de IVA en el café tostado y 19 % en los accesorios. El costo de envío se calcula y se muestra en el checkout antes de confirmar. El precio que rige es el que aparece al momento de confirmar el pedido.

## 3. Cómo se perfecciona la compra

Su pedido queda confirmado cuando recibe el correo de confirmación con el número de pedido. Si un producto se agota entre su pedido y el despacho, le avisamos y usted decide entre esperar al siguiente tueste, cambiarlo o que le devolvamos el dinero.

## 4. Pagos

Aceptamos tarjeta débito y crédito, PSE, Nequi y pago contraentrega. La contraentrega no está disponible en Amazonas, Guainía, Guaviare, Vaupés, Vichada ni San Andrés.

## 5. Entrega

Los plazos de entrega están en la página de Envíos y son estimaciones nuestras, no promesas de la transportadora. En todo caso el plazo máximo de entrega es de treinta (30) días calendario contados desde la confirmación del pedido, conforme al artículo 50 de la Ley 1480 de 2011.

## 6. Retracto, reversión y garantía

El derecho de retracto, la garantía legal y el procedimiento para hacerlos efectivos están en la página de Cambios y devoluciones, que forma parte de estos términos. La reversión del pago procede en los casos del artículo 51 de la Ley 1480 de 2011.

## 7. Atención automatizada

Una parte de nuestra atención por chat, WhatsApp e Instagram la responde un asistente automático. Lo que le informa sobre precios, disponibilidad y plazos es lo mismo que figura en esta tienda. Si necesita hablar con una persona, pídalo y le pasamos la conversación a alguien del equipo en horario de local.

## 8. Ley aplicable

Estos términos se rigen por la ley colombiana. Cualquier controversia se somete a los jueces de la República de Colombia.`,
  },
];

// ---------------------------------------------------------------------------
// Pedidos y clientes de muestra
// ---------------------------------------------------------------------------

export interface ClienteDemo {
  email: string;
  nombre: string;
  telefono: string;
}

export interface PedidoDemo {
  numero: number;
  cliente: string;
  estado: 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  pago: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'COD';
  proveedorPago: string | null;
  origen: 'web' | 'agent';
  canal: 'web' | 'whatsapp' | 'instagram' | 'other';
  /** Hace cuántos días se hizo el pedido. */
  haceDias: number;
  envioMetodo: string;
  envio: number;
  direccion: { departamentoCode: string; municipioName: string; direccion: string; barrio?: string };
  items: { producto: string; cantidad: number }[];
}

export const CLIENTES: ClienteDemo[] = [
  { email: 'laura.gomez@example.co', nombre: 'Laura Gómez', telefono: '+57 311 445 8820' },
  { email: 'andres.melo@example.co', nombre: 'Andrés Melo', telefono: '+57 300 771 2094' },
  { email: 'valentina.ruiz@example.co', nombre: 'Valentina Ruiz', telefono: '+57 320 118 6633' },
  { email: 'compras@cafeteriaelbalcon.co', nombre: 'Cafetería El Balcón', telefono: '+57 604 448 9012' },
];

export const PEDIDOS: PedidoDemo[] = [
  {
    numero: 1041,
    cliente: 'laura.gomez@example.co',
    estado: 'DELIVERED',
    pago: 'PAID',
    proveedorPago: 'wompi',
    origen: 'web',
    canal: 'web',
    haceDias: 12,
    envioMetodo: 'Envío nacional',
    envio: 0,
    direccion: { departamentoCode: '11', municipioName: 'Bogotá, D.C.', direccion: 'Calle 93 #13-24, apto 502', barrio: 'Chicó' },
    items: [
      { producto: 'kit-primer-origen', cantidad: 1 },
      { producto: 'taza-ceramica-la-cumbre-300ml', cantidad: 2 },
    ],
  },
  {
    numero: 1042,
    cliente: 'compras@cafeteriaelbalcon.co',
    estado: 'DELIVERED',
    pago: 'PAID',
    proveedorPago: 'wompi',
    origen: 'web',
    canal: 'web',
    haceDias: 8,
    envioMetodo: 'Domicilio en Medellín y Área Metropolitana',
    envio: 8000,
    direccion: { departamentoCode: '05', municipioName: 'Envigado', direccion: 'Calle 37 Sur #43-15', barrio: 'La Magnolia' },
    items: [{ producto: 'mezcla-la-cumbre', cantidad: 6 }],
  },
  {
    numero: 1043,
    cliente: 'andres.melo@example.co',
    estado: 'SHIPPED',
    pago: 'PAID',
    proveedorPago: 'wompi',
    origen: 'agent',
    canal: 'whatsapp',
    haceDias: 3,
    envioMetodo: 'Envío nacional',
    // $136.800 de subtotal: pasa del umbral de $120.000, así que el envío es
    // gratis. Es lo mismo que le dijo el agente en la conversación de
    // WhatsApp que sostiene este pedido.
    envio: 0,
    direccion: { departamentoCode: '76', municipioName: 'Cali', direccion: 'Avenida 6N #23-40', barrio: 'Granada' },
    items: [
      { producto: 'cafe-narino-el-mirador-340g', cantidad: 1 },
      { producto: 'prensa-francesa-600ml', cantidad: 1 },
    ],
  },
  {
    numero: 1044,
    cliente: 'valentina.ruiz@example.co',
    estado: 'PREPARING',
    pago: 'COD',
    proveedorPago: null,
    origen: 'agent',
    canal: 'instagram',
    haceDias: 1,
    envioMetodo: 'Domicilio en Medellín y Área Metropolitana',
    envio: 8000,
    direccion: { departamentoCode: '05', municipioName: 'Medellín', direccion: 'Carrera 70 #44-32, torre 2, apto 1103', barrio: 'Laureles' },
    items: [{ producto: 'cafe-huila-pitalito-340g', cantidad: 2 }],
  },
  {
    numero: 1045,
    cliente: 'laura.gomez@example.co',
    estado: 'PENDING',
    pago: 'PENDING',
    proveedorPago: 'wompi',
    origen: 'web',
    canal: 'web',
    haceDias: 0,
    envioMetodo: 'Envío nacional',
    envio: 0,
    direccion: { departamentoCode: '11', municipioName: 'Bogotá, D.C.', direccion: 'Calle 93 #13-24, apto 502', barrio: 'Chicó' },
    items: [{ producto: 'caja-regalo-tres-origenes', cantidad: 1 }],
  },
];

// ---------------------------------------------------------------------------
// Conversaciones ya atendidas
// ---------------------------------------------------------------------------

export interface ConversacionDemo {
  canal: 'web' | 'whatsapp' | 'instagram';
  /** Teléfono en dígitos (WhatsApp), IGSID (Instagram) o `null` (chat de la tienda). */
  referencia: string | null;
  estado: 'open' | 'resolved' | 'escalated';
  haceHoras: number;
  turnos: { rol: 'user' | 'assistant'; texto: string }[];
}

/**
 * Dos conversaciones ya cerradas, para que el panel de Conversaciones no
 * arranque vacío.
 *
 * No son decorativas: la del canal `whatsapp` es la que sostiene el pedido
 * 1043 (mismo comprador, mismo producto), así que quien grabe puede pasar del
 * chat al pedido y la historia cuadra.
 */
export const CONVERSACIONES: ConversacionDemo[] = [
  {
    canal: 'whatsapp',
    referencia: '573007712094',
    estado: 'resolved',
    haceHoras: 74,
    turnos: [
      { rol: 'user', texto: 'Buenas, ¿tienen café de Nariño?' },
      {
        rol: 'assistant',
        texto:
          '¡Hola! Sí 🙌 Tenemos el Café Nariño — Finca El Mirador 340 g a $46.900. Es lavado, de Buesaco, y en taza da panela, mandarina y nuez.\n\n¿Se lo mando en grano o molido? Si es molido, dígame con qué lo prepara y le pongo la molienda correcta.',
      },
      { rol: 'user', texto: 'Molido para prensa francesa. Y ¿tienen prensas?' },
      {
        rol: 'assistant',
        texto:
          'Sí, la prensa francesa de 600 ml está en $89.900, vidrio borosilicado y filtro de acero.\n\nEl café más la prensa suman $136.800, así que el envío a Cali le sale gratis (es gratis desde $120.000) y llega en 2 a 5 días hábiles. ¿Se lo dejo así?',
      },
      { rol: 'user', texto: 'Perfecto, así lo dejamos.' },
      {
        rol: 'assistant',
        texto:
          '¡Listo! Le dejo el enlace para que confirme sus datos y el pago: /carrito\n\nSale hoy mismo si confirma antes de las 2 p. m. Cualquier cosa por aquí estoy 🙂',
      },
    ],
  },
  {
    canal: 'web',
    referencia: null,
    estado: 'resolved',
    haceHoras: 20,
    turnos: [
      { rol: 'user', texto: '¿Cuánto dura el café una vez abierto?' },
      {
        rol: 'assistant',
        texto:
          'En grano y con la bolsa cerrada le dura hasta 3 meses desde la fecha de tueste, que va impresa en la bolsa. Ya molido, entre 2 y 3 semanas.\n\nGuárdelo en un lugar seco y oscuro, y no en la nevera: el café absorbe olores y humedad. Si lo va a tomar en más de un mes, mejor llévelo en grano 🙂',
      },
      { rol: 'user', texto: 'Gracias, muy claro.' },
      { rol: 'assistant', texto: '¡Con gusto! Si necesita ayuda para elegir un origen, dígame cómo lo prepara y le recomiendo.' },
    ],
  },
];
