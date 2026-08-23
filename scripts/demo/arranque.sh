#!/usr/bin/env bash
#
# Levanta TODO lo que hace falta para grabar la demo, en un solo comando.
#
#   pnpm run demo                # arranca y siembra
#   pnpm run demo:limpio         # además, borra lo que ensució la toma anterior
#   pnpm run demo --sin-tunel    # sin URL pública (solo simuladores)
#
# Orden y por qué:
#
#   0. Comprobar ANTHROPIC_API_KEY y cloudflared ANTES de arrancar nada. Sin la
#      clave el API arranca perfectamente y el agente no contesta, sin ningún
#      error: es el fallo más caro de descubrir en mitad de una grabación. Y
#      sin cloudflared no hay URL pública, que es lo único que hace que Meta
#      pueda entregar un mensaje real a esta máquina. Las dos cosas se miran
#      aquí y no dos minutos más tarde, cuando ya se gastó el tiempo.
#   1. Docker (postgres, redis, minio, caddy) y esperar a que respondan.
#   2. Construir los paquetes de la biblioteca: el API y las dos apps de Next
#      resuelven `@ventia/*` por su `dist/`, y un `dist/` viejo se manifiesta
#      como un error de tipos raro o, peor, como comportamiento antiguo.
#   3. Migrar la base.
#   3b. Levantar el túnel público y exportar API_PUBLIC_URL. ANTES del API, sin
#      excepción: esa variable la lee el proceso del API de su entorno
#      (`apiPublicUrl()` en los dos controladores de admin de mensajería) y un
#      proceso no hereda lo que se exportó después de arrancarlo. Si el túnel
#      sube tarde, el panel enseña `http://api.ventia.localhost` en el botón de
#      copiar, esa URL se pega en Meta, y el fallo aparece media hora después
#      disfrazado de "Instagram no funciona".
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
SIN_TUNEL=0
for arg in "$@"; do
  case "$arg" in
    # `pnpm run demo -- --sin-tunel` mete un `--` suelto en argv. Sin esta
    # rama se rechazaría como opción desconocida — y esa es justo la forma que
    # documenta pnpm para pasar banderas a un script.
    --) ;;
    --limpio) LIMPIO=1 ;;
    --sin-fotos) SIN_FOTOS=1 ;;
    --sin-tunel) SIN_TUNEL=1 ;;
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
# shellcheck source=scripts/demo/tunel.sh
source "$AQUI/tunel.sh"
exigir_clave_anthropic

# Se comprueba ahora, no cuando toque levantarlo: descubrir que falta
# cloudflared después de docker, de la compilación y de las migraciones es
# descubrirlo cuando ya se perdieron dos minutos. No se comprueba si ya hay una
# URL pública puesta a mano ni si se pidió expresamente no tener túnel.
if [ "$SIN_TUNEL" -eq 0 ] && [ -z "${API_PUBLIC_URL:-}" ]; then
  exigir_cloudflared
fi

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

if [ "$SIN_TUNEL" -eq 1 ]; then
  # Un aviso y no un silencio: sin túnel el panel enseñará una URL de callback
  # que Meta no puede alcanzar, y eso hay que saberlo ANTES de copiarla.
  echo "-> Túnel público: OMITIDO (--sin-tunel)"
  echo "   El panel enseñará http://api.ventia.localhost como URL de callback y Meta"
  echo "   no puede alcanzarla. Para esta toma solo sirven los simuladores ig.mjs/wa.mjs."
  # La URL que dejó escrita una ejecución anterior ya no existe, y dejarla ahí
  # haría que `demo:pegar` la imprimiera con toda seguridad. Una URL muerta
  # impresa con seguridad es peor que ninguna.
  rm -f "$ARCHIVO_TUNEL"
else
  echo "-> Túnel público"
  arrancar_tunel "$LOGS/tunel.log" || {
    echo "  Mira $LOGS/tunel.log" >&2
    exit 1
  }
  # Al grupo de procesos que limpia el trap, para que Ctrl-C se lo lleve también.
  # PID_TUNEL viene vacío cuando no se levantó ningún proceso (el caso de
  # API_PUBLIC_URL ya puesta a mano). El `|| true` deja explícito que ese
  # estado 1 es esperado y no un fallo: bash con `set -e` ya lo perdona por
  # venir de una lista `&&`, pero eso depende de una regla sutil y esto es lo
  # último del bloque, que es justo donde esa clase de sorpresa duele.
  { [ -n "${PID_TUNEL:-}" ] && PIDS+=("$PID_TUNEL"); } || true
fi

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

   Todo arriba. Para grabar:

     Tienda    $DOMINIO_TIENDA
     Panel     $ADMIN_URL
               $CORREO  /  $CLAVE

   Volver al punto de partida entre tomas:  pnpm run demo:reiniciar
   Respaldo sin Meta (otra terminal):       pnpm run demo:ig -- "¿Tienen café de Nariño?"
                                            pnpm run demo:wa -- "¿Cuánto vale el envío a Cali?"
   Ctrl-C para parar.
FIN

# Lo ÚLTIMO que se imprime, y en un bloque que cabe entero en pantalla, es lo
# que hay que copiar a Meta. Va al final a propósito: es lo que se busca con
# los ojos al volver a esta terminal, y buscarlo hacia arriba entre logs de
# arranque es exactamente donde se copia una URL a medias.
# El `||` no es paranoia de más: esto es lo último antes del `wait`, y con
# `set -e` un fallo aquí mataría un stack que ya está entero y funcionando por
# no haber podido imprimir un recuadro.
node scripts/demo/pegar.mjs || echo "  (no se pudo imprimir el bloque para Meta; vuelve a pedirlo con: pnpm run demo:pegar)"

wait
