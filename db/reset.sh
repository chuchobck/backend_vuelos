#!/usr/bin/env bash
# =============================================================================
#  Reinicia la base de vuelos: la borra, la vuelve a crear, carga esquema y seed.
#  Uso:  ./db/reset.sh          (esquema + semilla)
#        ./db/reset.sh --solo-esquema
# =============================================================================
set -euo pipefail

CONTENEDOR="${CONTENEDOR:-booking_db_container}"
BD="${BD:-booking_db}"
USUARIO="${USUARIO:-postgres}"
ARCHIVO_ESQUEMA="${ARCHIVO_ESQUEMA:-esquema_vuelos.sql}"
ARCHIVO_SEED="${ARCHIVO_SEED:-semilla_vuelos.sql}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARGAR_SEED=true
[[ "${1:-}" == "--solo-esquema" ]] && CARGAR_SEED=false

psql_bd() { docker exec -i "$CONTENEDOR" psql -U "$USUARIO" -d "$BD" -v ON_ERROR_STOP=1 -q "$@"; }

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

# --- 3. esquema y seed --------------------------------------------------------
echo "Cargando $ARCHIVO_ESQUEMA..."
psql_bd < "$DIR/$ARCHIVO_ESQUEMA"

if [[ "$CARGAR_SEED" == true ]]; then
    echo "Cargando $ARCHIVO_SEED..."
    psql_bd < "$DIR/$ARCHIVO_SEED"
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
