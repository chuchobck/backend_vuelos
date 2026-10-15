#!/usr/bin/env bash
# =============================================================================
#  Compatibilidad hacia atrás del contrato gRPC: compara contracts/proto con el de otra
#  rama o commit (por defecto main) con buf breaking y las reglas de buf.yaml (FILE).
#  Uso:  npm run proto:breaking                 # contra main
#        npm run proto:breaking -- origin/main  # contra cualquier ref de git
#
#  El proto de la base se saca con git archive a una carpeta temporal: no hace falta que
#  buf clone el repositorio, y sirve con un clon superficial (CI) si la ref está traída.
#  Sale con 1 si hay un cambio incompatible y dice cuál.
# =============================================================================
set -euo pipefail

BASE="${1:-main}"
cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse --verify --quiet "${BASE}^{commit}" > /dev/null; then
    echo "No existe la ref ${BASE} en este clon (en CI: git fetch origin main)." >&2
    exit 1
fi

if [[ -z "$(git ls-tree -r --name-only "$BASE" -- contracts/proto)" ]]; then
    echo "${BASE} todavía no tiene contracts/proto: no hay contra qué comparar."
    exit 0
fi

ANTERIOR="$(mktemp -d)"
trap 'rm -rf "$ANTERIOR"' EXIT
git archive "$BASE" contracts/proto | tar -x -C "$ANTERIOR"

npx --no-install buf breaking --against "$ANTERIOR/contracts/proto"
echo "Sin cambios incompatibles en contracts/proto respecto de ${BASE}."
