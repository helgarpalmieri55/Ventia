#!/usr/bin/env bash
#
# Siembra la tienda de demo contra una base que ya está migrada.
#
#   pnpm run demo:seed              # siembra o resiembra
#   pnpm run demo:seed --sin-fotos  # sin comprobar imágenes en MinIO
#
# Para arrancarlo todo desde cero, `pnpm run demo`. Para volver al punto de
# partida entre tomas, `pnpm run demo:reiniciar`.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AQUI/../.."

# shellcheck source=scripts/demo/entorno.sh
source "$AQUI/entorno.sh"

pnpm --filter @ventia/db exec tsx src/seed-demo.ts "$@"
