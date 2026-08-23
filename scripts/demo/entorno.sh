# Cargado con `source` por los scripts de la demo. No se ejecuta suelto.
#
# Hace tres cosas, en este orden:
#   1. carga `.env` de la raíz SIN pisar lo que ya venga del entorno, para que
#      `ANTHROPIC_API_KEY=sk-... pnpm run demo` funcione;
#   2. pone los mismos valores por defecto de desarrollo que usa
#      `scripts/e2e.sh`, para que la demo arranque en una máquina sin `.env`;
#   3. comprueba lo que NO puede faltar y falla diciendo exactamente qué falta.

RAIZ_DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cargar_env() {
  local archivo="$RAIZ_DEMO/.env" linea clave valor
  [ -f "$archivo" ] || return 0
  while IFS= read -r linea || [ -n "$linea" ]; do
    case "$linea" in '' | '#'*) continue ;; esac
    [[ "$linea" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    clave="${linea%%=*}"
    valor="${linea#*=}"
    valor="${valor%$'\r'}"
    # Comillas envolventes fuera, si las hay. No se interpreta nada más: este
    # archivo no es un script y tratarlo como tal (con `source`) haría que un
    # valor con un `$` o un backtick se ejecutara.
    if [[ "$valor" == \"*\" && ${#valor} -ge 2 ]]; then valor="${valor:1:${#valor}-2}"; fi
    if [[ "$valor" == \'*\' && ${#valor} -ge 2 ]]; then valor="${valor:1:${#valor}-2}"; fi
    # Lo que ya está en el entorno gana.
    [ -n "${!clave-}" ] || export "$clave=$valor"
  done < "$archivo"
}

cargar_env

# Los mismos valores por defecto que `scripts/e2e.sh`, para que la demo no
# dependa de que exista un `.env`.
: "${DATABASE_URL:=postgresql://ventia:ventia@localhost:5432/ventia}"
: "${REDIS_URL:=redis://localhost:6379}"
: "${AUTH_SECRET:=dev-secret-change-me}"
: "${API_URL:=http://api.ventia.localhost}"
: "${API_INTERNAL_URL:=http://localhost:4000}"
: "${ADMIN_URL:=http://admin.ventia.localhost}"
: "${PLATFORM_ROOT_DOMAIN:=ventia.localhost}"
: "${S3_ENDPOINT:=http://localhost:9000}"
: "${S3_ACCESS_KEY:=ventia}"
: "${S3_SECRET_KEY:=ventia-secret}"
: "${S3_BUCKET:=ventia}"
: "${S3_PUBLIC_URL:=http://localhost:9000/ventia}"
# Llave de desarrollo FIJA y obviamente falsa: tiene que ser la misma entre
# ejecuciones o las credenciales de WhatsApp e Instagram que sembró una toma
# anterior dejan de descifrarse. AES-256-GCM quiere 32 bytes en base64.
: "${PAYMENTS_ENCRYPTION_KEY:=ZGV2LW9ubHktZGVtby1rZXktMzItYnl0ZXMtbG9uZyE=}"
export DATABASE_URL REDIS_URL AUTH_SECRET API_URL API_INTERNAL_URL ADMIN_URL PLATFORM_ROOT_DOMAIN
export S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_PUBLIC_URL PAYMENTS_ENCRYPTION_KEY

# ---------------------------------------------------------------------------

# La llave de cifrado tiene que decodificar a EXACTAMENTE 32 bytes: es la de
# AES-256-GCM y es con la que el seed cifra las credenciales de WhatsApp e
# Instagram y con la que la API las descifra para verificar la firma del
# webhook. Se comprueba aquí, al cargar el entorno, y no cuando el seed llegue
# a esa línea: a esas alturas ya ha escrito medio catálogo.
#
# Encontrado con el `.env` de este mismo repo, cuyo valor de desarrollo
# decodifica a 35 bytes ("bogus-32-byte-key-for-dev-use only!"): el seed se
# paraba a mitad y la API habría contestado igual de mal a cualquier webhook de
# mensajería.
if ! node -e '
  const k = Buffer.from(process.env.PAYMENTS_ENCRYPTION_KEY ?? "", "base64");
  if (k.length !== 32) { console.error(k.length); process.exit(1); }
' 2>/dev/null; then
  LONGITUD_LLAVE="$(node -e 'process.stdout.write(String(Buffer.from(process.env.PAYMENTS_ENCRYPTION_KEY ?? "", "base64").length))')"
  cat >&2 <<FIN

  PAYMENTS_ENCRYPTION_KEY no sirve: decodifica a $LONGITUD_LLAVE bytes y AES-256-GCM
  necesita exactamente 32.

  Es la llave con la que se cifran las credenciales de WhatsApp e Instagram, así
  que sin ella válida el seed se para y la API no puede verificar la firma de
  ningún webhook de mensajería.

  Genera una y ponla en el .env de la raíz:

      openssl rand -base64 32

  O quita la línea del .env y esta demo usará su propia llave de desarrollo.

FIN
  exit 1
fi

# La comprobación que el encargo pide por su nombre.
#
# El cliente de Anthropic se construye con `new Anthropic()` y saca la
# credencial del entorno, y construirlo NO toca la red: un API sin clave
# ARRANCA bien y falla en la primera petición al agente. Eso está bien para un
# servidor de producción que sirve catálogo sin tráfico de IA, y es pésimo para
# una grabación: el agente se queda mudo en la toma y no hay ningún mensaje que
# lo explique. Así que aquí se comprueba antes de arrancar nada.
exigir_clave_anthropic() {
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    cat >&2 <<'FIN'

  Falta ANTHROPIC_API_KEY.

  Sin ella el API arranca igual, pero el agente NO contesta ni un mensaje: el
  cliente de Anthropic se construye sin tocar la red y falla en la primera
  petición. En una grabación eso se ve como una tienda muda, sin ningún error
  a la vista.

  Ponla de una de estas dos formas y vuelve a lanzarlo:

      export ANTHROPIC_API_KEY=sk-ant-...
      pnpm run demo

  o escríbela en el archivo .env de la raíz del repo:

      ANTHROPIC_API_KEY=sk-ant-...

FIN
    exit 1
  fi
}

# Espera a que una URL responda CUALQUIER cosa (un 4xx también significa que el
# servidor está en pie).
esperar_url() {
  local url="$1" nombre="$2" intentos="${3:-90}"
  for ((i = 0; i < intentos; i++)); do
    if curl -s -o /dev/null -m 2 "$url"; then
      echo "  $nombre listo  ($url)"
      return 0
    fi
    sleep 1
  done
  echo "  ERROR: $nombre no respondió en $url tras ${intentos}s." >&2
  return 1
}
