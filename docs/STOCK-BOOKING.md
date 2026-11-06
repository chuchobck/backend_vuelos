# Empuje de stock a Booking (fase S1)

El core manda a Booking, por REST, cuántos cupos quedan de cada vuelo, cabina y fecha. **Apagado por
defecto** (`BOOKING_STOCK_ENABLED=false`): apagado no hay cola, ni trabajador, ni llamadas, y las
operaciones de cupo no escriben nada extra.

## El contrato de Booking

Lo dio el equipo de Booking; no se inventó nada más.

```
POST https://booking-core-api.azurewebsites.net/api/v2/inventory/stock
Content-Type: application/json

{"service_id":"<el nuestro, fijo>","item_id":"AV1632-ECONOMY","date":"2026-11-02","time_slot":"08:30","available_units":42}
```

Responde `"success": true` si quedó integrado. Un registro por **(vuelo, cabina, fecha de salida)**.
No hay cabecera de autenticación documentada, así que no se manda ninguna.

| Campo | De dónde sale |
| --- | --- |
| `service_id` | `BOOKING_STOCK_SERVICE_ID`: fijo y único por equipo, **nunca `vuelos`** (el arranque lo rechaza). Obligatorio si está activo, sin valor por defecto. |
| `item_id` | `<número de vuelo>-<CABINA EN MAYÚSCULAS>`: aerolínea comercializadora + número (`AV1632`) y la cabina del contrato (`ECONOMY`, `PREMIUM_ECONOMY`, `BUSINESS`, `FIRST`). |
| `date` | La fecha de la salida **en hora de Ecuador**, `YYYY-MM-DD`: del mismo instante que `time_slot`, no la fecha local del aeropuerto (ver abajo). |
| `time_slot` | La hora real de salida **en hora de Ecuador** (`America/Guayaquil`, UTC-5 y sin horario de verano), `HH:mm` con ceros a la izquierda. Booking la toma tal cual, sin convertirla. Confirmado por Booking. |
| `available_units` | `inventario_cabina.cupos_disponibles`, **el valor absoluto del momento de mandar**; `0` si la salida está cancelada. |

Los cuatro campos salen de **un solo archivo**, `src/modules/vuelos/stock-booking/item-stock.ts`.

### Regla de `date` y `time_slot`

Se parte del **instante de salida** (`vuelo_programado.salida_programada`, UTC) y se convierte a
`BOOKING_STOCK_TZ` (`America/Guayaquil` por defecto): de ahí salen la fecha y la hora, las dos del
mismo instante. Ni la zona ni la fecha local del aeropuerto de origen cuentan, así que un vuelo de
Galápagos (UTC-6) sale con la hora de Ecuador continental, y cerca de medianoche la fecha puede ser
la del día anterior o siguiente a la del aeropuerto:

| Salida (UTC) | Aeropuerto | Hora local del aeropuerto | `date` | `time_slot` |
| --- | --- | --- | --- | --- |
| 2026-11-02 13:30 | Quito (UTC-5) | 2026-11-02 08:30 | `2026-11-02` | `08:30` |
| 2026-11-02 14:05 | Quito (UTC-5) | 2026-11-02 09:05 | `2026-11-02` | `09:05` |
| 2026-11-03 05:05 | Baltra, Galápagos (UTC-6) | 2026-11-02 23:05 | `2026-11-03` | `00:05` |
| 2026-11-03 04:09 | Guayaquil (UTC-5) | 2026-11-02 23:09 | `2026-11-02` | `23:09` |
| 2026-11-02 15:00 | (uno a UTC+13) | 2026-11-03 04:00 | `2026-11-02` | `10:00` |

No se cambia `BOOKING_STOCK_TZ` sin que Booking lo pida. Si la hora de una salida cambia, el registro
nuevo sale con la hora nueva (qué pasa con el viejo: pregunta abierta 2).

## Diseño

```
 operación que mueve el cupo ──(misma transacción)──▶ orden_stock_booking (una fila por salida y cabina)
                                                              │ ya confirmada la transacción
                                                              ▼
                              StockBookingWorker ── lee el cupo ACTUAL ──▶ POST a Booking
                                  (SKIP LOCKED, arrendamiento, concurrencia 5, cortacircuitos)
```

1. **Registro en la misma transacción.** Toda operación que modifica `inventario_cabina` (o hace una
   salida vendible o no) llama a `OrdenesStock` dentro de su transacción. Si la transacción se
   deshace, la orden también: no queda ninguna orden por un cambio que no ocurrió.
2. **Valor absoluto, leído al mandar.** La orden no lleva cifra. El trabajador lee el cupo en el
   momento de tomarla y manda ese valor, nunca un delta. Reenviar o reordenar es seguro, y varios
   cambios seguidos de la misma clave se mandan en **un** solo envío (coalesce): la orden es un
   upsert con un número de `version`.
3. **Una clave nunca se manda en paralelo.** El trabajador toma las órdenes con
   `FOR UPDATE SKIP LOCKED` y un arrendamiento de 60 s, así dos procesos no mandan la misma. Si
   mientras se manda llega un cambio nuevo, la orden **no** se da por mandada (otra `version`) y
   vuelve a salir con el valor nuevo.
4. **La venta no espera.** El HTTP ocurre en el trabajador, fuera de toda transacción de negocio. Con
   Booking caído, lento o respondiendo mal, el hold y la reserva se crean igual y el empuje se
   recupera después.
5. **No hay `DELETE`.** La cola queda acotada por el número de filas de `inventario_cabina`
   (`orden_stock_booking` tiene a lo más una fila por salida y cabina).

### Dónde se registra

| Operación | Dónde |
| --- | --- |
| Crear un hold | `RetencionRepository.crear` |
| Liberar un hold, o vencerlo (petición o proceso periódico) | `RetencionRepository` (`cerrar`, `vencerSiguiente`) |
| Cancelar una reserva, o vencerla sin pago (devuelve cupo) | `ReservaRepository.devolverCupo` |
| Cambio de fecha (toma el nuevo, devuelve el viejo; también al resolver un cambio pendiente) | `InventarioRepository.mover` |
| Crear una salida con sus cupos | `VueloProgramadoRepository.insertar` |
| Cambiar una salida (cupo, horario, estado) | `VueloProgramadoRepository.modificar` (registra todas sus cabinas) |
| Agregar una cabina a una salida | `VueloProgramadoRepository.agregarCupo` |
| Cancelar o reactivar una salida | `VueloProgramadoRepository.fijarActivo` |

Reservar (`POST /bookings`) **no** mueve el cupo: consume el hold que ya lo tomó. El check-in
tampoco: solo asigna asientos. Quien agregue una operación nueva que toque `inventario_cabina` debe
llamar a `OrdenesStock` en su transacción (hay una mutación por cada camino de la tabla).

## Reglas del trabajador

`BOOKING_STOCK_JOB_INTERVAL_SECONDS` (5 s). Cada corrida atiende hasta 200 órdenes, de 5 en 5 (la
concurrencia hacia Booking es baja a propósito).

| Respuesta de Booking | Qué pasa |
| --- | --- |
| 2xx con `"success": true` | `ENVIADO` |
| 2xx con `"success": false` | `FALLIDO`, **sin reintento** (`SUCCESS_FALSE`); un aviso en el log |
| 400, 404, 409, 413, 415, 422 (validación) | `FALLIDO`, **sin reintento** (`HTTP_<status>`); un aviso en el log |
| Red caída, plazo, 5xx, 429, 3xx, 401/403, otro 4xx, o un 2xx que no es JSON | Reintento con espera creciente |

Esperas: 5 s, 30 s, 2 min, 10 min, 30 min y después cada hora (o el `Retry-After` de un 429, si es
mayor), hasta **10 intentos**; después queda `FALLIDO`. Un 401/403 se reintenta porque es
configuración que se arregla sin perder la orden. Un cambio de cupo nuevo de la misma clave la vuelve
a `PENDIENTE`, y `npm run stock:sincronizar` también.

**Cortacircuitos** (`corta-circuito.ts`, por proceso): 5 fallos seguidos (red, plazo, 5xx, 429) lo
abren 30 s, y mientras está abierto el trabajador no toma órdenes ni llama a Booking; vencida la
espera deja pasar **una** prueba, y si falla se abre otra vez con el doble de espera (tope 5 min). Un
rechazo de validación no cuenta como caída: Booking está vivo.

**Plazo:** `BOOKING_STOCK_TIMEOUT_MS`, 5000 por defecto (su ESB corta a 5 s). Sin redirecciones.

**Correlación:** cada envío lleva `X-Correlation-Id`: el de la petición que produjo el último cambio
de esa clave, o uno `corr-<uuid>` por ciclo si lo produjo un proceso o la sincronización. **Nunca**
se manda `traceparent` a Booking (es un tercero).

## Sincronización completa

Para la primera carga, para recuperar lo que quedó `FALLIDO` y para ponerse al día tras un tiempo
apagado. Recorre las salidas de los próximos `BOOKING_STOCK_DIAS` días (90), desde hoy, y empuja todas
las claves: registra una orden por cada una (se junta con las que ya haya) y el trabajador las manda
con la misma concurrencia baja, el mismo cortacircuitos y los mismos reintentos.

```bash
npm run build                                                       # el comando corre desde dist/
BOOKING_STOCK_SERVICE_ID=<service_id> npm run stock:sincronizar -- --dry-run   # una línea JSON por registro; no escribe ni llama a nadie
BOOKING_STOCK_ENABLED=true BOOKING_STOCK_SERVICE_ID=<service_id> npm run stock:sincronizar
```

Sin `--dry-run` exige `BOOKING_STOCK_ENABLED=true`. Arranca el core **sin servidor ni procesos
periódicos**, imprime conteos y sale con `0` si todo se mandó, `1` si hubo rechazos, fallos o algo
esperando un reintento. Con `BOOKING_STOCK_SYNC_AL_ARRANCAR=true` el servicio registra la misma
ventana al arrancar (sin bloquear el arranque) y su trabajador las manda.

## Cómo activarlo

1. Aplicar la migración `005` a la base (`./db/migrar.sh`; idempotente). Con el empuje apagado la
   tabla ni se toca, así que desplegar el código antes de migrar es seguro.
2. En el servicio: `BOOKING_STOCK_ENABLED=true` y `BOOKING_STOCK_SERVICE_ID=<el service_id real>`.
   Opcionales: `BOOKING_STOCK_URL`, `BOOKING_STOCK_TIMEOUT_MS`, `BOOKING_STOCK_DIAS`,
   `BOOKING_STOCK_SYNC_AL_ARRANCAR`, `BOOKING_STOCK_JOB_ENABLED`, `BOOKING_STOCK_JOB_INTERVAL_SECONDS`
   (tabla en [DEPLOY.md](DEPLOY.md)).
3. Ver el log de arranque: `[StockBookingWorker] Activo: cada 5 s`.
4. Primera carga: `npm run stock:sincronizar -- --dry-run`, revisar, y después sin `--dry-run`
   (o `BOOKING_STOCK_SYNC_AL_ARRANCAR=true` en el primer arranque).

Para apagarlo: `BOOKING_STOCK_ENABLED=false`. Las órdenes quedan en la tabla (no se borran) y al
volver a activarlo se recupera con una sincronización.

## Cómo leer los fallos

**Log** (una línea por envío, sin URL ni cuerpo de Booking ni datos de pasajeros):

```
Stock AV1632-ECONOMY 2026-11-02 08:30 = 42 intento 1: ENVIADO HTTP_200
Stock AV1632-ECONOMY 2026-11-02 08:30 = 41 intento 3: PENDIENTE HTTP_503
Stock AV1632-ECONOMY 2026-11-02 08:30 = 41 intento 1: FALLIDO SUCCESS_FALSE (item_id desconocido)
```

Un rechazo deja además un aviso con el status y el mensaje de Booking, de hasta 120 caracteres y
saneado. `SUPERADA` quiere decir que llegó un cambio mientras se mandaba y la clave volvió a salir
con el valor nuevo (normal).

**Base:**

```sql
SELECT estado, count(*) FROM vuelos.orden_stock_booking GROUP BY 1;

-- Qué falló y por qué
SELECT ultimo_error, ultimo_codigo_http, count(*)
  FROM vuelos.orden_stock_booking WHERE estado = 'FALLIDO' GROUP BY 1, 2 ORDER BY 3 DESC;

-- Las 20 más atrasadas
SELECT vuelo_programado_id, clase_cabina, intentos, proximo_intento, ultimo_error
  FROM vuelos.orden_stock_booking WHERE estado = 'PENDIENTE' ORDER BY solicitado_en LIMIT 20;
```

`ultimo_error` es un código corto: `HTTP_422`, `SUCCESS_FALSE`, `TIMEOUT`, `ECONNREFUSED`,
`RESPUESTA_INVALIDA`, `CIRCUITO_ABIERTO`.

**Métricas** (`/metrics`, en `METRICS_PORT`; sin ningún id de vuelo como etiqueta):

| Métrica | Qué dice |
| --- | --- |
| `core_stock_push_total{result="ok\|retry\|rejected\|failed"}` | Envíos por resultado (`rejected`: Booking los rechazó; `failed`: se agotaron los intentos) |
| `core_stock_pending` | Órdenes `PENDIENTE` |
| `core_stock_oldest_pending_seconds` | Edad de la `PENDIENTE` más vieja (0 si no hay) |
| `http_client_*{upstream="booking-stock"}` | Duración y status de las llamadas |
| `core_job_run_duration_seconds{job="stock-booking"}` | Duración de cada corrida |

Cada llamada abre un span CLIENT `POST /api/v2/inventory/stock` (`quinde.upstream=booking-stock`). Si
`core_stock_oldest_pending_seconds` crece sin parar con el cortacircuitos cerrado, mirar el log.

## Preguntas abiertas para Booking

1. **¿El `item_id` debe existir antes en su catálogo?** Si sí, un vuelo nuevo mandará `success:false`
   hasta que lo den de alta y el core lo dejará `FALLIDO` sin reintentar (la sincronización lo vuelve
   a mandar después). Si es upsert, no hay nada que hacer.
2. **Si cambia la fecha o la hora de una salida**, ¿el registro viejo `(item_id, date, time_slot)` se
   queda con su último cupo? El core manda el registro nuevo pero no sabe borrar el viejo.
3. **Autenticación.** No hay cabecera documentada; si piden una, es un cambio en
   `ClienteStockBooking.enviar`.
4. **Límite de peticiones.** La sincronización completa son unas 7 300 llamadas (90 días); la
   concurrencia es 5. ¿Aguanta o piden menos?

## Lo que no se pudo verificar

- **Nada contra el Booking real de Azure**: no hay servicio de pruebas y el `service_id` real aún no
  está definido. Todo se probó contra un Booking falso en el propio test (`test/utils/booking-falso.ts`).
- Cómo responde Booking de verdad (el cuerpo de un rechazo, si `success:false` es lo que dice un
  `item_id` desconocido, su límite de peticiones).
- Con varias instancias a la vez: el diseño las soporta (`SKIP LOCKED` y arrendamiento) pero se probó
  con una.

## Decisiones tomadas sin consultar

- Una salida `CANCELADO` manda `0` unidades (no se deja de mandar).
- `success:false` no se reintenta; un 401/403 sí.
- La cola es una tabla propia (no la bandeja `evento_saliente`): esa guarda un sobre congelado por hecho
  y aquí lo que hace falta es el valor actual de una clave.
- El tope de 10 intentos y las esperas son las de arriba, no variables de entorno.
- `BOOKING_STOCK_JOB_ENABLED` y `BOOKING_STOCK_JOB_INTERVAL_SECONDS` se agregaron (no estaban en el
  pedido) para que las pruebas apaguen el proceso y lo llamen a mano, como en el relevo de eventos.
