# Ventia — dónde está el producto y hacia dónde puede ir

*21 de agosto de 2026. Escrito al terminar P6, con la plataforma funcionando y
sin ningún comercio real todavía.*

Este documento existe para tomar dos decisiones que se condicionan: **qué es
Ventia frente al mercado** y **cuánta libertad visual reciben los comercios**.
La segunda depende de la primera, así que van en ese orden.

No es un resumen de lo construido — eso está en el README. Es una lista de
bifurcaciones reales, con lo que cada una cuesta.

---

## 1. Dónde está el producto, sin adornos

**Funciona de punta a punta.** Un comerciante se registra, crea su tienda,
carga productos (o los importa por CSV), configura envíos y pagos, y vende:
catálogo público con su propio subdominio, carrito, checkout con dirección
colombiana, contra entrega y tres pasarelas, correos en cada paso, y un panel
para confirmar, despachar y entregar. Encima de eso hay un agente de IA que
responde por el chat de la tienda y por WhatsApp, con escalamiento a una
persona.

**Lo que todavía no ha pasado nunca:** ningún peso real ha cruzado una pasarela,
ningún número de WhatsApp real ha recibido un mensaje, y nadie ha desplegado
esto en un servidor. Los tres están verificados contra fixtures y esquemas de
firma documentados, no contra tráfico real. El primer pago real es una prueba.

**La deuda que importa para producto**, no para ingeniería:

| | |
| --- | --- |
| Imágenes de producto | El comerciante sube una por una. Sin recorte, sin reordenar por arrastre, sin generar variantes de tamaño. |
| El storefront | Un solo layout. Tres colores, cinco pares tipográficos, cinco radios de esquina. Nada más. |
| Búsqueda | Funciona (FTS + trigram), pero sin filtros por precio, talla ni color. |
| Analítica | El comerciante no tiene ninguna. Ve pedidos, no ve qué se está viendo y no se compra. |
| Devoluciones | El estado `cancelled` existe; el flujo de devolución con reintegro, no. |

Ninguna de esas bloquea un piloto. Todas bloquean el comercio número 50.

---

## 2. La bifurcación de posicionamiento

Antes de decidir cómo se ve, hay que decidir contra quién se compara.

**El competidor real no es Shopify.** En el comercio pequeño colombiano, la
alternativa a Ventia casi nunca es otra plataforma: es un Instagram con catálogo
en los destacados, un WhatsApp para cerrar la venta y un cuaderno para el
inventario. Ese vendedor no está evaluando plataformas. Está resolviendo el día.

Eso cambia por completo cuál es el argumento.

### Opción A — "Shopify en español, para Colombia"

Vender la plataforma completa: catálogo, tienda, checkout, envíos, pagos
locales. Compites con Tiendanube y Shopify por el comerciante que **ya decidió**
que quiere una tienda en línea.

- **A favor:** el mercado te entiende sin explicación. El producto ya hace esto.
- **En contra:** entras a una carrera de features que llevas años de retraso, y
  el diferenciador es "más barato y con Wompi", que no defiende nada. Tiendanube
  ya está en Colombia con pagos locales.
- **Implica:** el storefront tiene que verse tan bien como el de ellos. Ahí la
  barra es alta y hoy no la pasas.

### Opción B — "Vende por WhatsApp, con catálogo de verdad"

El producto entra por donde el comerciante ya vende. WhatsApp es el canal
principal, no un extra; la tienda es donde el catálogo vive para que el agente
lo pueda citar y el link se pueda mandar.

- **A favor:** es donde ya está el comerciante y su cliente. No le pides cambiar
  de hábito, le pides mejorar el que tiene. El canal de WhatsApp y el agente ya
  están construidos — es lo único de esta lista que ya existe.
- **En contra:** dependencia de Meta. Las plantillas, la verificación de número
  y las políticas son suyas, y pueden cambiar. Además obliga a que el agente sea
  bueno de verdad: si contesta mal, contesta mal frente al cliente del comercio.
- **Implica:** el storefront puede ser sobrio. Su trabajo es cargar rápido en
  4G, verse decente en un link compartido y no estorbar. La inversión de diseño
  se va a la conversación, no a la vitrina.

### Opción C — "Un vendedor que trabaja de noche"

El producto no se vende como plataforma sino como **una persona más en el
equipo**. El agente responde precios, disponibilidad, tallas y estado del
pedido a cualquier hora; la tienda y el panel son la infraestructura que lo hace
posible.

- **A favor:** es la única de las tres que no tiene un competidor obvio en
  Colombia, y es la que mejor justifica una suscripción mensual. Un comerciante
  entiende "te contesta los mensajes de la noche" mucho más rápido que "es un
  headless commerce multi-tenant".
- **En contra:** el costo variable de IA es real y va contra tu margen. El plan
  básico da 500 mensajes/mes; un comercio activo en WhatsApp los quema en dos
  semanas. Los límites por plan tendrían que rediseñarse alrededor del uso, no
  del catálogo.
- **Implica:** la calidad del agente es el producto. Cada peso de diseño va a la
  conversación, al panel de conversaciones y al escalamiento.

**Recomendación: B, con C como el argumento de venta.** Entras por WhatsApp
porque es donde está el hábito, y lo que cobras es que el agente atiende. A es
una trampa: te obliga a competir en el eje donde estás más débil (diseño de
tienda, ecosistema de apps, madurez) y donde el cliente ya tiene opciones
buenas.

Esa decisión, si se toma, ordena todo lo demás en este documento.

---

## 3. Planes y precios

Los límites actuales están puestos sobre el **catálogo**, que es la dimensión
equivocada si el valor está en la conversación:

| | básico | pro | premium |
| --- | --- | --- | --- |
| Productos | 100 | 1.000 | 10.000 |
| Mensajes de IA / mes | 500 | 3.000 | 10.000 |
| Usuarios | 1 | 3 | 10 |
| Dominio propio | no | sí | sí |
| WhatsApp | no | sí | sí |
| Handoff humano | no | no | sí |

Tres problemas concretos:

1. **WhatsApp está en `pro`.** Si el posicionamiento es "vende por WhatsApp", el
   plan de entrada no puede excluir el canal por el que vendes el producto. Es
   como vender un carro sin ruedas en la versión base.
2. **Los productos no cuestan.** Un comercio con 800 productos no te cuesta más
   que uno con 80. Los mensajes de IA sí. Cobrar por catálogo es cobrar por algo
   que no consume, y no cobrar por lo que sí.
3. **El handoff humano está en `premium`.** El escalamiento a una persona es
   justamente lo que evita que el agente haga daño cuando no sabe. Ponerlo en el
   plan más caro significa que los comercios más pequeños tienen la versión del
   agente sin red de seguridad.

**Alternativa a considerar:** un solo eje de precio — mensajes de IA — con
WhatsApp y handoff incluidos en todos los planes, y el catálogo sin límite
práctico. Más fácil de explicar, alineado con tu costo real, y deja de castigar
al comercio pequeño en la dimensión que más lo protege.

---

## 4. Cuánta libertad visual reciben los comercios

Hoy el tema por comercio es exactamente esto:

```
colors:   primary, background, foreground   (3 hex)
fontPair: inter-lora | poppins-source | montserrat-merriweather
          | raleway-open | worksans-bitter
radius:   none | sm | md | lg | full
logoUrl, faviconUrl
```

Se aplica como variables CSS sobre `<html>`. **Todas las tiendas tienen la misma
forma**; cambian de color, de tipografía y de esquina. Eso no es un accidente,
es un techo deliberado — y es la decisión a tomar.

### Dirección 1 — Tokens (lo actual)

Mantener el techo. El comerciante elige color, tipografía, radio, logo.

- **A favor:** ninguna tienda puede quedar fea. Un solo layout que mantener, que
  probar y que optimizar. El rendimiento es predecible.
- **En contra:** ninguna tienda puede quedar memorable tampoco. Dos comercios
  del mismo rubro se ven como hermanos. Si el comerciante quiere algo propio, se
  va.
- **Cuesta:** nada. Ya está.

### Dirección 2 — Presets completos

Tres o cuatro **looks terminados**, no combinaciones de tokens: cada uno con su
layout de home, densidad, tratamiento de imagen, tipografía y escala. El
comerciante elige uno y ajusta color y logo dentro de él.

Por ejemplo: *Vitrina* (imagen grande, poco texto, para moda), *Catálogo*
(denso, mucha referencia por pantalla, para ferretería o repuestos), *Marca*
(editorial, mucho aire, para producto artesanal con historia).

- **A favor:** rango real sin riesgo real. Un comercio de repuestos y uno de ropa
  dejan de verse igual, que es la queja más común. Y el preset es una decisión
  de negocio disfrazada de decisión estética: "¿qué vendes?" ordena mejor que
  "¿qué color te gusta?".
- **En contra:** tres layouts que mantener en vez de uno. Cada feature nueva del
  storefront se implementa y se prueba tres veces.
- **Cuesta:** semanas, no meses. La infraestructura de tema ya existe; lo que
  falta es que el preset también elija estructura, no solo variables.

### Dirección 3 — Secciones editables

El comerciante arma su home con bloques (hero, destacados, categorías, texto,
banner) y los ordena.

- **A favor:** techo altísimo. Es lo que hace Shopify y por eso los comercios
  grandes se quedan ahí.
- **En contra:** es la más cara con diferencia, y la mayoría de comercios
  pequeños no la quieren — quieren que alguien decida por ellos. También es la
  puerta de entrada a tiendas feas, que es un costo de marca que pagas tú, no el
  comerciante.
- **Cuesta:** un trimestre, con editor, previsualización y versionado.

**Recomendación: Dirección 2.** La 1 ya se siente estrecha con ocho productos de
prueba; la 3 resuelve un problema que tus comercios todavía no tienen. Los
presets además encajan con el posicionamiento B/C: el preset se elige en el
onboarding respondiendo "¿qué vendes?", que es una pregunta que el comerciante
sabe contestar.

---

## 5. Lo que hay que arreglar del storefront, elija lo que elija

Independiente de la dirección, esto se ve hoy en las capturas:

- **Las imágenes son el producto y hoy son un cuadro gris.** Sin recorte, sin
  proporción forzada, sin placeholder decente. En moda, la imagen *es* la venta.
  Esto pesa más que cualquier decisión de tipografía.
- **El footer flota a media pantalla** en páginas cortas, en vez de quedar
  abajo. Es una línea de CSS y se nota en cada página con poco contenido.
- **No hay navegación por categorías** en el header. Con ocho productos no se
  siente; con doscientos, la tienda es inusable.
- **El checkout es largo y de un solo tramo.** Funciona y es correcto — la
  cascada departamento/municipio, el IVA incluido, la autorización de datos —
  pero son seis bloques apilados. En móvil, que es donde va a pasar casi todo,
  eso es mucho desplazamiento antes de ver "Confirmar pedido".

---

## 6. El admin

El panel del comerciante está mejor resuelto que el storefront: la barra lateral
es clara, los estados vacíos explican qué hacer, Configuración está bien
organizada en pestañas. No lo tocaría todavía.

Dos cosas sí:

- **No hay un panel de inicio.** Hoy `/` es una lista. Un comerciante que abre
  el panel en la mañana quiere ver: pedidos por confirmar, pagos por revisar,
  conversaciones escaladas y productos sin stock. Los cuatro datos ya existen en
  la API.
- **La consola de operador está terminada y es de otro mundo visualmente**, lo
  cual es correcto y deliberado — pero conviene saber que ese contraste es la
  única parte del producto con una identidad visual fuerte. El storefront y el
  admin del comerciante, no.

---

## 7. Qué decidir

En orden, porque cada una depende de la anterior:

1. **Posicionamiento** (§2). Recomendado: entrar por WhatsApp, cobrar por el
   agente.
2. **Planes** (§3). Si sale B/C, mover WhatsApp y handoff al plan básico y
   cobrar por mensajes.
3. **Rango visual** (§4). Recomendado: presets, elegidos en el onboarding.
4. **Imágenes de producto** (§5). Es la deuda de producto más cara que hay hoy y
   no depende de ninguna de las tres anteriores — se puede empezar ya.
