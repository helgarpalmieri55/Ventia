-- Planes: básico/pro/premium -> emprende/crece/escala, y la unidad de cobro
-- pasa de mensajes a créditos ponderados.
--
-- `ALTER TYPE ... RENAME VALUE` conserva los datos: cada fila que decía
-- 'basico' dice 'emprende' después, sin reescribir la tabla y sin un paso
-- intermedio donde el valor no exista.
ALTER TYPE "Plan" RENAME VALUE 'basico'  TO 'emprende';
ALTER TYPE "Plan" RENAME VALUE 'pro'     TO 'crece';
ALTER TYPE "Plan" RENAME VALUE 'premium' TO 'escala';

ALTER TABLE "Tenant" ALTER COLUMN "plan" SET DEFAULT 'emprende';

-- Renombrar, no crear-y-copiar: el cupo de cada inquilino se conserva tal
-- cual y el UPDATE de abajo lo lleva a los valores del plan nuevo.
ALTER TABLE "TenantLimits" RENAME COLUMN "aiMessagesMonth" TO "aiCreditsMonth";

ALTER TABLE "TenantLimits" ADD COLUMN "instagramChannel" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgentUsage" ADD COLUMN "creditsUsed" INTEGER NOT NULL DEFAULT 0;

-- El consumo que ya está registrado se hizo cuando un mensaje era un crédito,
-- así que arrastrarlo uno a uno es exacto, no una aproximación.
UPDATE "AgentUsage" SET "creditsUsed" = "messagesCount";

-- Llevar a los inquilinos existentes a los límites de la opción A. Se hace
-- por plan y no fila a fila porque `TenantLimits` es una copia de los límites
-- del plan, no una negociación por cliente; si algún día hay cupos a medida,
-- este UPDATE es lo primero que hay que revisar.
UPDATE "TenantLimits" l SET
  "productsMax"      = 300,
  "aiCreditsMonth"   = 500,
  "staffSeats"       = 1,
  "customDomain"     = false,
  "humanHandoff"     = false,
  "whatsappChannel"  = true,
  "instagramChannel" = false
FROM "Tenant" t WHERE t.id = l."tenantId" AND t.plan = 'emprende';

UPDATE "TenantLimits" l SET
  "productsMax"      = 3000,
  "aiCreditsMonth"   = 1200,
  "staffSeats"       = 5,
  "customDomain"     = true,
  "humanHandoff"     = true,
  "whatsappChannel"  = true,
  "instagramChannel" = true
FROM "Tenant" t WHERE t.id = l."tenantId" AND t.plan = 'crece';

UPDATE "TenantLimits" l SET
  "productsMax"      = 1000000,
  "aiCreditsMonth"   = 2800,
  "staffSeats"       = 15,
  "customDomain"     = true,
  "humanHandoff"     = true,
  "whatsappChannel"  = true,
  "instagramChannel" = true
FROM "Tenant" t WHERE t.id = l."tenantId" AND t.plan = 'escala';

-- `AgentUsage` no tiene grant a nivel de tabla: la migración de `costMicroUsd`
-- hizo REVOKE SELECT ON TABLE y volvió a conceder columna por columna, porque
-- un REVOKE por columna contra un GRANT de tabla no hace absolutamente nada.
-- Así que toda columna nueva nace sin permiso para ventia_app y hay que
-- concederla a mano. `creditsUsed` es cupo consumido, no coste en dólares:
-- va del lado visible.
GRANT SELECT ("creditsUsed") ON TABLE "AgentUsage" TO ventia_app;
