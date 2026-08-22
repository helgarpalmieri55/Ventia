-- InstagramAccount: la tabla de enrutamiento de entrada del canal de
-- Instagram, hermana de `WhatsAppNumber` (20260818120000_whatsapp_numbers).
--
-- CreateEnum
CREATE TYPE "InstagramProviderId" AS ENUM ('graph');

-- CreateTable
CREATE TABLE "InstagramAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" "InstagramProviderId" NOT NULL DEFAULT 'graph',
    "igAccountId" TEXT NOT NULL,
    "pageId" TEXT,
    "username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "credentialsEnc" TEXT,
    "verifyToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramAccount_pkey" PRIMARY KEY ("id")
);

-- La clave de enrutamiento, y el motivo por el que esto es una tabla y no otra
-- clave dentro de `Tenant.settings`.
--
-- UNIQUE en toda la plataforma, deliberadamente NO única por inquilino. Meta
-- entrega un webhook por app cubriendo todas las cuentas de Instagram
-- conectadas a ella, así que una entrega identifica a su inquilino con nada
-- más que `entry[].id`. Si dos inquilinos pudieran reclamar ese valor, la
-- búsqueda devuelve dos filas y no hay forma no arbitraria de elegir una — y
-- "arbitraria" aquí significa los clientes de una tienda hablando con el
-- agente de otra, entregándole su conversación y los pedidos que las
-- herramientas del agente saben leer.
--
-- O sea que este índice es una propiedad de seguridad, no orden. La
-- comprobación que hace el flujo de conexión del admin ("¿esta cuenta ya está
-- conectada?") es un comprobar-y-actuar con carrera; el índice UNIQUE es la
-- única parte que aguanta concurrencia, y es lo que hace que registrar la
-- cuenta de otro —por error o a mala fe— falle a gritos en vez de robarle el
-- tráfico en silencio.
-- CreateIndex
CREATE UNIQUE INDEX "InstagramAccount_igAccountId_key" ON "InstagramAccount"("igAccountId");

-- CreateIndex
CREATE INDEX "InstagramAccount_tenantId_idx" ON "InstagramAccount"("tenantId");

-- AddForeignKey. ON DELETE CASCADE: un inquilino borrado no puede dejar viva
-- una entrada de enrutamiento — una fila huérfana seguiría casando entregas de
-- una tienda que ya no existe y, como `igAccountId` es único global, además
-- impediría volver a conectar esa cuenta nunca.
ALTER TABLE "InstagramAccount" ADD CONSTRAINT "InstagramAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Privilegios: esta tabla guarda secretos, así que `ventia_app` recibe menos
-- que el trato estándar de una tabla de inquilino en LOS DOS ejes. Misma
-- postura, y por las mismas razones, que `WhatsAppNumber`.
-- ---------------------------------------------------------------------------
--
-- 20260723182728_rls dejó un `ALTER DEFAULT PRIVILEGES ... GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO ventia_app`, así que una tabla creada por
-- una migración posterior nace completamente escribible por el código con
-- ámbito de inquilino salvo que diga lo contrario. Esta lo dice. Primero se
-- revoca todo y luego se concede solo lo que el admin necesita de verdad:
-- partir de cero en vez de restar del valor por defecto significa que un cambio
-- futuro en esos privilegios por defecto no puede ensanchar esta tabla sin que
-- nadie se entere.
REVOKE ALL PRIVILEGES ON TABLE "InstagramAccount" FROM ventia_app;

-- ## Por qué ningún INSERT/UPDATE/DELETE para ventia_app
--
-- `igAccountId` es la clave de enrutamiento, y que un inquilino tenga derecho a
-- una cuenta de Instagram concreta no es una restricción de base de datos: es
-- el saludo con Meta que hace el flujo de conexión. Un INSERT con ámbito de
-- inquilino dejaría que un comerciante registrara cualquier cuenta *sin
-- reclamar* y empezara a recibir las conversaciones de otro negocio en cuanto
-- ese negocio intentara conectarse; un UPDATE dejaría que reapuntara una fila
-- existente. El índice UNIQUE de arriba corta el caso de colisión, y esto corta
-- el de ocupación.
--
-- No se pierde ninguna capacidad, solo se muda: el flujo de conexión del admin
-- tiene que correr sobre `platformDb` de todas formas, porque cifra las
-- credenciales con la llave de plataforma (services/api/src/payments/
-- encryption.ts), que es un secreto de la plataforma y no del inquilino.

-- ## Por qué el SELECT se concede por COLUMNAS y no por tabla
--
-- El admin tiene una necesidad real: la pestaña de Instagram lista la cuenta
-- conectada con su @usuario y su estado, para que el comerciante vea si el
-- canal está funcionando.
--
-- Pero dos de estas columnas son secretos. `credentialsEnc` es un blob
-- AES-256-GCM con el token de página y el app secret; `verifyToken` es el
-- secreto compartido en claro contra el que se valida el saludo GET de Meta —
-- justo lo que hace falta para completar una suscripción de webhook contra el
-- endpoint de esta plataforma.
--
-- Un GRANT a nivel de tabla más disciplina para no seleccionar esas columnas no
-- vale: `findMany()` sin `select` emite todas las columnas, y una propiedad que
-- depende de que nadie escriba nunca lo obvio no es una propiedad. Con el GRANT
-- por columnas, un `tenantDb(t).instagramAccount.findMany()` sin `select`
-- explícito falla a gritos (42501, "permission denied for table
-- InstagramAccount") en vez de cargar el token en memoria.
--
-- Se comprobó con `has_column_privilege` en vez de darlo por supuesto: la
-- migración de `costMicroUsd` (20260821200000_agent_usage_cost_micro_usd) dejó
-- escrito lo que pasa cuando no se comprueba. Ojo también con la otra mitad de
-- esa lección: `REVOKE SELECT ("columna")` contra un GRANT de tabla no hace
-- absolutamente nada, así que aquí se revoca la tabla entera ANTES y se concede
-- columna por columna, y cualquier columna que se añada a esta tabla en el
-- futuro nace SIN permiso y hay que concederla a mano — que es la dirección
-- segura en la que fallar.
GRANT SELECT ("id", "tenantId", "provider", "igAccountId", "pageId", "username", "status", "createdAt", "updatedAt")
  ON TABLE "InstagramAccount" TO ventia_app;

-- ## Seguridad a nivel de fila
--
-- Segunda capa independiente, igual que en cualquier otra tabla de inquilino:
-- ni un servicio que se olvide del `where`, ni un camino que la extensión del
-- cliente no cubra, pueden ver las cuentas de otro.
--
-- Solo `FOR SELECT`, en consonancia con los grants. No hay cláusula WITH CHECK
-- porque no hay privilegio de escritura al que aplicarla.
--
-- El `nullif(..., '')` está copiado tal cual de 20260723182728_rls: una
-- conexión reutilizada del pool cuyo GUC se haya fijado alguna vez lo deja en
-- '' y no en NULL, y ''::uuid levanta un error de conversión en vez de dar "sin
-- contexto => ninguna fila".
ALTER TABLE "InstagramAccount" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "InstagramAccount"
  FOR SELECT
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ## Por qué ENABLE y no FORCE
--
-- Mismo motivo, y con el mismo filo, que en `WhatsAppNumber`: FORCE extendería
-- la política al dueño de la tabla, que es `platformDb`, que es la conexión que
-- hace la búsqueda de enrutamiento de entrada. Esa búsqueda es previa al
-- inquilino por naturaleza — resolver `igAccountId -> tenantId` es CÓMO se
-- llega a saber el inquilino —, así que no hay ningún `app.tenant_id` fijado
-- todavía; bajo FORCE la política evaluaría contra NULL, no casaría ninguna
-- fila, y todos los mensajes de Instagram de la plataforma se caerían como
-- "cuenta desconocida". El canal quedaría roto de la forma más difícil de
-- notar: en silencio y solo en producción.
