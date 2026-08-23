#!/usr/bin/env bash
#
# Levanta TODO lo que hace falta para grabar la demo, en un solo comando.
#
#   pnpm run demo                # arranca y siembra
#   pnpm run demo:limpio         # además, borra lo que ensució la toma anterior
#
# Orden y por qué:
#
#   0. Comprobar ANTHROPIC_API_KEY ANTES de arrancar nada. Sin ella el API
#      arranca perfectamente y el agente no contesta, sin ningún error: es el
#      fallo más caro de descubrir en mitad de una grabación.
#   1. Docker (postgres, redis, minio, caddy) y esperar a que respondan.
#   2. Construir los paquetes de la biblioteca: el API y las dos apps de Next
#      resuelven `@ventia/*` por su `dist/`, y un `dist/` viejo se manifiesta
#      como un error de tipos raro o, peor, como comportamiento antiguo.
#   3. Migrar la base.
#   4. Arrancar el API y esperar a /v1/health.
#   5. Crear la cuenta de la dueña por el camino real de registro (necesita el
#      API arriba).
#   6. Subir las imágenes a MinIO — ANTES de sembrar, porque el seed comprueba
#      con un HEAD que cada foto existe antes de escribir su fila.
#   7. Sembrar la demo.
#   8. Arrancar el panel y la tienda, y esperar a que compilen.
#
# Se queda en primer plano. Ctrl-C para y limpia los tres servidores.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
cd "$RAIZ"

LIMPIO=0
SIN_FOTOS=0
for arg in "$@"; do
  case "$arg" in
    --limpio) LIMPIO=1 ;;
    --sin-fotos) SIN_FOTOS=1 ;;
    --ayuda | -h)
      # La cabecera de este mismo archivo, hasta el primer renglón que ya no
      # sea comentario. Una ayuda que se saca del código no se queda vieja.
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Opción desconocida: $arg  (usa --ayuda)" >&2
      exit 1
      ;;
  esac
done

# shellcheck source=scripts/demo/entorno.sh
source "$AQUI/entorno.sh"
exigir_clave_anthropic

LOGS="${DEMO_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/ventia-demo.XXXXXX")}"
mkdir -p "$LOGS"

echo
echo "== Demo Ventia =="
echo "   logs: $LOGS"
echo

# --- 1. docker ---------------------------------------------------------------
echo "-> Stack de docker"
docker compose -f docker/compose.yaml up -d >"$LOGS/docker.log" 2>&1
for intento in $(seq 1 60); do
  if docker compose -f docker/compose.yaml exec -T postgres pg_isready -U ventia >/dev/null 2>&1; then break; fi
  if [ "$intento" -eq 60 ]; then
    echo "  ERROR: postgres no arrancó. Mira $LOGS/docker.log" >&2
    exit 1
  fi
  sleep 1
done
echo "  postgres, redis, minio y caddy arriba"

# --- 2. construir la biblioteca ---------------------------------------------
echo "-> Construyendo los paquetes (turbo cachea; en la segunda vez es instantáneo)"
pnpm exec turbo run build --filter='./packages/*' >"$LOGS/build.log" 2>&1 || {
  echo "  ERROR: falló la construcción. Mira $LOGS/build.log" >&2
  exit 1
}

# --- 3. migraciones ----------------------------------------------------------
echo "-> Migraciones"
pnpm --filter @ventia/db run migrate:deploy >"$LOGS/migrate.log" 2>&1 || {
  echo "  ERROR: fallaron las migraciones. Mira $LOGS/migrate.log" >&2
  exit 1
}
echo "  base al día"

# --- servidores --------------------------------------------------------------
PIDS=()
limpiar() {
  local estado=$?
  echo
  echo "-> Parando los servidores"
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill -- "-$pid" 2>/dev/null || true
  done
  echo "   logs en: $LOGS"
  exit "$estado"
}
trap limpiar EXIT INT TERM

arrancar() {
  local log="$1" cmd="$2"
  setsid bash -c "$cmd" >"$log" 2>&1 &
  PIDS+=("$!")
}

echo "-> Liberando los puertos 3000/3001/4000 por si quedó algo de una toma anterior"
fuser -k 3000/tcp 3001/tcp 4000/tcp >/dev/null 2>&1 || true
sleep 1

echo "-> API"
arrancar "$LOGS/api.log" "cd '$RAIZ/services/api' && pnpm run dev"
esperar_url "$API_INTERNAL_URL/v1/health" "API" 120 || {
  echo "  Mira $LOGS/api.log" >&2
  exit 1
}

# --- 5-7. datos --------------------------------------------------------------
echo "-> Cuenta de la dueña"
node scripts/demo/usuario.mjs

if [ "$SIN_FOTOS" -eq 0 ]; then
  echo "-> Imágenes"
  # Un fallo aquí NO para el arranque: sin fotos la tienda dibuja el marcador
  # de "sin foto", que está diseñado y se puede grabar. Parar por esto sería
  # cambiar un problema cosmético por uno que impide grabar.
  node scripts/demo/fotos.mjs || echo "  AVISO: no se pudieron subir las imágenes; la tienda quedará con el marcador de 'sin foto'."
fi

echo "-> Sembrando la demo"
SEED_ARGS=()
[ "$LIMPIO" -eq 1 ] && SEED_ARGS+=(--reiniciar)
[ "$SIN_FOTOS" -eq 1 ] && SEED_ARGS+=(--sin-fotos)
pnpm --filter @ventia/db exec tsx src/seed-demo.ts ${SEED_ARGS[@]+"${SEED_ARGS[@]}"}

# --- 8. panel y tienda -------------------------------------------------------
echo "-> Panel"
arrancar "$LOGS/admin.log" "cd '$RAIZ/apps/admin' && API_INTERNAL_URL='$API_INTERNAL_URL' pnpm run dev"
echo "-> Tienda"
arrancar "$LOGS/storefront.log" "cd '$RAIZ/apps/storefront' && API_INTERNAL_URL='$API_INTERNAL_URL' pnpm run dev"
esperar_url "http://localhost:3001/" "panel" 180 || { echo "  Mira $LOGS/admin.log" >&2; exit 1; }
esperar_url "http://localhost:3000/" "tienda" 180 || { echo "  Mira $LOGS/storefront.log" >&2; exit 1; }

# Next compila cada ruta la primera vez que se pide, y esa primera compilación
# tarda varios segundos. Hacerlas ahora, y no en cámara, es la diferencia entre
# una toma fluida y una pantalla en blanco esperando.
echo "-> Precalentando las rutas que se van a grabar"
for ruta in / /conversaciones /productos /pedidos /clientes /consumo /configuracion; do
  curl -s -o /dev/null -m 30 "http://localhost:3001${ruta}" || true
done
for ruta in / /carrito /envios /cambios-y-devoluciones /contacto /productos/cafe-narino-el-mirador-340g /categorias/cafe; do
  curl -s -o /dev/null -m 30 "http://localhost:3000${ruta}" || true
done
echo "  listo"

DOMINIO_TIENDA="$(node -p "JSON.parse(require('fs').readFileSync('scripts/demo/demo.json','utf8')).urls.tienda")"
CORREO="$(node -p "JSON.parse(require('fs').readFileSync('scripts/demo/demo.json','utf8')).duena.email")"
CLAVE="$(node -p "JSON.parse(require('fs').readFileSync('scripts/demo/demo.json','utf8')).duena.clave")"

cat <<FIN

  ============================================================
   Todo arriba. Para grabar:

     Tienda    $DOMINIO_TIENDA
     Panel     $ADMIN_URL
               $CORREO  /  $CLAVE

   Mensajes entrantes (otra terminal, sin parar esto):

     node scripts/demo/ig.mjs "¿Tienen café de Nariño?"
     node scripts/demo/wa.mjs "¿Cuánto vale el envío a Cali?"

   Volver al punto de partida entre tomas, en segundos:

     pnpm run demo:reiniciar

   Ctrl-C para parar.
  ============================================================

FIN

wait
