# Grabar los screencasts del App Review de Meta

Para el dueño, con Meta abierto en la otra pestaña.

Este documento cubre lo que hay que hacer para grabar la revisión de la app de
Meta **con mensajes de verdad**, escritos desde Instagram y WhatsApp de verdad,
sin tocar la consola. Los simuladores (`ig.mjs`, `wa.mjs`) siguen ahí y siguen
funcionando, pero pasan a ser el respaldo — están en la última sección.

Léete antes la sección **[7. Lo que hoy no se puede grabar](#7-lo-que-hoy-no-se-puede-grabar-y-por-qué)**.
De los seis permisos que se piden, **dos** tienen un camino de código real que
se puede enseñar y **cuatro** no. Enterarse de eso ahora vale más que cualquier
otra cosa de aquí.

---

## 1. Lo que hay que tener antes de empezar

| Qué | Dónde se consigue | Sin esto pasa |
|---|---|---|
| `ANTHROPIC_API_KEY` | tu cuenta de Anthropic | el agente no contesta y no hay error a la vista |
| `cloudflared` | el arranque te da el comando exacto | no hay URL pública y Meta no puede entregar nada |
| Una app de Meta en modo desarrollo | developers.facebook.com | — |
| Una cuenta de Instagram profesional vinculada a una página de Facebook | tu cuenta de prueba | — |
| Un número en WhatsApp Business Platform (Cloud API) | la app de Meta, pestaña WhatsApp | — |
| **Un segundo teléfono** (o una segunda cuenta) para escribir como cliente | — | no puedes escribirte a ti mismo: Instagram no entrega el DM de una cuenta a sí misma |

Ese último punto es el que más se olvida. El comprador de la grabación tiene
que ser **otra persona u otra cuenta**, y conviene que sea un teléfono físico
distinto porque lo vas a tener en cámara.

---

## 2. Arranque: los comandos exactos, en orden

```bash
# 1. Una sola vez: mete en el .env de la raíz lo que no cambia entre tomas.
#    Los tres META_ son opcionales pero muy recomendables: con ellos el bloque
#    del final del arranque sale con las URLs YA completas, sin huecos.
cat >> .env <<'FIN'
ANTHROPIC_API_KEY=sk-ant-...
META_IG_ACCOUNT_ID=17841...
META_WA_PHONE_NUMBER_ID=1093...
META_VERIFY_TOKEN=inventate-una-clave-larga-2026
FIN

# 2. Levantar todo. Deja esta terminal abierta: es la que sostiene el túnel.
pnpm run demo

# 3. En OTRA terminal, antes de tocar Meta.
pnpm run demo:comprobar
```

`pnpm run demo` hace, en este orden: comprueba la clave de Anthropic y que
`cloudflared` esté instalado, levanta docker, compila los paquetes, migra la
base, **levanta el túnel público y exporta `API_PUBLIC_URL`**, arranca el API,
siembra la tienda, arranca el panel y la tienda, y termina imprimiendo el
bloque de **PEGAR EN META**.

El orden del túnel no es negociable y conviene entender por qué. `API_PUBLIC_URL`
la lee el **proceso del API** de su entorno, y un proceso no hereda una variable
que se exportó después de arrancarlo. Si el túnel subiera después, el panel
enseñaría `http://api.ventia.localhost` en su botón de copiar — una URL que Meta
no puede alcanzar jamás — y el fallo aparecería media hora más tarde
disfrazado de «Instagram no funciona».

### Los otros comandos

| Comando | Para qué |
|---|---|
| `pnpm run demo:pegar` | vuelve a imprimir el bloque de PEGAR EN META sin reiniciar nada |
| `pnpm run demo:comprobar` | confirma que el túnel llega y que el handshake pasa |
| `pnpm run demo:tunel` | levanta solo el túnel, si el stack ya está arriba y se cayó |
| `pnpm run demo:reiniciar` | deja la tienda como recién sembrada entre toma y toma |
| `pnpm run demo:parar` | para los servidores y cierra el túnel |
| `pnpm run demo --sin-tunel` | arranca sin URL pública (solo simuladores) |

### Perillas del túnel, por si hacen falta

| Variable | Por defecto | Para qué |
|---|---|---|
| `API_PUBLIC_URL` | vacía | si la pones, **no se levanta túnel**: se usa la tuya |
| `DEMO_TUNEL_ESPERA` | `60` | segundos que se espera a que cloudflared publique la URL; súbela si tu red va lenta |
| `DEMO_TUNEL_PUERTO` | `4000` | a qué puerto local apunta el túnel |
| `ARCHIVO_TUNEL` | `/tmp/ventia-demo-tunel-<uid>.url` | dónde queda escrita la URL para que la lean las otras terminales |

### Si ya tienes una URL pública tuya

Exporta `API_PUBLIC_URL` (en el `.env` o en el entorno) y el arranque **no
levanta ningún túnel**: respeta la tuya. Es lo que hay que hacer si tienes un
dominio de verdad o un ngrok de pago, y evita el mayor inconveniente del quick
tunnel, que es que **la URL cambia en cada arranque**.

---

## 3. Qué configurar en Meta, paso a paso

### 3.1 Instagram

1. En la app de Meta: **Productos → Instagram → Configuración de la API**.
   Apunta el **id de la cuenta profesional** (empieza por `17841…`) y el
   **id de la página** de Facebook vinculada.
2. Genera un **token de acceso de la página**. Que sea de larga duración o de
   usuario de sistema; el temporal de una hora se te caduca en mitad de la toma.
3. Copia el **App Secret** de **Configuración de la app → Básica**.
4. Ve al panel de Ventia: **Configuración → Instagram → Conectar una cuenta**.
   Rellena, con estos nombres exactos:

   | Campo del panel | Qué pegar |
   |---|---|
   | Usuario de Instagram | `@tucuenta` |
   | ID de la cuenta de Instagram | el `17841…` del paso 1 |
   | ID de la página de Facebook | el id de la página del paso 1 |
   | Token de acceso de la página | el del paso 2 |
   | Clave secreta de la app (App Secret) | el del paso 3 |
   | Token de verificación | **te lo inventas**, mínimo 8 caracteres |

5. Guarda. El panel enseña ahora la **URL de callback** con un botón de
   **Copiar**. Úsalo — no la escribas a mano.
6. Vuelve a Meta: **Instagram → Webhooks**. Pega esa URL de callback y ese
   mismo token de verificación. Suscribe el campo **`messages`**.
7. Meta dispara el handshake al guardar. Un tick verde significa que llegó y
   que el token coincide.

### 3.2 WhatsApp

Mismo camino con otros nombres.

1. **Productos → WhatsApp → Configuración de la API**: apunta el
   **Phone number ID** (numérico, **no** el teléfono) y genera un token
   permanente de usuario de sistema.
2. Panel de Ventia: **Configuración → WhatsApp → Conectar un número**,
   proveedor **WhatsApp Cloud API (Meta)**.

   | Campo del panel | Qué pegar |
   |---|---|
   | Número de WhatsApp | el teléfono como lo ve el cliente |
   | Phone number ID de Meta | el numérico del paso 1 |
   | Token de acceso permanente | el del paso 1 |
   | Clave secreta de la app (App Secret) | el mismo de la app |
   | Token de verificación | te lo inventas |

3. Copia la URL de callback del panel y pégala en **WhatsApp → Configuración →
   Webhook**, con el mismo token. Suscribe el campo **`messages`**.

### 3.3 Lo que hay que saber del `?account=` y el `?number=`

Las dos URLs de callback llevan una cadena de consulta:

```
https://<tu-tunel>.trycloudflare.com/webhooks/instagram/graph?account=<IG_ACCOUNT_ID>
https://<tu-tunel>.trycloudflare.com/webhooks/whatsapp/cloud?number=<PHONE_NUMBER_ID>
```

Ese parámetro es **invención de esta plataforma**, no de Meta. El handshake de
Meta manda solo `hub.mode`, `hub.challenge` y `hub.verify_token`, sin nada que
diga qué cuenta se está verificando; sin el parámetro no habría forma de saber
contra qué token comparar. Consecuencia práctica: **si copias la URL cortando
en el `?`, el handshake devuelve 403 y no hay ningún mensaje que lo explique.**
Por eso se copia con el botón.

### 3.4 La URL del túnel cambia en cada arranque

Un quick tunnel de Cloudflare no reserva nombre. Cada `pnpm run demo` da una
URL distinta, y **la que quedó pegada en Meta deja de funcionar**. Si paras y
vuelves a arrancar, hay que volver a pegar las dos URLs de callback. Si eso te
va a pasar muchas veces, monta un túnel con nombre o un dominio de verdad y
exporta `API_PUBLIC_URL`.

---

## 4. La comprobación previa

```bash
pnpm run demo:comprobar
```

Reproduce el handshake GET —el mismo que dispara Meta— por la URL pública y
comprueba que el cuerpo es **el reto tal cual**. Hace cada prueba dos veces,
por localhost y por la URL pública, porque el par de resultados es lo que
distingue las causas:

| local | público | Qué está roto |
|:---:|:---:|---|
| ✗ | ✗ | el API o los datos. `pnpm run demo` |
| ✓ | ✗ | el túnel. `pnpm run demo:tunel` — y volver a pegar la URL en Meta |
| ✓ | ✓ | nada: se puede grabar |

Por defecto prueba las cuentas **sembradas** de la demo, que existen siempre:
eso demuestra el camino completo —túnel, API, base, verificación del token— sin
necesitar ninguna credencial de Meta. Si además pusiste los `META_*` en el
`.env`, prueba también esos, que son los que de verdad vas a pegar; ahí un
fallo es normal hasta que conectes la cuenta en el panel.

Un detalle que importa: comprueba que el cuerpo sea **idéntico** al reto, no
que la respuesta sea 200. Meta compara byte a byte y sin recortar; un 200 con
el reto entrecomillado como JSON, o con un salto de línea de más, es un 200 que
Meta rechaza.

**Si esta comprobación no pasa, no abras Meta.** Nada de lo demás va a
funcionar y lo vas a descubrir con la cámara puesta.

---

## 5. Guion de los screencasts

Meta pide, para cada permiso, **tres cosas**: el vídeo, la justificación
escrita, y las instrucciones paso a paso para que su revisor lo reproduzca. Un
screencast sin descripción se rechaza sin más trámite.

### 5.1 Reglas que valen para todas las tomas

- **Sin cortes.** Un salto se lee como una parte escondida. Si algo sale mal,
  `pnpm run demo:reiniciar` y se vuelve a empezar.
- **Se ve la pantalla entera**, con la barra de direcciones a la vista. El
  revisor tiene que poder ver que es tu app la que está corriendo.
- **El teléfono en cámara**, o grabado en paralelo. Que se vea el mensaje
  saliendo de la app de Instagram / WhatsApp de verdad.
- **Con audio o con subtítulos**, narrando qué se está haciendo.
- **En inglés** los textos que se envían a Meta; el producto puede seguir en
  español y de hecho conviene que se vea así, pero la narración y la
  descripción van en inglés.
- **La revelación de automatización tiene que verse.** Es la parte que hace
  que se apruebe: la política de experiencias automatizadas de Meta exige
  decirle al usuario que quien contesta es un sistema. Aquí la antepone el
  sistema, no el modelo, así que sale **siempre**, y el texto es literalmente:

  > Hola, soy Manuela, el asistente virtual de Tostaduría La Cumbre. Te respondo
  > de forma automática. Si en algún momento prefieres hablar con una persona
  > del equipo, dímelo y te paso con alguien.

  (Esa es la versión del tono «cercano», que es el que trae sembrada la tienda
  de demo. La segunda frase cambia según si el plan incluye traspaso a una
  persona o solo los datos de contacto de la tienda.)

  Que ese primer renglón se lea con claridad en el vídeo. Es la prueba de
  cumplimiento y no se puede reconstruir después: si el revisor no la ve, no
  hay forma de demostrarla más tarde.

### 5.2 Toma A — `instagram_manage_messages` (y `instagram_basic`)

Es la toma principal. Dura entre dos y tres minutos.

| # | Qué se ve | Por qué está |
|---|---|---|
| 1 | El panel en **Configuración → Instagram**, con la cuenta conectada y su URL de callback | establece que la app está integrada con tu cuenta profesional |
| 2 | La consola de Meta, **Instagram → Webhooks**, con `messages` suscrito y el tick verde | prueba que la suscripción está viva |
| 3 | El teléfono: se abre Instagram con la **cuenta del comprador** y se entra al perfil de la tienda | el mensaje sale de un cliente real |
| 4 | Se escribe un DM: *«¿Tienen café de Nariño? ¿Cuánto vale?»* | la pregunta de atención al cliente |
| 5 | Vuelta al panel, **Conversaciones**: la conversación aparece sola | recepción del mensaje: esto es `instagram_manage_messages` en lectura |
| 6 | La respuesta del agente, **empezando por la revelación de automatización**, con el precio y el producto reales del catálogo | envío del mensaje: `instagram_manage_messages` en escritura |
| 7 | El teléfono otra vez: la respuesta **llegó a Instagram** | cierra el círculo. Sin esto el revisor solo ha visto tu base de datos |
| 8 | Un segundo turno: *«¿Hacen envíos a Cali?»* y su respuesta | demuestra conversación, no un eco |
| 9 | El comprador pide hablar con una persona y el agente lo escala (`escalate_to_human`) | la vía de escalado que exige la política |
| 10 | La dueña **toma la conversación** desde el panel y escribe ella misma; el mensaje llega al teléfono | demuestra que hay una persona detrás de verdad, no una promesa |
| 11 | Devuelve la conversación al agente | cierra el ciclo completo de atención |

Los pasos 10 y 11 son opcionales para el permiso, pero son lo que convence:
la política de experiencias automatizadas exige una vía a un humano y casi
todo el mundo la enseña como una frase. Enseñarla funcionando es distinto.

El paso 7 es el que más se olvida y el que más rechazos causa. El revisor tiene
que ver el mensaje **dentro de la app de Instagram**, no solo en tu panel.

### 5.3 Toma B — WhatsApp (`whatsapp_business_messaging`)

La misma estructura, cambiando el canal:

1. Panel en **Configuración → WhatsApp**, número conectado, URL de callback.
2. Consola de Meta, **WhatsApp → Configuración → Webhook**, campo `messages`.
3. El teléfono del comprador escribe al número de la tienda:
   *«¿Cuánto vale el envío a Cali?»*.
4. **Conversaciones** en el panel: llega el mensaje.
5. La respuesta, empezando por la revelación de automatización.
6. El teléfono: la respuesta llegó a WhatsApp.
7. Un segundo turno sobre un pedido, para que se vea que hay contexto.

### 5.4 Qué NO hacer en cámara

- No enseñes el App Secret, ni el token de acceso, ni el `.env`. El panel
  guarda esos campos como contraseñas justamente para que esto sea fácil.
- No uses la consola para mandar los mensajes. Ese es el punto de todo esto:
  si en el vídeo aparece `node scripts/demo/ig.mjs`, el revisor ha visto que el
  mensaje no vino de Instagram.
- No cortes cuando el agente tarde. Que se vea el tiempo real; son unos
  segundos y la espera es honesta.

---

## 6. Los textos en inglés, listos para pegar

El envío a Meta va en inglés aunque el producto esté en español. Copia cada
bloque en el campo correspondiente del formulario de cada permiso. Ajusta el
nombre del producto si lo cambias.

### 6.1 `instagram_manage_messages`

**How will you use this permission?**

> Ventia is a commerce platform for small Colombian retailers. Each merchant
> connects their own Instagram professional account and Ventia answers their
> incoming direct messages on their behalf.
>
> We use `instagram_manage_messages` for exactly two things. First, to receive
> the `messages` webhook so that a customer's direct message reaches the
> merchant's inbox in Ventia. Second, to send the reply back to that same
> customer through the Instagram Messaging API.
>
> Replies are produced by an automated assistant that answers questions about
> the merchant's own catalogue — product availability, prices, shipping cost
> and delivery times, and the status of an existing order — using only data
> from that merchant's store. Every conversation opens with a fixed, system
> generated disclosure telling the customer they are talking to an automated
> assistant, and every conversation offers a path to a human. The merchant can
> take over any conversation manually from the Ventia dashboard.
>
> We do not read messages the customer did not send to the merchant, we do not
> message anyone who has not messaged the merchant first, and we send nothing
> outside Meta's 24 hour customer service window.

**Step by step instructions for the reviewer**

> 1. Open the merchant dashboard at the URL provided and sign in with the test
>    credentials supplied with this submission.
> 2. Go to Configuración → Instagram. You will see the connected Instagram
>    professional account and the webhook callback URL for it.
> 3. From any Instagram account other than the merchant's, open a direct
>    message thread with the merchant's Instagram profile and send:
>    "Do you have coffee from Nariño? How much is it?"
> 4. Go back to the dashboard and open Conversaciones. The message appears as a
>    new conversation within a few seconds.
> 5. The automated assistant replies. The reply begins with the automation
>    disclosure and then answers with a real product and price from the
>    merchant's catalogue.
> 6. Check the Instagram app on the sending account: the reply has arrived
>    there.
> 7. Send a second message, "Do you ship to Cali?", to see a multi turn
>    conversation.
> 8. Send "I would like to talk to a person" to see the escalation to a human
>    being offered and recorded on the conversation.

### 6.2 `instagram_basic`

> `instagram_basic` is requested as the base permission required by Meta for
> the Instagram Messaging product. Ventia uses it to identify the Instagram
> professional account a merchant has connected — the account username and
> account id shown in Configuración → Instagram — so that incoming webhook
> deliveries can be routed to the correct merchant. The account id is the only
> routing key we have: one Meta app delivers a single webhook covering every
> connected account, and `entry[].id` inside the payload is what tells us whose
> message it is.
>
> We do not read, store or display the account's media, followers or insights.

### 6.3 `pages_show_list`

> Ventia uses `pages_show_list` so that a merchant connecting their Instagram
> professional account can see the Facebook Pages they manage and choose the
> one their Instagram account is linked to. An Instagram professional account
> is reachable through its linked Page, so without the list of Pages a merchant
> would have to find and paste a numeric Page id by hand, which is the single
> most error prone step of the connection flow.
>
> We request the list only during the connection flow, we store only the id of
> the Page the merchant selects, and we never post to any Page.

### 6.4 `pages_read_engagement`

> Ventia uses `pages_read_engagement` to read the basic configuration of the
> Facebook Page a merchant has connected — its name and its link to the
> merchant's Instagram professional account — so that the dashboard can show
> the merchant which Page and which Instagram account are wired up, and can
> tell them when that link has been broken on Meta's side.
>
> We do not read posts, comments, reactions or insights, and we do not use this
> permission to build any profile of Page visitors.

### 6.5 `whatsapp_business_messaging`

> Ventia is a commerce platform for small Colombian retailers. Each merchant
> connects their own WhatsApp Business phone number and Ventia answers their
> incoming customer messages on their behalf.
>
> We use `whatsapp_business_messaging` to receive the `messages` webhook for
> the merchant's number and to send the reply back to the customer through the
> Cloud API. Replies answer questions about the merchant's own catalogue —
> availability, prices, shipping cost and delivery times, and the status of an
> existing order.
>
> Every conversation opens with a fixed disclosure that the customer is talking
> to an automated assistant, and offers a path to a human. Every message we
> send is a direct reply to a message the customer sent, so all traffic is
> inside the 24 hour customer service window. We send no template messages, no
> marketing and no unsolicited messages of any kind.

**Step by step instructions for the reviewer**

> 1. Sign in to the merchant dashboard with the supplied test credentials.
> 2. Go to Configuración → WhatsApp to see the connected number.
> 3. From any phone, send a WhatsApp message to the merchant's number:
>    "How much is shipping to Cali?"
> 4. Open Conversaciones in the dashboard: the message appears within seconds.
> 5. The automated assistant replies, beginning with the automation disclosure.
> 6. Check the sending phone: the reply has arrived in WhatsApp.

### 6.6 `whatsapp_business_management`

> Ventia uses `whatsapp_business_management` to read the configuration of the
> WhatsApp Business phone number a merchant has connected, so that the
> dashboard can show the merchant the number's display name and verification
> status and can tell them when the number has been disconnected or its token
> has expired on Meta's side.
>
> We do not create, delete or transfer phone numbers, and we do not manage
> message templates.

---

## 7. Lo que hoy no se puede grabar, y por qué

Esto es lo importante y va sin adornos.

**Todo lo que esta plataforma le pide a la Graph API son dos llamadas**, y las
dos son de envío de mensaje:

```
POST https://graph.facebook.com/v21.0/{ig-account-id}/messages     (packages/instagram/src/graph.ts)
POST https://graph.facebook.com/v21.0/{phone-number-id}/messages   (packages/whatsapp/src/cloud.ts)
```

No hay ninguna otra. En concreto **no hay Facebook Login**: el comerciante pega
a mano el token de la página, el App Secret y el token de verificación en el
panel. De ahí sale este reparto:

| Permiso | ¿Hay código que lo use? | ¿Se puede grabar? |
|---|---|---|
| `instagram_manage_messages` | sí — recibe el webhook y envía la respuesta | **sí**, toma A |
| `whatsapp_business_messaging` | sí — recibe el webhook y envía la respuesta | **sí**, toma B |
| `instagram_basic` | no se llama, pero Meta lo exige como base de la mensajería de Instagram | se cubre con la toma A y la justificación de §6.2 |
| `pages_show_list` | **no** | **no**: hace falta un flujo de Facebook Login con selector de páginas |
| `pages_read_engagement` | **no** | **no**: no se lee nada de la página |
| `whatsapp_business_management` | **no** | **no**: no se consulta ni se administra el número |

Qué hacer con eso, en orden de menos a más trabajo:

1. **Enviar solo lo que se puede enseñar.** `instagram_manage_messages` +
   `instagram_basic` + `whatsapp_business_messaging`. Es la vía que se aprueba,
   y es la que corresponde a lo que el producto hace hoy.
2. **Construir el flujo de Facebook Login** si de verdad se quieren
   `pages_show_list` y `pages_read_engagement`: un botón de «Conectar con
   Facebook», la llamada a `/me/accounts` para listar las páginas del
   comerciante, y el intercambio del token. Es también lo que hace falta para
   que la app sirva a muchos comerciantes sin que cada uno tenga que ir a la
   consola de Meta a suscribir su página a mano.
3. **No pedir lo que no se usa.** Un permiso pedido sin camino de código es un
   rechazo, y un rechazo del App Review se lleva por delante toda la app, no un
   permiso suelto.

Mandar `pages_show_list` con el vídeo de la toma A —donde no aparece ninguna
lista de páginas por ninguna parte— no es una apuesta arriesgada: es un
rechazo con casi total seguridad, y hay que volver a empezar el ciclo entero.

Otras dos cosas que la revisión va a mirar y que hoy **sí** están:

- **La revelación de automatización**, que la antepone el sistema y no el
  modelo (`buildAutomationDisclosure`, en `services/api/src/agent/system-prompt.ts`).
  Que un modelo tenga instrucciones de decir algo no se puede demostrar; que el
  sistema lo anteponga siempre, sí.
- **La vía de escalado a una persona**, ofrecida en la propia revelación y
  respaldada por la herramienta `escalate_to_human`.

---

## 8. Respaldo: los simuladores

Siguen funcionando y no han cambiado. Sirven para cuando no hay red, cuando
Meta está caído, o para ensayar el guion sin gastar la cuenta de prueba.

```bash
pnpm run demo:ig -- "¿Tienen café de Nariño?"
pnpm run demo:wa -- "¿Cuánto vale el envío a Cali?"

pnpm run demo:ig -- --saludo          # repite el handshake GET de Meta
pnpm run demo:ig -- --igsid 9988776655 "Hola"    # otro comprador
pnpm run demo:wa -- --telefono 573001112233 "Hola"
```

Construyen una entrega de webhook con la forma exacta que documenta Meta, la
firman con `X-Hub-Signature-256` usando el App Secret que el seed dejó cifrado,
y la publican en el API local. A partir de ahí **no hay nada simulado**: el
controlador la verifica, la enruta al inquilino, el agente contesta y la
conversación aparece en el panel.

Dos cosas que hay que tener claras antes de confiar en ellos:

- **La respuesta del agente sale hacia `graph.facebook.com` con un token falso**
  y Meta la rechaza. Eso no afecta a lo que se ve —la respuesta se guarda antes
  de enviarse, así que la conversación completa está en el panel— pero significa
  que **no sirven para grabar el App Review**: en el vídeo no habría ningún
  mensaje llegando a Instagram.
- **No sirven contra la URL pública.** Están pensados para `localhost:4000`. Si
  quieres apuntarlos a otro sitio, `DEMO_API_URL`.

Su lógica está probada contra el **código de producción** que recibe la entrega
—`GraphProvider` y `CloudProvider` importados de su `dist/`— y no contra una
copia de lo que uno cree que hace Meta. Esto importa porque un webhook con la
firma mala recibe un 200 igual que uno bueno (el controlador tira en silencio
lo que no verifica, a propósito, para no revelarle a quien llama sin
autenticarse qué cuentas atiende la plataforma): desde fuera no se distingue
«lo contestó» de «lo tiró», así que la corrección se demuestra con pruebas.

```bash
pnpm run demo:test
```

---

## 9. Cuando algo falla

| Síntoma | Causa casi segura | Qué hacer |
|---|---|---|
| Meta dice que el callback falló al guardar | la URL se copió cortada en el `?`, o el token no coincide | usa el botón de Copiar del panel; `pnpm run demo:comprobar` |
| El handshake iba y ahora da error | reiniciaste y el túnel tiene otra URL | `pnpm run demo:pegar` y vuelve a pegarla en Meta |
| El panel enseña `http://api.ventia.localhost` | el API arrancó sin `API_PUBLIC_URL` | para y `pnpm run demo` otra vez; el túnel sube **antes** que el API |
| El mensaje sale del teléfono y no aparece nada | firma mala (App Secret equivocado) | el endpoint responde 200 a todo a propósito; mira el `api.log` que imprimió el arranque |
| La conversación aparece y el agente no contesta | falta `ANTHROPIC_API_KEY`, o se agotó el tope mensual | el arranque comprueba la clave; el tope se ve en **Consumo** |
| `cloudflared` no está | — | el arranque te da el comando exacto para tu sistema |
| Todo va bien pero la respuesta no llega al teléfono | token de acceso caducado (el temporal dura una hora) | genera uno de usuario de sistema y vuelve a conectar la cuenta |

Y la regla general de este canal: **el endpoint de webhooks responde 200 a
todo**, incluso a un payload con la firma mala o de una cuenta desconocida. Es
deliberado —un 4xx le diría a cualquiera qué cuentas atiende la plataforma, y
haría que Meta reintentara una entrega que nunca va a ser válida— pero implica
que **la ausencia de una conversación en el panel es la señal, no un mensaje de
error**. Cuando algo no aparezca, el sitio donde mirar es el log del API.
