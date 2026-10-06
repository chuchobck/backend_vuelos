#!/usr/bin/env bash
# =============================================================================
#  Prueba de humo contra una API desplegada: salud, cuenta, login, búsqueda, hold,
#  reserva con PAY-OK-, consulta, cotización y cancelación.
#
#  Uso:  scripts/smoke.sh <BASE_URL>          ej. scripts/smoke.sh https://quinde-vuelos.onrender.com
#  Opcionales: SMOKE_ORIGEN y SMOKE_DESTINO (UIO y GYE), SMOKE_DIAS (días hasta el vuelo, 7).
#
#  Imprime OK o FALLÓ por paso y sale con 1 si alguno falla. Crea una cuenta nueva
#  (smoke-<fecha>@example.com) y deja su reserva cancelada. Nunca imprime la contraseña ni
#  los tokens. Necesita curl y node (para leer el JSON).
# =============================================================================
set -uo pipefail

if [[ $# -ne 1 ]]; then
    echo "Uso: $0 <BASE_URL>   (ej. https://quinde-vuelos.onrender.com)" >&2
    exit 2
fi
API="${1%/}/flights/v1"
ORIGEN="${SMOKE_ORIGEN:-UIO}"
DESTINO="${SMOKE_DESTINO:-GYE}"
DIAS="${SMOKE_DIAS:-7}"

CUERPO="$(mktemp)"
trap 'rm -f "$CUERPO"' EXIT
FALLOS=0
TOKEN=""

uuid() { node -e 'console.log(require("node:crypto").randomUUID())'; }

# Lee un campo del último cuerpo: campo offers.0.offerId
campo() {
    node -e '
      const ruta = process.argv[1].split(".");
      let v = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
      for (const p of ruta) v = v?.[p];
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    ' "$1" "$CUERPO" 2>/dev/null
}

# pedir METODO RUTA [CUERPO_JSON] [CABECERA...]: deja el cuerpo en $CUERPO e imprime el status
pedir() {
    local metodo="$1" ruta="$2" datos="${3:-}"
    shift 3 2>/dev/null || shift $#
    local args=(-s -o "$CUERPO" -w '%{http_code}' -X "$metodo" "$API$ruta" --max-time 60)
    [[ -n "$TOKEN" ]] && args+=(-H "Authorization: Bearer $TOKEN")
    [[ -n "$datos" ]] && args+=(-H 'Content-Type: application/json' --data "$datos")
    for cabecera in "$@"; do args+=(-H "$cabecera"); done
    # Sin respuesta, curl escribe 000 como status
    curl "${args[@]}"
}

paso() {
    local nombre="$1" esperado="$2" obtenido="$3" extra="${4:-}"
    if [[ "$obtenido" == "$esperado" ]]; then
        echo "OK     $nombre${extra:+ — $extra}"
    else
        echo "FALLÓ  $nombre — esperaba $esperado y llegó $obtenido"
        FALLOS=$((FALLOS + 1))
        return 1
    fi
}

echo "Prueba de humo contra $API"

status="$(pedir GET /health)"
paso "salud" 200 "$status" || { echo "La API no responde; se corta aquí."; exit 1; }

CORREO="smoke-$(date -u +%Y%m%d%H%M%S)-$RANDOM@example.com"
CLAVE="smoke $(uuid)"
status="$(pedir POST /auth/register "{\"email\":\"$CORREO\",\"password\":\"$CLAVE\"}")"
paso "registrar cuenta" 201 "$status"
status="$(pedir POST /auth/login "{\"email\":\"$CORREO\",\"password\":\"$CLAVE\"}")"
paso "login" 200 "$status" && TOKEN="$(campo access_token)"
[[ -n "$TOKEN" ]] || { echo "Sin token no se puede seguir."; exit 1; }

FECHA="$(node -e "console.log(new Date(Date.now() + $DIAS * 864e5).toISOString().slice(0, 10))")"
status="$(pedir POST /search "{\"itineraries\":[{\"origin\":\"$ORIGEN\",\"destination\":\"$DESTINO\",\"departureDate\":\"$FECHA\"}],\"passengers\":{\"adults\":1}}" 'X-Device-Fingerprint: smoke-script-0001')"
OFERTA="$(campo offers.0.offerId)"
paso "búsqueda $ORIGEN→$DESTINO $FECHA" 200 "$status" "${OFERTA:+con ofertas}"
[[ -n "$OFERTA" ]] || { echo "FALLÓ  la búsqueda no devolvió ofertas"; exit 1; }
ITINERARIO="$(campo offers.0.itineraries.0.itineraryId)"
CABINA="$(campo offers.0.itineraries.0.pricingOptions.0.cabinClass)"
FAMILIA="$(campo offers.0.itineraries.0.pricingOptions.0.fareBrand)"

status="$(pedir POST /offers/hold "{\"offerId\":\"$OFERTA\",\"itinerarySelections\":[{\"itineraryId\":\"$ITINERARIO\",\"cabinClass\":\"$CABINA\",\"fareBrand\":\"$FAMILIA\"}],\"passengersBreakdown\":{\"adults\":1}}" "Idempotency-Key: $(uuid)")"
HOLD="$(campo holdId)"
paso "hold" 201 "$status"

PAGO="PAY-OK-SMOKE$(date -u +%H%M%S)$RANDOM"
PASAJERO='{"passengerId":"ADU1","passengerType":"ADULT","firstName":"Prueba","lastName":"Humo","documentType":"NATIONAL_ID","documentNumber":"1710034065","nationality":"EC","birthDate":"1990-04-15","gender":"F","contact":{"email":"humo@example.com","phone":"+593991234567"}}'
status="$(pedir POST /bookings "{\"holdId\":\"$HOLD\",\"passengers\":[$PASAJERO],\"payment\":{\"paymentReference\":\"$PAGO\"}}" "Idempotency-Key: $(uuid)")"
RESERVA="$(campo bookingId)"
paso "reserva con PAY-OK-" 201 "$status" "$(campo status)"

status="$(pedir GET "/bookings/$RESERVA")"
paso "consultar reserva" 200 "$status" "$(campo status)"

status="$(pedir GET "/bookings/$RESERVA/cancellation-quote")"
COTIZACION="$(campo quoteId)"
paso "cotizar cancelación" 200 "$status"
status="$(pedir POST "/bookings/$RESERVA/cancel" "{\"quoteId\":\"$COTIZACION\"}" "Idempotency-Key: $(uuid)")"
paso "cancelar reserva" 200 "$status" "$(campo status)"

echo
if [[ $FALLOS -eq 0 ]]; then
    echo "Prueba de humo: todo OK"
else
    echo "Prueba de humo: $FALLOS paso(s) fallaron"
    exit 1
fi
