#!/usr/bin/env bash
#
# El túnel público que hace que Meta pueda alcanzar el API de esta máquina.
#
#   bash scripts/demo/tunel.sh          # levanta el túnel y se queda
#   pnpm run demo:tunel                 # lo mismo
#
# También se carga con `source` desde `arranque.sh`, que es el camino normal.
#
# ## Por qué hace falta
#
# Meta entrega los webhooks desde sus servidores. No puede alcanzar
# `localhost`, ni `api.ventia.localhost`, ni ninguna IP privada. Sin una URL
# pública HTTPS no hay forma de grabar un mensaje REAL de Instagram o WhatsApp:
# el mensaje sale del teléfono, llega a Meta, y ahí se queda.
#
# ## Por qué apunta al 4000 y no al 80
#
# Caddy enruta por `Host`, y el Host que llega por el túnel es
# `algo.trycloudflare.com`, que no casa con ningún bloque del `docker/Caddyfile`.
# Pasar por Caddy daría un 404 en cada entrega. Se apunta directamente al Nest,
# que no mira el Host (`TenantMiddleware` deja `req.tenant` en null ante un
# dominio desconocido y sigue, y los controladores de webhooks no lo usan).
#
# ## Por qué antes del API y no después
#
# `API_PUBLIC_URL` la lee el proceso del API, y la lee de su ENTORNO. Un
# proceso no puede heredar una variable que se exportó después de arrancarlo:
# si el túnel sube tarde, el panel enseña `http://api.ventia.localhost` en el
# botón de copiar de Configuración → Instagram / WhatsApp. Esa URL se pega en
# Meta, Meta no la alcanza, y el fallo aparece media hora más tarde disfrazado
# de "Instagram no funciona".
set -euo pipefail

AQUI_TUNEL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Dónde queda escrita la URL para que la lean OTRAS terminales. La definición
# de referencia está en `entorno.sh`, que es lo que cargan todos los comandos
# de la demo; esto es el respaldo para cuando este archivo se usa suelto.
ARCHIVO_TUNEL="${ARCHIVO_TUNEL:-${TMPDIR:-/tmp}/ventia-demo-tunel-$(id -u).url}"
export ARCHIVO_TUNEL

# El puerto donde escucha el Nest. Mismo valor por defecto que API_INTERNAL_URL.
PUERTO_TUNEL="${DEMO_TUNEL_PUERTO:-4000}"

# Cuánto se espera a que cloudflared publique la URL. Un quick tunnel tarda
# entre 3 y 10 segundos; 60 es holgado sin llegar a parecer que se colgó.
ESPERA_TUNEL="${DEMO_TUNEL_ESPERA:-60}"

# El comando de instalación sale de `lib/tunel.mjs`, que es donde está probado
# por plataforma. El respaldo de la derecha existe para el único caso en que
# esa llamada puede no dar nada —un `node` que no arranca— porque un mensaje
# que dice "instálalo con esto:" y deja el renglón en blanco es peor que no
# decir nada.
_comando_instalar_cloudflared() {
  local salida
  salida="$(node -e "
    import('${AQUI_TUNEL}/lib/tunel.mjs').then((m) => process.stdout.write(m.comandoInstalacion()));
  " 2>/dev/null || true)"
  if [ -n "$salida" ]; then
    printf '%s' "$salida"
  else
    printf '%s' 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  fi
}

# Comprueba que `cloudflared` existe ANTES de que el arranque gaste dos minutos
# en docker y en compilar. Descubrir que falta al final es descubrirlo cuando
# ya se perdió el tiempo.
exigir_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then return 0; fi
  cat >&2 <<FIN

  Falta cloudflared, y sin él no hay URL pública.

  Meta entrega los webhooks desde sus servidores y NO puede alcanzar localhost.
  Sin túnel se puede grabar la tienda y el panel, pero no un mensaje real de
  Instagram o de WhatsApp: el mensaje nunca llegaría a esta máquina.

  Instálalo con esto y vuelve a lanzarlo:

      $(_comando_instalar_cloudflared)

  Otras dos salidas, si no quieres instalarlo ahora:

    * Tienes ya una URL pública (un ngrok tuyo, un dominio de verdad):
          export API_PUBLIC_URL=https://tu-dominio-publico
          pnpm run demo

    * No necesitas Meta en esta toma y te vale con los simuladores:
          pnpm run demo --sin-tunel

FIN
  return 1
}

# Levanta el túnel y deja `API_PUBLIC_URL` exportada.
#
# Deja el PID en PID_TUNEL para que quien llama lo meta en su lista de procesos
# a matar. Si ya había una URL pública puesta a mano NO levanta nada y devuelve
# 0 con PID_TUNEL vacío: quien exportó API_PUBLIC_URL sabe lo que hace, y un
# túnel encima solo añadiría un segundo camino que se puede caer. El 1 queda
# reservado para lo que de verdad es un fallo — falta cloudflared, o el túnel
# no publicó URL.
arrancar_tunel() {
  local log="${1:-/dev/null}"
  PID_TUNEL=""

  if [ -n "${API_PUBLIC_URL:-}" ]; then
    echo "  API_PUBLIC_URL ya venía puesta: $API_PUBLIC_URL  (no se levanta túnel)"
    printf '%s\n' "$API_PUBLIC_URL" >"$ARCHIVO_TUNEL"
    return 0
  fi

  exigir_cloudflared || return 1

  setsid bash -c "cloudflared tunnel --no-autoupdate --url 'http://localhost:${PUERTO_TUNEL}'" >"$log" 2>&1 &
  PID_TUNEL=$!

  # `cloudflared` imprime la URL cuando el túnel ya está registrado, así que
  # esperar a que aparezca es esperar a que el túnel sirva — no es una espera
  # a ciegas.
  local url="" murio=0
  for ((i = 0; i < ESPERA_TUNEL; i++)); do
    url="$(node -e "
      import('${AQUI_TUNEL}/lib/tunel.mjs').then(async (m) => {
        const { readFileSync } = await import('node:fs');
        let texto = '';
        try { texto = readFileSync(process.argv[1], 'utf8'); } catch { /* aún no existe */ }
        process.stdout.write(m.urlDelTunel(texto) ?? '');
      });
    " "$log")"
    [ -n "$url" ] && break
    # Si cloudflared se murió, esperar el plazo completo solo retrasa la mala
    # noticia. Se anota POR QUÉ se dejó de esperar, porque "se cayó" y "tardó
    # demasiado" se arreglan de formas distintas.
    if ! kill -0 "$PID_TUNEL" 2>/dev/null; then murio=1; break; fi
    sleep 1
  done

  if [ -z "$url" ]; then
    if [ "$murio" -eq 1 ]; then
      echo "  ERROR: cloudflared se cerró sin llegar a publicar una URL." >&2
    else
      echo "  ERROR: cloudflared sigue vivo pero no publicó ninguna URL en ${ESPERA_TUNEL}s." >&2
      echo "  Si tu red va lenta, sube el plazo:  DEMO_TUNEL_ESPERA=180 pnpm run demo" >&2
    fi
    echo "  Las últimas líneas de su log ($log):" >&2
    tail -n 12 "$log" >&2 2>/dev/null || true
    return 1
  fi

  export API_PUBLIC_URL="$url"
  printf '%s\n' "$url" >"$ARCHIVO_TUNEL"
  echo "  túnel listo  ($url -> localhost:${PUERTO_TUNEL})"
  return 0
}

# --- ejecución suelta -------------------------------------------------------
# Solo cuando se lanza como programa, no cuando se carga con `source`.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  cd "$AQUI_TUNEL/../.."
  # shellcheck source=scripts/demo/entorno.sh
  source "$AQUI_TUNEL/entorno.sh"

  LOG_TUNEL="$(mktemp "${TMPDIR:-/tmp}/ventia-tunel.XXXXXX.log")"
  echo
  echo "-> Túnel público (log: $LOG_TUNEL)"
  arrancar_tunel "$LOG_TUNEL"

  # Sin proceso propio no hay nada que sostener: pasó porque API_PUBLIC_URL ya
  # venía puesta. Decirlo y salir, en vez de quedarse en un `wait` que vuelve
  # solo y deja la impresión de que el túnel se cayó al instante.
  if [ -z "${PID_TUNEL:-}" ]; then
    echo
    echo "  No hacía falta ningún túnel: API_PUBLIC_URL ya apunta a $API_PUBLIC_URL"
    echo "  Comprueba que llega:   pnpm run demo:comprobar"
    echo
    exit 0
  fi

  cat <<FIN

  El API tiene que estar arrancado CON esta variable en su entorno, o el panel
  seguirá enseñando localhost en el botón de copiar:

      export API_PUBLIC_URL=$API_PUBLIC_URL

  Lo normal es no hacer esto a mano: \`pnpm run demo\` levanta el túnel y el API
  en el orden correcto. Este comando existe para cuando el stack ya está arriba
  y solo se cayó el túnel.

  Comprueba que llega:   pnpm run demo:comprobar
  Ctrl-C para cerrarlo.

FIN
  # `wait` sin argumentos vuelve en cuanto termine CUALQUIER hijo; aquí solo
  # hay uno, así que es esperar al túnel.
  wait
fi
