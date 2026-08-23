#!/usr/bin/env bash
#
# Para los tres servidores de desarrollo de la demo.
#
#   pnpm run demo:parar
#
# `arranque.sh` ya los limpia al recibir Ctrl-C. Esto es para cuando quedó algo
# suelto — una terminal cerrada de golpe, una toma interrumpida — y el
# siguiente arranque se encontraría los puertos ocupados.
#
# Deja el docker en pie a propósito: parar postgres tira la base sembrada del
# caché de página y arrancarlo otra vez cuesta más que el problema que
# resuelve. Para bajarlo todo:  docker compose -f docker/compose.yaml down
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.."

fuser -k 3000/tcp 3001/tcp 4000/tcp >/dev/null 2>&1 || true
echo "  puertos 3000, 3001 y 4000 liberados (el docker sigue arriba)"
