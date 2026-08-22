# El diseño contra lo que hay — qué falta en el backend

*21 de agosto de 2026. Contraste de `ai-commerce-complete.zip` (demo y
producción) contra el backend en `13a5000`.*

Este documento contesta una sola pregunta: **qué hay que construir para que ese
diseño funcione de verdad.** Cada línea está verificada contra el esquema y los
controladores, no contra lo que uno esperaría que existiera.

La conclusión, primero: **la mayor parte de la tienda y del checkout se puede
conectar contra APIs que ya existen** — es reescritura de interfaz, no backend
nuevo. Lo que sí es backend nuevo se concentra en cuatro sitios, y dos de ellos
son grandes.

---

## 1. Una decisión de forma, antes de la lista

El diseño llama a `GET /public/stores/:slug/products`. La plataforma resuelve
el comercio por **el host de la petición** (`tenant.middleware.ts` lee
`x-tenant-domain` o `Host`), no por un slug en la ruta.

Las dos formas funcionan y la diferencia no es cosmética:

- **Por host (lo actual).** El dominio ES el comercio. Encaja con dominios
  propios, con la compuerta TLS y con `PublicTenantGuard`, que ya trata a un
  comercio `draft` como inexistente y a uno `suspended` como 503.
- **Por slug (lo que pide el diseño).** Un mismo despliegue puede servir
  cualquier tienda desde cualquier host — útil para un panel de vista previa o
  una app móvil, pero deja la identidad del comercio en manos del cliente.

**Recomendación:** conservar la resolución por host y montar las rutas del
diseño como una capa delgada que traduce `:slug` a un comercio, reusando
`PublicTenantGuard`. Lo que no hay que hacer es tener dos caminos de
resolución con reglas distintas sobre `draft`/`suspended` — ahí es donde
aparece una tienda que no debía verse.

---

## 2. Lo que ya existe y solo hay que conectar

Vale la pena decirlo porque es la mayoría del diseño:

| Diseño | Ya existe |
| --- | --- |
| Grilla de productos, búsqueda, categorías | Búsqueda FTS + trigram, categorías, ISR |
| Galería de imágenes en el PDP | `ProductImage` |
| Tallas y colores | `ProductVariant.option1/2/3` |
| Etiqueta "Oferta" y precio tachado | **`Product.compareAtCents` ya existe** |
| Carrito, cantidades, total | API de carrito completa |
| Checkout colombiano (departamento/municipio, dirección, barrio) | Completo, con IVA incluido |
| Métodos de envío y costo | `ShippingService`, con contra entrega restringible por departamento |
| Medios de pago | Wompi, Mercado Pago, ePayco |
| Seguimiento de pedido | `/rastrear` con número + correo o teléfono |
| Asistente de IA en tienda y WhatsApp | Agente con siete herramientas |
| Pedidos, productos, clientes, conversaciones en el panel | APIs completas |

El checkout en tres pasos del diseño (Datos → Entrega → Pago) es reorganización
de la interfaz: el endpoint recibe todo junto y puede seguir haciéndolo.
Además arregla algo que ya habíamos anotado — hoy son seis bloques apilados,
que en móvil es mucho desplazamiento antes de ver "Confirmar pedido".

---

## 3. Lo que no existe: modelos

Verificado con `grep -c "^model X"` sobre el esquema. Ninguno de estos existe:

| Falta | Para qué lo usa el diseño | Tamaño |
| --- | --- | --- |
| **Reseñas** | "4.8 (128 reseñas)" en el PDP | Modelo + moderación + agregado por producto. Mediano. |
| **Lista de deseos** | El corazón en cada tarjeta y en el PDP | Modelo pequeño — **pero depende de cuentas de comprador** (§4). |
| **Colecciones** | Los chips "Nuevos", "Mujer", "Hombre", "Ofertas", "Marcas" | Agrupación curada, distinta de categorías. Pequeño-mediano. |
| **Cupones / descuentos** | No está en las capturas, pero es lo primero que pide un comercio con "Ofertas" | Mediano, y toca el checkout y los totales. |
| **Categorías anidadas** | La miga de pan `Inicio › Mujer › Ropa` | `Category` es plana: no tiene `parentId`. Cambio pequeño de esquema, efecto en toda la navegación. |

Y un enum que se queda corto:

**`CartSource` solo tiene `web` y `agent`.** El diseño muestra un anillo de
"Canales de venta" con Tienda online, Instagram, WhatsApp y Otros. Hoy no se
puede calcular: no hay de dónde sacar Instagram, y un pedido nacido en WhatsApp
se marca `agent` igual que uno del chat web. Es un `ALTER TYPE` y marcarlo
donde se crea el pedido — pequeño, pero sin él ese gráfico no tiene datos.

---

## 4. Cuentas de comprador — el hueco grande

El diseño tiene "Ingresar / Mi cuenta" en el encabezado y "Guardar para mis
próximas compras" en el checkout.

**No existen.** `Customer` es un registro del CRM del comerciante — correo,
teléfono, nombre, contador de pedidos — sin credenciales, sin sesión, sin
forma de que el comprador entre. Todos los pedidos son de invitado.

Lo que arrastra: autenticación de comprador (separada de la de comerciantes,
que es `better-auth` y vive en tablas que `ventia_app` ni siquiera puede
leer), direcciones guardadas, historial de pedidos propio, y la lista de
deseos, que sin cuenta no tiene dónde vivir salvo en el navegador.

**Es la pieza más grande de esta lista y la que más conviene decidir antes de
empezar**, porque tres cosas del diseño cuelgan de ella. También es la que
tiene una alternativa razonable: en Colombia el comprador de tienda pequeña
compra como invitado y consulta por WhatsApp. Una versión intermedia —
identificar al comprador por su número, sin contraseña, y dejarle ver sus
pedidos desde el enlace que ya le llega— entrega buena parte del valor sin
construir un sistema de cuentas.

---

## 5. El panel: analítica, finanzas y un asistente que no existe

El tablero del diseño no es la lista que hay hoy. Lo que muestra:

- **Cuatro KPIs con variación contra ayer y minigráfico** (ventas, pedidos,
  conversaciones, resolución de IA).
- **Gráfico de ventas** por rango de fechas.
- **Actividad en vivo** — pedidos, pagos y conversaciones según entran.
- **Productos más vendidos**, **canales de venta**, **métodos de pago**.
- **"Insights de tu IA"** — acciones sugeridas.
- Secciones completas de **Analítica** y **Finanzas** en la navegación.

Contra el backend actual:

| Necesita | Estado |
| --- | --- |
| `GET /dashboard` con KPIs, series y variaciones | **No existe.** Los datos están en `Order`, `Conversation` y `AgentUsage`; falta el servicio que los agrega. Mediano. |
| Más vendidos / métodos de pago | Derivables de `OrderItem` y `Order.paymentProvider`. Pequeño. |
| Canales de venta | Bloqueado por `CartSource` (§3). |
| Actividad en vivo | **No hay tiempo real.** Ni WebSocket ni SSE en todo el repo. Mediano, y con una decisión de infraestructura detrás. |
| Analítica y Finanzas | **No existen** como superficie. Grande, y conviene definir qué contesta cada una antes de construirla. |
| **`POST /ai/command`** | **No existe, y es una pieza nueva de producto.** |

Ese último merece su propio párrafo. El ejemplo del contrato de integración es
*"¿Por qué vendimos menos esta semana?"*. Eso no es el agente que ya existe: el
actual atiende **compradores**, con herramientas de catálogo y carrito, y su
presupuesto se mide en mensajes de comprador. Este otro atiende al
**comerciante** y contesta sobre su propio negocio — necesita herramientas de
consulta agregada sobre pedidos y conversaciones, y un presupuesto aparte,
porque si comparte el cupo de `aiMessagesMonth` el comerciante se queda sin
atención al cliente por haber hecho preguntas de negocio. Vale la pena decidir
si esto entra en el plan básico o es lo que justifica un plan superior.

---

## 6. Cosas puntuales del PDP y la tienda

| Diseño | Estado |
| --- | --- |
| "Paga en hasta 3 cuotas sin interés con **Addi**" | Cuarta pasarela, no integrada. El registro de proveedores ya existe (`packages/payments`), así que es un adaptador más, no una refactorización. |
| "Recíbelo entre 1 y 5 días hábiles según tu ciudad" | **No hay dato de tiempo de entrega** en ningún lado. El generador de términos ya dejó un `[COMPLETAR: …]` por esto mismo. Pequeño y con efecto en tienda, PDP, checkout y términos. |
| "Guía de tallas" | Contenido nuevo, por comercio o por categoría. Pequeño. |
| Muestras de color redondas | `option1/2/3` son texto libre. Falta una convención para el color (nombre + hex). Pequeño. |
| Hero con imagen y copy, franja de anuncios, insignias de confianza | Configurables por comercio. Hoy el tema son 3 colores + tipografía + radio: **no hay dónde guardar una imagen de hero ni un texto de franja.** Es exactamente la Dirección 2 de `product.md`. |
| "Comprar ahora" (saltarse el carrito) | Pequeño sobre el checkout actual. |
| Notificaciones y campana en el panel | No hay modelo de notificaciones para el comerciante. |

---

## 7. Orden sugerido

No por tamaño, sino por lo que desbloquea a lo demás:

1. ~~**Decidir cuentas de comprador**~~ **Decidido y construido**: cuentas
   completas, una por tienda, con contraseña y enlace mágico. Entrar no cuesta
   el carrito, y el checkout de invitado sigue existiendo — una cuenta es una
   oferta, no un peaje. Ver `docs/shopper-accounts.md`. Quedan pendientes las
   dos cosas que la decisión desbloqueó y que aún no tienen modelo: direcciones
   guardadas y lista de deseos.
2. ~~**`CartSource` + tiempo de entrega + categorías anidadas.**~~ **Hecho**
   (`edf3b48`), en una sola migración. Con un matiz sobre lo que decía este
   documento: `CartSource` no se tocó. Ya respondía QUIÉN armó el carrito y es
   lo que cuenta el KPI de ventas asistidas por IA; lo que faltaba era DÓNDE
   estaba el comprador, que ahora es `SalesChannel`, una columna aparte en
   `Cart` y en `Order`. Un pedido que el agente cerró por WhatsApp es las dos
   cosas a la vez.
3. ~~**La capa de temas**~~ **Hecha a nivel de tokens**: cinco presets
   elegidos por "¿qué vendes?", guardados como `presetId` + overrides escasos
   para que mejorar un preset más adelante no pise lo que el comerciante
   cambió. Lo que NO trae todavía es estructura: el hero, la franja y las
   insignias siguen sin dónde vivir, porque eso es maquetación por preset y no
   tokens. La forma guardada ya es la que va a cargarla cuando exista.
4. **`GET /dashboard`** con lo derivable. Da el tablero sin tiempo real.
5. **Reseñas y colecciones**, que son lo que hace que la tienda se vea como el
   diseño con catálogo real.
6. **`POST /ai/command`**, decidiendo antes su presupuesto y su plan.
7. **Tiempo real, Analítica, Finanzas, Addi, cupones** — cada uno con su propia
   discusión.

También hecho, de la lista de "elija lo que elija" (`product.md` §5): las fotos
de producto, el pie de página y la navegación por categorías en el encabezado.
Quedan de esa lista el checkout en un solo tramo y las imágenes rotas, que
necesitan validación en la carga.

### Fuera de esta lista, ya hecho

El paquete de dominios propios, porque la petición de conectar un dominio no
podía esperar a la lista:

- `GET /v1/admin/domains` devuelve `platformRootDomain`, `pointsTo` y `apexIp`.
  El panel adivinaba la zona de la plataforma a partir de su propio hostname —
  exacto solo si se entra por `admin.ventia.co`, equivocado en
  `localhost:3001`, y por el camino de respaldo podía leer el
  `www.mitienda.com` del comerciante como si fuera nuestro.
- `pointsTo` es el subdominio gratis del comercio, NO el dominio principal. Las
  instrucciones anteriores decían que apuntara el CNAME al principal, así que
  en cuanto alguien promovía `mitienda.com` la pantalla le pedía apuntar
  `mitienda.com` hacia `mitienda.com`.
- `POST /:id/verify` dice POR QUÉ falló, y el panel da consejos distintos según
  el caso. Antes colapsaba "no existe el registro" con "el valor está mal" en
  un mismo `false`, así que el texto tenía que cubrir los dos y mandaba a
  revisar cosas que ya estaban bien.
- `PLATFORM_APEX_IP`, opcional y sin valor por defecto, para el comerciante
  cuyo dominio es la raíz pelada. Sin configurar devuelve `null` y el panel
  sigue pidiendo que escriban: un registro A hacia una dirección equivocada no
  se degrada, deja la tienda fuera de internet.
- La pantalla de lanzamiento enlazaba a `http://{slug}.ventia.localhost`
  escrito a mano. Enlace muerto en producción, y es lo primero que un
  comerciante toca después de lanzar.

---

## 8. Lo que este documento no hizo

- No ejecuté el paquete de producción contra el backend. El demo corre con
  datos simulados; la versión de producción apunta a `/api/v1` y nunca se
  conectó a nada.
- No revisé el diseño en móvil, que es donde va a pasar casi todo el tráfico
  colombiano. Las capturas son de 1440 px.
- No conté el trabajo de interfaz. Todo lo de arriba es backend; portar el
  diseño a las dos apps de Next.js es un esfuerzo aparte y probablemente mayor.
