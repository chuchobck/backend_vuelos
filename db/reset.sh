#!/usr/bin/env bash
# =============================================================================
#  Reinicia la base de vuelos: la borra, la vuelve a crear, carga esquemas y seeds.
#  Uso:  ./db/reset.sh          (esquemas + semillas)
#        ./db/reset.sh --solo-esquema
#
#  Administrador de desarrollo: si SEED_ADMIN_PASSWORD está definida (en el entorno
#  o en .env), se crea con el correo SEED_ADMIN_EMAIL (por defecto admin@quinde.example).
#  El hash argon2id lo calcula db/hash-contrasena.js, así que hace falta "npm ci" antes.
# =============================================================================
set -euo pipefail

CONTENEDOR="${CONTENEDOR:-booking_db_container}"
BD="${BD:-booking_db}"
USUARIO="${USUARIO:-postgres}"
ARCHIVO_ESQUEMA="${ARCHIVO_ESQUEMA:-esquema_vuelos.sql}"
ARCHIVO_SEED="${ARCHIVO_SEED:-semilla_vuelos.sql}"
ARCHIVO_ESQUEMA_SEGURIDAD="${ARCHIVO_ESQUEMA_SEGURIDAD:-esquema_seguridad.sql}"
ARCHIVO_SEED_SEGURIDAD="${ARCHIVO_SEED_SEGURIDAD:-semilla_seguridad.sql}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARGAR_SEED=true
[[ "${1:-}" == "--solo-esquema" ]] && CARGAR_SEED=false

psql_bd() { docker exec -i "$CONTENEDOR" psql -U "$USUARIO" -d "$BD" -v ON_ERROR_STOP=1 -q "$@"; }

# Valor de una variable en ../.env (sin comillas), para no pedir exportarla a mano.
leer_de_env() {
    local valor
    valor="$(grep -E "^$1=" "$DIR/../.env" 2>/dev/null | tail -n 1 | cut -d= -f2-)" || true
    valor="${valor%\"}"; valor="${valor#\"}"; valor="${valor%\'}"; valor="${valor#\'}"
    printf '%s' "$valor"
}

# --- 1. el contenedor tiene que estar arriba y aceptando conexiones -----------
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTENEDOR"; then
    echo "El contenedor $CONTENEDOR no esta corriendo. Levantalo con: docker compose up -d" >&2
    exit 1
fi

printf 'Esperando a Postgres'
for _ in $(seq 1 30); do
    if docker exec "$CONTENEDOR" pg_isready -U "$USUARIO" -q 2>/dev/null; then break; fi
    printf '.'; sleep 1
done
echo
docker exec "$CONTENEDOR" pg_isready -U "$USUARIO" -q || { echo "Postgres no responde." >&2; exit 1; }

# --- 2. borrar y crear --------------------------------------------------------
# WITH (FORCE) cierra las sesiones abiertas (Prisma, DBeaver, psql olvidado).
# Sin eso, el DROP falla con "is being accessed by other users".
echo "Borrando y creando $BD..."
docker exec "$CONTENEDOR" psql -U "$USUARIO" -d postgres -q \
    -c "DROP DATABASE IF EXISTS $BD WITH (FORCE)" \
    -c "CREATE DATABASE $BD"

# --- 3. esquemas y seeds ------------------------------------------------------
echo "Cargando $ARCHIVO_ESQUEMA..."
psql_bd < "$DIR/$ARCHIVO_ESQUEMA"
echo "Cargando $ARCHIVO_ESQUEMA_SEGURIDAD..."
psql_bd < "$DIR/$ARCHIVO_ESQUEMA_SEGURIDAD"

if [[ "$CARGAR_SEED" == true ]]; then
    echo "Cargando $ARCHIVO_SEED..."
    psql_bd < "$DIR/$ARCHIVO_SEED"

    # Las variables de psql (correo_admin, hash_admin) van por stdin, delante del archivo:
    # ni la contraseña ni su hash aparecen en los argumentos de un proceso.
    SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$(leer_de_env SEED_ADMIN_PASSWORD)}"
    SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-$(leer_de_env SEED_ADMIN_EMAIL)}"
    SEED_ADMIN_EMAIL="$(printf '%s' "${SEED_ADMIN_EMAIL:-admin@quinde.example}" | tr '[:upper:]' '[:lower:]')"
    variables=""
    if [[ -n "$SEED_ADMIN_PASSWORD" ]]; then
        if [[ ! "$SEED_ADMIN_EMAIL" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]+$ ]]; then
            echo "SEED_ADMIN_EMAIL no es un correo válido: $SEED_ADMIN_EMAIL" >&2
            exit 1
        fi
        hash="$(SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" node "$DIR/hash-contrasena.js")"
        variables="\\set correo_admin '$SEED_ADMIN_EMAIL'"$'\n'"\\set hash_admin '$hash'"$'\n'
    fi
    echo "Cargando $ARCHIVO_SEED_SEGURIDAD..."
    { printf '%s' "$variables"; cat "$DIR/$ARCHIVO_SEED_SEGURIDAD"; } | psql_bd
fi

# --- 4. verificacion ----------------------------------------------------------
echo
echo "--- Version del servidor ---"
docker exec "$CONTENEDOR" psql -U "$USUARIO" -qAt -c "show server_version"

echo "--- Esquemas y tablas (el esquema importa para el ?schema= de Prisma) ---"
psql_bd -c "
SELECT table_schema AS esquema, count(*) AS tablas
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
GROUP BY table_schema
ORDER BY table_schema;"

echo
echo "Listo. Los conteos de filas los imprime la propia semilla, arriba."
