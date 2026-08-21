-- Tres cambios que el diseño de `ai-commerce-complete` necesita y que hoy no
-- tienen dónde vivir. Van juntos porque los tres son de esquema y pequeños;
-- separarlos serían tres despliegues para desbloquear una sola pantalla.

-- ---------------------------------------------------------------------------
-- 1. SalesChannel — DÓNDE estaba el comprador
--
-- `CartSource` responde QUIÉN armó el carrito (`web` = el comprador solo,
-- `agent` = la IA) y eso es lo que sostiene la atribución de P4: el panel
-- cuenta pedidos con `source = 'agent'` para mostrarle al comerciante qué
-- vendió la IA. Sus dos valores no se tocan.
--
-- Lo que faltaba es la otra dimensión. Un pedido que la IA armó por WhatsApp y
-- uno que armó en el chat de la tienda hoy son indistinguibles, y el anillo de
-- "canales de venta" del diseño no tiene de dónde salir.
--
-- `instagram` no tiene todavía camino de entrada en el código. Existe porque el
-- comerciante sí vende por ahí y va a querer registrarlo — el valor del enum es
-- lo barato, cambiar el enum después es lo caro.
CREATE TYPE "SalesChannel" AS ENUM ('web', 'whatsapp', 'instagram', 'other');

-- DEFAULT 'web' y no NULL: toda fila existente nació en la tienda web o en el
-- chat web, así que el respaldo es cierto para los datos que ya hay, no una
-- suposición cómoda. Cuando el canal de WhatsApp empiece a marcarse, lo hará
-- solo sobre filas nuevas.
ALTER TABLE "Cart"  ADD COLUMN "channel" "SalesChannel" NOT NULL DEFAULT 'web';
ALTER TABLE "Order" ADD COLUMN "channel" "SalesChannel" NOT NULL DEFAULT 'web';

-- ---------------------------------------------------------------------------
-- 2. Categorías anidadas — la miga de pan `Inicio > Mujer > Ropa`
--
-- ON DELETE SET NULL, no CASCADE: borrar "Mujer" no puede llevarse "Ropa" y con
-- ella la relación de cada producto que colgaba de ahí. Los hijos suben a
-- primer nivel, que es visible y reparable; un borrado en cascada de catálogo
-- no lo es.
--
-- La base NO impide ciclos ni profundidad: una fila puede apuntarse a sí misma
-- sin violar esta llave foránea. Eso se valida en la aplicación antes de
-- escribir, y el índice de abajo es lo que hace barato ese recorrido de
-- ancestros.
ALTER TABLE "Category" ADD COLUMN "parentId" UUID;
ALTER TABLE "Category"
  ADD CONSTRAINT "Category_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Category_tenantId_parentId_idx" ON "Category" ("tenantId", "parentId");

-- ---------------------------------------------------------------------------
-- Sin cambios de GRANT. `Cart`, `Order` y `Category` son tablas de tenant y
-- 20260723182728_rls concedió a `ventia_app` a nivel de TABLA, que cubre
-- columnas agregadas después. Las políticas RLS son por fila y no las afecta
-- una columna nueva. Verificado con has_column_privilege, no supuesto.
