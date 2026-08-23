#!/usr/bin/env bash
#
# Deja la tienda de demo como recién sembrada, para poder repetir una toma.
#
#   pnpm run demo:reiniciar
#
# Borra lo que ensucia una grabación —conversaciones, pedidos, carritos,
# movimientos de inventario y el consumo de IA del mes— y vuelve a sembrar el
# catálogo, las políticas y los pedidos de muestra.
#
# NO toca el inquilino, ni la cuenta de la dueña, ni su membresía, ni los
# servidores. Ese es el punto: la sesión del panel sigue abierta, las tres
# aplicaciones siguen corriendo y esto tarda un par de segundos, que es lo que
# uno tiene entre toma y toma.
#
# Tampoco vuelve a subir las imágenes: ya están en MinIO. Si hiciera falta,
# `node scripts/demo/fotos.mjs`.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AQUI/../.."

# shellcheck source=scripts/demo/entorno.sh
source "$AQUI/entorno.sh"

pnpm --filter @ventia/db exec tsx src/seed-demo.ts --reiniciar "$@"

# La resolución de dominio a inquilino está cacheada en Redis 60 segundos
# (`DomainResolver`, ttlSeconds = 60). Sin vaciarla, un cambio de nombre, de
# tema o de logo tarda hasta un minuto en verse — y en una regrabación ese
# minuto se pasa mirando una pantalla que parece rota. Es un mejor esfuerzo:
# si no hay docker a mano, el TTL lo arregla solo.
DOMINIO="$(node -p "JSON.parse(require('fs').readFileSync('scripts/demo/demo.json','utf8')).tienda.dominio")"
docker compose -f docker/compose.yaml exec -T redis redis-cli DEL "tenant:domain:$DOMINIO" >/dev/null 2>&1 || true
