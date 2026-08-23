#!/usr/bin/env bash
#
# Ejecuta un comando con el entorno de la demo ya cargado (`.env` de la raíz
# más los valores por defecto de desarrollo).
#
#   bash scripts/demo/con-entorno.sh node scripts/demo/fotos.mjs
#
# Existe porque `fotos.mjs` y el seed necesitan S3_* y PAYMENTS_ENCRYPTION_KEY,
# y llamarlos a pelo desde un `pnpm run` los dejaría sin ellos — con el
# resultado de subir a un MinIO que no es, o de cifrar con una llave que la API
# luego no puede descifrar.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AQUI/../.."

# shellcheck source=scripts/demo/entorno.sh
source "$AQUI/entorno.sh"

exec "$@"
