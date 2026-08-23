#!/usr/bin/env bash
#
# Para los tres servidores de desarrollo de la demo y cierra el túnel público.
#
#   pnpm run demo:parar
#
# `arranque.sh` ya los limpia al recibir Ctrl-C. Esto es para cuando quedó algo
# suelto — una terminal cerrada de golpe, una toma interrumpida — y el
# siguiente arranque se encontraría los puertos ocupados, o un cloudflared
# huérfano sirviendo una URL que ya no lleva a ninguna parte.
#
# Deja el docker en pie a propósito: parar postgres tira la base sembrada del
# caché de página y arrancarlo otra vez cuesta más que el problema que
# resuelve. Para bajarlo todo:  docker compose -f docker/compose.yaml down
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.."

# shellcheck source=scripts/demo/entorno.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/entorno.sh"

fuser -k 3000/tcp 3001/tcp 4000/tcp >/dev/null 2>&1 || true

# El túnel no ocupa ningún puerto local, así que `fuser` no lo ve: hay que
# buscarlo por su línea de comando. El patrón es el EXACTO que lanza
# `tunel.sh`, para no llevarse por delante un túnel con nombre que quien graba
# tenga levantado para otra cosa.
pkill -f "cloudflared tunnel --no-autoupdate --url http://localhost:" >/dev/null 2>&1 || true

# Y su rastro. Una URL de un túnel que ya no existe, leída por `demo:pegar` en
# la siguiente sesión, se pega en Meta con toda confianza y no funciona.
rm -f "$ARCHIVO_TUNEL"

echo "  puertos 3000, 3001 y 4000 liberados, túnel cerrado (el docker sigue arriba)"
