#!/usr/bin/env bash
# =============================================================================
#  Comprueba que una base MIGRADA es igual a una base NUEVA:
#    - nueva:   db/esquema_vuelos.sql de este árbol.
#    - migrada: db/esquema_vuelos.sql de <ref-base> (lo que ya tienen las bases que existen) y
#               encima db/migraciones/*.sql, dos veces (cada migración es idempotente).
#  Las dos se vuelcan con pg_dump --schema-only y se comparan. Si difieren, una migración se quedó
#  atrás del esquema (o al revés) y una base que ya existe terminaría distinta de una nueva.
#
#  Uso:  scripts/comprobar-migraciones.sh <ref-base>      p. ej. origin/main o FETCH_HEAD
#        CONTENEDOR=<contenedor de PostgreSQL>             por defecto booking_db_container
#
#  Crea y borra dos bases temporales (cmp_nueva_<pid>, cmp_migrada_<pid>) en ese PostgreSQL;
#  nunca toca booking_db. En CI el contenedor es el del servicio postgres del job.
# =============================================================================
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Uso: $0 <ref-base>   (origin/main, FETCH_HEAD...)" >&2
    exit 2
fi
BASE_REF="$1"
CONTENEDOR="${CONTENEDOR:-booking_db_container}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NUEVA="cmp_nueva_$$"
MIGRADA="cmp_migrada_$$"
TMP="$(mktemp -d)"

pg() { docker exec -i "$CONTENEDOR" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
limpiar() {
    pg -d postgres -c "DROP DATABASE IF EXISTS $NUEVA WITH (FORCE)" -c "DROP DATABASE IF EXISTS $MIGRADA WITH (FORCE)" >/dev/null 2>&1 || true
    rm -rf "$TMP"
}
trap limpiar EXIT

pg -d postgres -c "CREATE DATABASE $NUEVA" -c "CREATE DATABASE $MIGRADA"

pg -d "$NUEVA" <"$DIR/db/esquema_vuelos.sql" >/dev/null
git -C "$DIR" show "$BASE_REF:db/esquema_vuelos.sql" | pg -d "$MIGRADA" >/dev/null
# Dos pasadas: la segunda comprueba que cada migración se puede repetir sin cambiar nada
for pasada in 1 2; do
    for migracion in "$DIR"/db/migraciones/*.sql; do
        [[ -e "$migracion" ]] || continue
        pg -d "$MIGRADA" <"$migracion" >/dev/null 2>&1 \
            || { echo "La migración $(basename "$migracion") falló en la pasada $pasada" >&2; exit 1; }
    done
done

# pg_dump pone una marca al azar (\restrict) en cada volcado: se quita
volcar() { docker exec "$CONTENEDOR" pg_dump -U postgres -s --no-owner "$1" | grep -v '^\\\(un\)\?restrict '; }
volcar "$NUEVA" >"$TMP/nueva.sql"
volcar "$MIGRADA" >"$TMP/migrada.sql"

if diff -u "$TMP/migrada.sql" "$TMP/nueva.sql" >"$TMP/diferencias.txt"; then
    echo "Base migrada ($BASE_REF + $(ls "$DIR"/db/migraciones/*.sql | wc -l) migraciones) = base nueva"
else
    echo "La base migrada NO es igual a la nueva (- migrada, + nueva):" >&2
    head -n 60 "$TMP/diferencias.txt" >&2
    exit 1
fi
