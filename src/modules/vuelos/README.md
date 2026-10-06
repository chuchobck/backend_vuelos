# Módulo de Vuelos (GDS Flight Core API)

Este microservicio centraliza la lógica de Búsqueda, Ofertas, Retención (Hold), Reservas, Emisión de Tickets, Postventa, Check-in y Estado de Vuelos.

## Arquitectura y Límites de Dominio

La API de Vuelos actúa como un orquestador dentro de su propio dominio, pero **delega responsabilidades fundamentales** a otros microservicios mediante integración. No almacena información de tarjetas de crédito, ni gestiona perfiles complejos de clientes, ni emite facturas fiscales.

### Diagrama de Integración

```mermaid
graph TD
    %% Vuelos (Dominio Principal)
    subgraph Vuelos [Booking / Flight API]
        A[Search & Offers]
        B[Hold (Bloqueo)]
        C[Booking / PNR]
        D[Ticketing & Seats]
        E[Check-in & Boarding]
        F[Postventa: Fechas, Maletas, Cancelación]
    end

    %% Dominios Externos
    subgraph Pagos [Payment API]
        P1[3DS & Autorización]
        P2[Captura & Reembolso]
    end

    subgraph Clientes [Customer API]
        C1[Perfiles & Datos Personales]
        C2[Agenda de Contactos]
    end

    subgraph Facturacion [Billing API]
        B1[Facturación (Invoices)]
        B2[Notas de Crédito fiscales]
    end

    %% Relaciones
    Vuelos -->|paymentReference| Pagos
    Vuelos -->|Sub (JWT) / ownerId| Clientes
    Vuelos -->|Monto y Conceptos| Facturacion
```

### Flujo Típico (Happy Path)

1. **Autenticación (Identity Provider):** El usuario se autentica y obtiene un token JWT.
2. **Búsqueda (`/search`):** El cliente consulta vuelos. La API devuelve opciones (`offers`).
3. **Bloqueo (`/offers/hold`):** El usuario selecciona un vuelo. Se bloquea el cupo (Hold) por un tiempo determinado (ej. 15 minutos).
4. **Validación de Perfil:** (Fuera de esta API) El Frontend recupera del `Customer API` los datos de los pasajeros frecuentes.
5. **Procesamiento de Pago:** (Fuera de esta API) El Frontend se comunica con la `Payment API` para realizar el cobro (autorización de tarjeta, 3DS, etc.). Se obtiene un `paymentReference`.
6. **Reserva y Emisión (`/bookings`):** El Frontend llama a la API de Vuelos enviando el `holdId`, la lista de pasajeros y el `paymentReference`. 
7. **Confirmación:** La API de Vuelos (esta API) confirma el cupo, genera el PNR y (síncrona o asíncronamente) emite los Tickets. Opcionalmente dispara un Webhook y notifica a la `Billing API` para generar la factura.

## Notas Técnicas
- **Dueño de Reserva:** El usuario propietario se infiere del JWT (`sub`).
- **Idempotencia:** Endpoints críticos de escritura (`POST /bookings`, `POST /offers/hold`, pagos postventa, etc.) requieren el header `Idempotency-Key` para evitar transacciones duplicadas por reintentos de red.
- **Asíncronos:** Operaciones como emisión o cancelaciones pueden retornar un HTTP 202 (Accepted) y usar Webhooks (en `/webhooks`) para notificar al cliente cuando la operación termine de procesarse con el GDS (Global Distribution System).

## Estado de la implementación

El controller de ejemplo de la plantilla (`vuelos.controller.ts`, con respuestas simuladas en blanco)
ya no existe: se quitó en la fase 1. Las entidades se agregan por fases (ver
[docs/PLAN.md](../../../docs/PLAN.md)):

- `catalogo/<entidad>/`: CRUD de administrador en `/admin/...` con una clase base. Hecho en la fase 4.
- `operaciones/<entidad>/`: los endpoints del contrato (fases 5 a 10). Hechos: `busqueda/` (`POST /search`),
  `oferta/` (`GET /offers/{offerId}/seatmap`), `retencion/` (`/offers/hold`, fase 6), y `reserva/`
  y `boleto/` (`/bookings` y `/bookings/{bookingId}/tickets`, fase 7), y `equipaje/`, `cambio-fecha/`
  y `cancelacion/` (postventa, fase 8, colgadas de `bookings/:bookingId`), y `checkin/`,
  `pase-abordar/` y `estado-vuelo/` (fase 9: las dos primeras cuelgan de `bookings/:bookingId` y la
  tercera, pública, de `flights/:flightNumber/status`)), y `webhook/` (fase 10: las suscripciones de `/webhooks`,
  la bandeja de salida y su entrega).
- `compartido/`: traducción de los ENUM al contrato (`enums.ts`, con `ORDEN_CABINAS`), formatos de
  salida (`formatos-salida.ts`), los pasajeros de la búsqueda y el hold (`dto/pasajeros.dto.ts` y
  `pasajeros.ts`), `FechaIso` (`dto/validadores.ts`), las claves de idempotencia
  (`idempotencia.repository.ts`), el PNR y el número de boleto (`generador-codigos.ts`), el cupo de
  varias cabinas a la vez (`inventario.repository.ts`) y la Payment API (`pagos/`: la interfaz
  `ServicioPagos`, el cobro común `Cobros` y las referencias guardadas `PagosRepository`).
- Cada entidad lleva `<entidad>.routes.ts`, controller, service, repository (el único que usa Prisma),
  mapper y `dto/`; las rutas se cuelgan en `vuelos.routes.ts`.

Lo transversal ya lo da la API a cualquier controller nuevo, sin código extra:

| Qué                                   | Cómo se usa                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Errores `application/problem+json`    | Lanzar `ErrorNegocio(status, CodigoError.X, 'detalle en inglés')` desde el service; el filtro global arma el cuerpo     |
| Errores de la base                    | No se capturan: el filtro traduce unique, FK, `RESTRICT`, CHECK y los triggers del esquema (`common/errores`)           |
| Validación de la entrada              | DTO con class-validator; el `ValidationPipe` global rechaza campos de más con 400 `VALIDATION_FAILED`                    |
| Parámetros de ruta y de query         | `UuidPipe`, `FechaPipe`, `CodigoIataAeropuertoPipe`, `CodigoIataAerolineaPipe`, `CodigoPaisPipe`, `CodigoModeloAeronavePipe`, `NumeroVueloPipe` |
| Texto libre del cliente               | `@TextoLimpio()` en el DTO (recorta, normaliza y rechaza controles y HTML); ver `src/common/sanitizacion/README.md`    |
| Límite de peticiones                  | Ya aplica a toda ruta; `@LimiteEstricto(5, 60)` da uno propio y `@SinLimiteDePeticiones()` la excluye                  |
| Escritura con auditoría               | `prisma.transaccionAuditada(tx => ...)` toma usuario e IP del contexto de la petición                                   |
| Permisos y usuario                    | `@Scopes('flights:book')` (el scope del contrato) y `@UsuarioActual()`; toda ruta exige JWT salvo `@Publico()`           |
| Request id, IP y usuario              | `obtenerContexto()` en `common/contexto`; el guard de JWT llama a `fijarUsuario(sub)` con cada token válido              |
| `Idempotency-Key`                     | `@ClaveIdempotencia()` en el parámetro (400 si falta o no es uuid); qué hace con la clave lo decide el service           |
| La hora                               | Inyectar `Reloj` (`common/reloj.ts`) y usar `reloj.ahora()` para todo vencimiento; las pruebas lo cambian por uno quieto |
| Un pago                               | `Cobros.autorizar(cobro)` (409 si la referencia ya se usó, 422 si se rechaza) y `PagosRepository` para guardarla con su estado; nunca datos de tarjeta |
| Una Idempotency-Key guardada          | `IdempotenciaRepository`: `leer`, `reclamar(tx, clave)` en la transacción del cambio y `borrarVencidas`                |

## Operaciones del contrato

Cada operación es una entidad de `operaciones/` con la misma forma (module, routes, controller,
service, repository, mapper y `dto/`) y se cuelga en `operaciones/operaciones.routes.ts`:

- Los DTO copian el esquema del contrato con sus nombres en inglés; el modelo interno (por ejemplo
  `busqueda/busqueda.modelo.ts`) va en español y con los montos en `Prisma.Decimal`.
- El mapper traduce con `compartido/enums.ts` y `compartido/formatos-salida.ts`, y nunca saca un
  `bigint` ni un ENUM en español. `compartido/dto/monto.dto.ts` es el `MoneyAmount` del contrato.
- Una prueba e2e valida la respuesta contra el esquema del contrato con
  `erroresContraContrato('SearchResponse', cuerpo)` (`test/utils/contrato.ts`).

Cómo arma las ofertas `busqueda/busqueda.service.ts` (todo en `REGLAS_BUSQUEDA`):

| Regla             | Valor                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Lo que se vende   | Salida `PROGRAMADO` o `DEMORADO` y futura; vuelo, aerolíneas, aeropuertos, tarifa, familia y moneda activos; cupo de la cabina ≥ pasajeros con asiento |
| Itinerarios       | Directos, o una escala de la misma aerolínea con conexión de 45 minutos a 6 horas              |
| Familias          | Las que tienen tarifa y cupo en todos los segmentos; el precio suma los segmentos             |
| Ofertas           | Un itinerario por tramo, misma aerolínea, cada tramo 45 minutos después del anterior          |
| Orden y tope      | Precio total, hora de salida e id de la salida; 10 itinerarios por tramo y aerolínea, 20 ofertas |
| Vigencia          | `SEARCH_OFFER_TTL_MINUTES` (30); cada búsqueda purga las vencidas sin retención              |

## Retenciones (hold)

`retencion/` implementa `/offers/hold`. El service lo arma todo; solo el repository toca la base.

| Regla              | Cómo                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Qué se retiene     | Una selección por itinerario de la oferta; `cabinClass` + `fareBrand` es una familia de su aerolínea     |
| Precio             | La tarifa vigente de cada segmento por tipo de pasajero, por la cantidad pedida (la cuenta de la búsqueda), congelada en `retencion_detalle` |
| Cupo               | Pasajeros con asiento (los infantes no), en la cabina de la familia de cada salida                     |
| Vigencia           | `HOLD_TTL_MINUTES` (15); `expiresAt` = creación + vigencia, con la hora del `Reloj`                     |
| Idempotencia       | Por usuario y clave, 24 horas; SHA-256 del cuerpo ya con los valores por defecto                      |
| Propiedad          | El dueño es el `sub`; un hold ajeno es 404. `flights:admin` consulta cualquiera, pero no lo libera      |

**Cupo sin sobreventa.** `tomarCupos` es una sola sentencia: bloquea las filas de
`inventario_cabina` con `SELECT ... ORDER BY salida, cabina FOR UPDATE` y resta solo donde
`cupos_disponibles >= cantidad`. Si cambió menos filas de las pedidas, la transacción entera se
deshace (409). El orden fijo evita deadlocks entre holds, y el catálogo ajusta las cabinas en ese
mismo orden (`ORDEN_CABINAS`). `devolverCupos` recalcula lo retenido desde la base y suma con el
mismo orden de bloqueo.

**Estados.** `RETENIDA` (HELD) pasa a `LIBERADA` (DELETE del dueño), `EXPIRADA` (al vencer) o
`CONSUMIDA` (la reserva). Todo cierre es `UPDATE ... WHERE estado = 'RETENIDA'` en una transacción
auditada: si dos procesos cierran el mismo hold, uno lo cambia y el otro no hace nada, así el cupo
nunca vuelve dos veces. Vencer lo audita sin usuario (es un proceso interno).

**Vencimiento.** Un hold vencido se cierra al consultarlo (GET o DELETE), antes de competir por el
cupo de sus salidas (POST) y con `VencimientoRetenciones` cada
`HOLD_EXPIRY_JOB_INTERVAL_SECONDS` (60), que también borra las claves de idempotencia vencidas.
Una corrida a la vez por proceso; entre instancias, `FOR UPDATE SKIP LOCKED`. La búsqueda no vence
holds: hasta que pase el proceso, el cupo de un hold vencido no se ve en `/search`.

**Idempotencia.** La clave se reclama con `INSERT ... ON CONFLICT DO NOTHING` en la misma
transacción que crea el hold, con la respuesta ya armada. Una segunda petición con la misma clave
espera a la primera: si la primera confirma, repite su respuesta; si se deshace (sin cupo), sigue.
Por eso un 409 no deja la clave usada.

### Cómo consume un hold la reserva

`RetencionModule` exporta `RetencionService`. `POST /bookings` llama, dentro de su propia
transacción auditada, a:

```ts
const resultado = await retenciones.consumir(holdId, usuario.id, tx);
// 'consumida' | 'no-existe' | 'vencida' | 'liberada' | 'ya-consumida'
```

- `'consumida'`: el hold quedó `CONSUMIDA` en la misma transacción que la reserva; el cupo no
  vuelve, pasa a la reserva. Si la reserva falla después dentro de esa transacción, el rollback
  deja el hold `RETENIDA` otra vez.
- `'no-existe'` (también el de otro usuario) es 422; `'vencida'` y `'liberada'`, 410;
  `'ya-consumida'`, 409. Ninguno cambia nada.

## Reservas y boletos

`reserva/` implementa `/bookings` y `boleto/` sus tickets (`/bookings/{bookingId}/tickets`, que
cuelga de la reserva con `RouterModule`). Solo los repository tocan la base; pasajeros, asientos,
pago, itinerarios, historial y cupones no tienen controller.

**Crear (POST /bookings).** Antes de abrir la transacción: la clave (si ya se usó, se repite la
respuesta), el hold (dueño, estado, vuelos que se siguen vendiendo), los pasajeros
(`pasajeros-reserva.ts`), los asientos elegidos (`asientos-reserva.ts`), el prefijo de boleto de la
aerolínea y el pago (`ServicioPagos.autorizar`). Un pago rechazado o inválido corta aquí: no queda
nada y el hold sigue `RETENIDA`. Después, UNA transacción auditada:

1. reclama la Idempotency-Key (guarda solo el `bookingId` y el status: los datos personales no van
   a `clave_idempotencia`);
2. consume el hold;
3. bloquea el inventario de sus cabinas en orden (salida, cabina) y elige los asientos: el pedido
   (de la cabina y libre) o el primero libre por fila y letra;
4. inserta la reserva con un PNR nuevo, sus itinerarios con el precio del hold, los pasajeros, los
   asientos y la referencia de pago;
5. crea un boleto PENDIENTE por pasajero (también los infantes) con un cupón por vuelo;
6. pago aprobado: `EMITIENDO_BOLETOS`, emite los boletos (número = prefijo + 10 dígitos) y
   `CONFIRMADA` (201). Pago pendiente: `PENDIENTE_PAGO` (202).

**Estados.** `PENDIENTE` → `PENDIENTE_PAGO` → `EMITIENDO_BOLETOS` → `CONFIRMADA`, o `FALLIDA` si el
pago se rechaza después o la emisión no puede hacerse (la aerolínea perdió su prefijo). Una
reserva `FALLIDA` deja sus boletos `FALLIDO` con el motivo, libera los asientos y devuelve el cupo;
el hold queda `CONSUMIDA`. Cada cambio es un `UPDATE` condicionado al estado anterior y deja una
línea en el historial (el `changes` del contrato).

**Emisión asíncrona.** `EmisionPendiente` revisa cada `BOOKING_ISSUE_JOB_INTERVAL_SECONDS` (30) las
reservas `PENDIENTE_PAGO`: consulta el pago (`ServicioPagos.consultar`) y, en una transacción por
reserva tomada con `FOR UPDATE SKIP LOCKED`, la confirma o la da por fallida. Una corrida a la vez
por proceso; entre instancias, `SKIP LOCKED` y el UPDATE condicionado.

**Eventos.** Todo cambio pasa por `EventosReserva.registrar(tx, reservaId, evento)` con el tipo
(`booking.created`, `booking.payment_pending`, `booking.ticket_issuing`, `booking.ticket_issued`,
`booking.ticket_failed`, `booking.confirmed`, `booking.failed`). Escribe el historial y, si el tipo
es de los 12 que el contrato deja suscribir, encola la entrega a los webhooks del dueño
(`PublicadorEventos`, ver Webhooks), todo en la transacción del cambio.

**Consultas.** Solo el dueño (el `sub` del hold); para cualquier otro, 404. `GET /bookings` ordena
por creación e id (descendente) y pagina con un cursor opaco (`creación|id` en base64url).

### Cómo se reemplaza ServicioPagos (RDA2)

`compartido/pagos/servicio-pagos.ts` es la interfaz; `PagosSimulados`, la implementación de RDA1
(el prefijo de la referencia decide: `PAY-OK-`, `PAY-PEND-`, `PAY-REJ-`). Para la Payment API real:

1. Escribir `PagosHttp implements ServicioPagos`: `autorizar(cobro)` consulta el pago con esa
   referencia y comprueba moneda, monto y concepto; `consultar(referencia)` devuelve su estado
   actual. Traduce la respuesta a `APROBADO`, `PENDIENTE`, `RECHAZADO` o `INVALIDO`.
   `reembolsar` y `consultarReembolso` piden y siguen la devolución de un pago (idempotentes por
   `operacion`, el quoteId).
2. En `PagosModule`, cambiar `useClass: PagosSimulados` por `useClass: PagosHttp` (y sus variables
   de entorno en `entorno.ts` y `.env.example`).

Las reservas, el proceso de emisión y las pruebas no cambian (las pruebas reemplazan el provider con
`crearApp({ reemplazos: [{ proveedor: SERVICIO_PAGOS, valor }] })`).

## Postventa (fase 8)

`equipaje/`, `cambio-fecha/` y `cancelacion/` cuelgan de `bookings/:bookingId` (cada una con su
`<entidad>.routes.ts`). Todas leen la reserva con `ReservaService.detalle` (404 si es de otro),
exigen `CONFIRMADA` y vuelos sin despegar (`reserva/reglas-postventa.ts`, con la hora del `Reloj`),
cobran con `Cobros`, escriben en la transacción auditada y pasan sus hechos por `EventosReserva`.
Lo que queda en 202 lo completa `PendientesPostventa` (en `operaciones/`, porque usa las tres).

**Equipaje.** Precio de una maleta: `precio_equipaje_adicional` de la tarifa de la familia vendida,
sumado sobre los vuelos del itinerario (el de hoy; se congela en `precio_unitario`). Máximo:
`maximo_equipaje_adicional` de la familia, por pasajero e itinerario; un infante no compra. La
compra bloquea la fila del pasajero, cuenta lo ya comprado (aprobado o pendiente) y recién ahí
reclama la clave: dos compras simultáneas nunca pasan el máximo. Un pago pendiente (`estado =
PENDIENTE` en `reserva_detalle_pago`) ya cuenta para el máximo pero no para `grandTotal`
(`vista_reserva_total` suma solo el equipaje aprobado).

**Cambio de fecha.** Buscar reutiliza `BusquedaService.itinerariosConPrecio` (las mismas consultas
y reglas de escala) para la misma ruta, aerolínea y familia en la nueva fecha; cada combinación se
guarda `OFERTADO` (`cambio_cabecera` + `cambio_detalle`) con sus diferencias y el cargo
(`cargo_cambio` de la tarifa original por pasajero con asiento). Confirmar bloquea la reserva, saca
la oferta de `OFERTADO` con un UPDATE condicionado (una confirmación gana), mueve el cupo con
`InventarioRepository.mover` (una sentencia ordenada: toma el de los vuelos nuevos y devuelve el
de los viejos), asigna asientos con `asientos-reserva.ts` y agrega las líneas nuevas apagadas.
Pagado: enciende las líneas nuevas y apaga las viejas, mueve las maletas a la línea nueva, libera
los asientos viejos y vuelve a emitir los boletos (`ReservaService.reemitirBoletos`: los anteriores
`ANULADO`). Pendiente: `CAMBIO_PENDIENTE` con los vuelos nuevos tomados; aprobado se aplica,
rechazado se deshace (cupo y asientos nuevos vuelven, la oferta queda `FALLIDO`).

**Cancelación.** La cotización devuelve, por itinerario, `(tarifa + impuestos + maletas aprobadas) ×
(100 − porcentaje_penalidad_cancelacion) / 100`; la penalidad es el resto de `grandTotal` (con los
cargos por cambio). Cancelar: una transacción acepta la cotización (vigente y una sola por reserva),
libera asientos y cupo (`ReservaService.liberarAsientosYCupo`), anula los boletos y deja
`CANCELACION_PENDIENTE`; después se pide el reembolso (`ServicioPagos.reembolsar`) y, aprobado,
otra transacción la deja `CANCELADA` con los boletos `REEMBOLSADO`. El reembolso se pide recién con
la cancelación confirmada: dos cancelaciones simultáneas nunca devuelven dos veces.

**Limpieza.** Las ofertas de cambio `OFERTADO` y las cotizaciones sin aceptar ya vencidas se borran
físicamente (como las ofertas de búsqueda) al buscar o cotizar y en cada corrida del proceso; las
confirmadas, pendientes, fallidas o aceptadas son parte de la reserva y no se tocan.

## Check-in, pases de abordar y estado de vuelo (fase 9)

**Check-in** (`checkin/`). Lee la reserva con `ReservaService.detalle` (404 si es de otro), exige
`CONFIRMADA` y boletos `EMITIDO` con cupón `EMITIDO` en cada vuelo, y calcula la ventana de cada vuelo
con su salida programada y el `Reloj`: abre `CHECKIN_OPENS_HOURS_BEFORE` horas antes (48) y cierra
`CHECKIN_CLOSES_MINUTES_BEFORE` minutos antes (60), solo con el vuelo `PROGRAMADO` o `DEMORADO`. Para
los vuelos con ventana abierta valida los datos (422 `CHECK_IN_FAILED`: asiento sin asignar,
pasaporte que vence antes del vuelo) y, en una transacción auditada, bloquea la reserva, relee lo
registrado e inserta un `checkin` `REGISTRADO` por pasajero (los adultos primero y el infante con su
adulto) con `ON CONFLICT (pasajero, vuelo) WHERE estado = 'REGISTRADO' DO NOTHING`
(`uq_checkin_registrado`): dos check-in simultáneos se serializan por el bloqueo, y el índice único
queda de respaldo. Cada registro nuevo de un pasajero con asiento emite su pase en la misma
transacción, y un vuelo con registros nuevos deja `booking.checked_in` en el historial. Solo se
guardan los `REGISTRADO`: que un vuelo no abra todavía (`NOT_CHECKED_IN`) o ya haya cerrado
(`FAILED`) se calcula con la hora y el estado del vuelo, así repetir no deja filas de más.

**Pases** (`pase-abordar/`). El código de barras lo arma y firma `CodigoPase` (HMAC-SHA256 con una
clave derivada de `JWT_SECRET` para este uso, 12 caracteres hexadecimales de firma); `verificar` lo
comprueba sin consultar la base. Grupo (`grupoDeAbordaje`), posición (`posicionDeAbordaje`) y tipo de
código (`tipoDeCodigo`) salen de la cabina y del asiento, y se guardan en `pase_abordar`. El asiento
no se guarda en el pase: se lee de `reserva_detalle_asiento` vigente, y solo se listan los pases de
los vuelos de los itinerarios vigentes de una reserva `CONFIRMADA`.

**Estado de vuelo** (`estado-vuelo/`). Solo lectura de `vuelo_programado` por (aerolínea
comercializadora, número, fecha local de salida): ninguna tabla de reservas ni de pasajeros.

### Pruebas de contrato (fase 11)

`test/contrato.e2e-spec.ts` recorre las 22 operaciones (un caso feliz y uno de error cada una)
y valida status y cuerpo contra el contrato; lo que el contrato no declara va en su lista de
`EXCEPCIONES`, con el motivo. Una operación nueva del contrato, o una respuesta nueva que no
declara, hace fallar la prueba hasta que se implementa o se acepta (y se anota en
`docs/DISCREPANCIAS-CONTRATO.md`). Las públicas son la búsqueda, el mapa de asientos y el estado
de vuelo.

## Webhooks (fase 10)

`webhook/` tiene las suscripciones (`GET` y `POST /webhooks`, `DELETE /webhooks/{id}`, scope
`flights:webhooks`) y, aparte, la bandeja de salida y su envío. Las tablas son `webhook_cabecera`
(la suscripción: dueño = `sub`, url, secreto cifrado, `activo`), `webhook_detalle` (sus eventos) y
`webhook_entrega` (una fila por suscripción y evento). `evento` y `evento_entrega` del esquema
original no se usan.

**Suscripciones.**

| Regla       | Valor                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| URL         | `https`; con `NODE_ENV` distinto de `production` también `http` hacia loopback. Sin usuario ni clave en la URL. Se resuelve el nombre y **todas** sus direcciones deben estar permitidas: se rechazan 10/8, 172.16/12, 192.168/16, fc00::/7, 169.254/16 (metadata de la nube), fe80::/10, 100.64/10, 0/8, multicast y reservadas; el loopback solo fuera de producción. El error dice `url` y no la repite |
| Eventos     | Lista no vacía, sin repetidos, solo los 12 de `WebhookSubscription.events`                                             |
| Secreto     | 16 a 256 caracteres sin espacios. Se guarda cifrado (AES-256-GCM; clave derivada con HKDF de `WEBHOOK_SECRET_KEY`, formato `v1.<base64url(nonce\|etiqueta\|cifrado)>`) porque hace falta en claro para firmar. Las respuestas lo devuelven enmascarado (`****` y los últimos 4) y la auditoría guarda `***` |
| Máximo      | 10 activas por usuario (409; las altas simultáneas se serializan con `pg_advisory_xact_lock` por usuario) y una URL activa no se repite por usuario (409) |
| Baja        | Lógica (`activo = false`), con auditoría; ajena, inexistente o ya dada de baja es 404                                  |
| Límite      | `POST /webhooks`: 10 por minuto e IP (cada alta resuelve DNS)                                                          |

`WEBHOOK_SECRET_KEY` es obligatoria (32 caracteres o más; la API no arranca sin ella). Cambiarla deja
ilegibles los secretos guardados: las suscripciones hay que registrarlas de nuevo.

**Cómo llega un evento a la entrega.** `PublicadorEventos` se llama **dentro de la transacción del
hecho** y hace un solo `INSERT ... SELECT ... ON CONFLICT DO NOTHING` que deja una fila `PENDIENTE`
en `webhook_entrega` por cada suscripción activa del dueño que escucha ese evento (si no hay
ninguna, no inserta nada). Si el hecho se deshace, la entrega también. Nunca hay HTTP en la
transacción. Los puntos de enganche:

| Evento                                  | Dónde                                                                                       | A quién                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `booking.*` (los 10 suscribibles)       | `EventosReserva.registrar`                                                                  | Dueño de la reserva                              |
| `hold.expired`                          | `RetencionRepository` (vencimiento perezoso y proceso de vencimiento)                       | Dueño del hold                                   |
| `flight.schedule_changed`               | `VueloProgramadoRepository.modificar`: cambia un horario programado o estimado, o la salida pasa a `DELAYED` | Dueños de las reservas vivas de esa salida (un evento por reserva) |
| `flight.cancelled`                      | `VueloProgramadoRepository.fijarActivo(false)`                                              | Ídem                                             |

El payload se arma al encolar y queda congelado (un reintento envía el mismo cuerpo). Es el
`WebhookPayload` del contrato: `eventId`, `eventType`, `occurredAt` (UTC), `apiVersion` (`1.5.0`) y
`data` con `bookingId`, `pnr` y `status` (el de la reserva en ese momento, ya traducido al contrato)
y `refundAmount` (texto decimal) en `booking.cancelled`. `hold.expired` lleva `holdId` y `status`;
los de vuelo, además, `flightNumber` y `segmentId`. Nada de datos personales.

**El envío.** `EntregaWebhooks` corre cada `WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS` (10), apagable con
`WEBHOOK_DELIVERY_JOB_ENABLED=false`, con el patrón de los otros procesos: una corrida a la vez por
proceso y, entre instancias, cada entrega se toma con `FOR UPDATE SKIP LOCKED` y un arrendamiento
de 2 minutos (`proximo_intento` pasa al fin del arrendamiento y el intento ya cuenta). El POST se
hace **fuera** de toda transacción y el resultado se anota con un UPDATE condicionado al intento
tomado: un resultado atrasado no pisa al de otro proceso, y si el proceso muere a mitad de un envío
la entrega vuelve sola. La entrega es "al menos una vez": el receptor deduplica por `X-Webhook-Id`.

| Cabecera               | Valor                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| `Content-Type`         | `application/json`                                                       |
| `X-Webhook-Event`      | El tipo del evento (`booking.confirmed`...)                              |
| `X-Webhook-Id`         | El `eventId`, igual en cada reintento                                    |
| `X-Webhook-Timestamp`  | Segundos desde 1970 del envío                                            |
| `X-Webhook-Signature`  | `sha256=` + HMAC-SHA256 en hexadecimal de `<timestamp>.<cuerpo>` con el secreto |

Un 2xx cierra la entrega (`ENTREGADO`). Cualquier otra cosa (otro código, una redirección, un error
de red o 5 s sin respuesta) es un fallo: se reintenta a 1 minuto, 5 minutos, 30 minutos y 2 horas, y
el quinto intento fallido la deja `FALLIDO`. Si las últimas 10 entregas resueltas de una suscripción
son `FALLIDO`, la suscripción se da de baja (lógica, auditada sin usuario); una `ENTREGADO` corta la
racha. Una suscripción dada de baja con entregas pendientes las cierra como `FALLIDO` sin enviar.
Cada intento deja una línea de log con el número de entrega, el tipo y el resultado: nunca la URL, el
secreto, el cuerpo ni la firma. El error guardado (`ultimo_error`) es un código (`HTTP_500`,
`ECONNREFUSED`, `TIMEOUT`...), no el mensaje de la librería.

**SSRF al enviar.** `ClienteWebhookHttp` vuelve a comprobar el destino sobre la dirección a la que
de verdad se conecta (su `lookup` rechaza antes de abrir el socket y una IP literal se juzga aparte),
así un nombre que cambia de dueño después de registrarse no llega a la red interna. No sigue
redirecciones y en producción solo usa `https`.

**Cómo se prueba.** El HTTP está detrás de `ClienteWebhook` (clase abstracta, token de inyección):
las pruebas lo reemplazan por un doble que contesta lo que cada caso necesita, o usan el real contra
un receptor local (`test/utils/receptor-webhook.ts`). El reloj de prueba adelanta los reintentos sin
esperar, y las pruebas llaman a `EntregaWebhooks.ejecutar()` con el proceso apagado.

## Cómo se agrega una entidad al catálogo

La lógica común está en `catalogo/base/`; una entidad nueva solo pone lo propio:

| Archivo                  | Qué hace                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `<entidad>.repository.ts` | Extiende `RepositorioCatalogo`: `claveDe`, `buscar`, `listar` (orden estable y página después de una fila), `estaActiva`, `fijarActivo`, más sus `insertar` y `modificar` |
| `<entidad>.service.ts`    | Extiende `ServicioCatalogo`: `insertar`, `modificar`, `usosQueImpidenDesactivar` (409) y, si depende de otra fila, `motivoQueImpideReactivar` (422) |
| `<entidad>.controller.ts` | `@ControllerAdmin(ETIQUETAS.x)` y las seis rutas con `DocCatalogo.*`; convierte con el mapper y `aPagina`          |
| `<entidad>.mapper.ts`     | Fila → JSON en inglés: ENUM con `compartido/enums.ts`, Decimal y fechas con `compartido/formatos-salida.ts`        |
| `<entidad>.routes.ts`     | `[{ path: '<ruta-en-inglés>', module: XModule }]`, colgado en `catalogo.routes.ts`                                 |

Reglas que siguen todas:

- El id en la URL es el código natural (ISO, IATA, número de vuelo) o un uuid; nunca el `bigint`
  interno. Una tabla sin clave natural lleva una columna `id_publico uuid` en el esquema.
- La baja es un `UPDATE` (`fijarActivo`), dentro de `enTransaccion` (la transacción auditada). Ningún
  archivo del catálogo llama a `delete`, `deleteMany` ni SQL sin parámetros: lo revisa
  `test/catalogo-borrado.e2e-spec.ts`.
- Las filas de detalle (asientos, cupos, precios por pasajero) no tienen controller: las crea y
  cambia el service de su cabecera, y no se quitan (no hay borrado).
- Una referencia a otra fila se resuelve por su clave pública con el repository de esa entidad y,
  si no existe o está inactiva, `referenciaInvalida(campo, detalle)` (422). Un duplicado lo
  rechaza la base y `common/errores/traducir-error-bd.ts` lo responde 409 (con un mensaje propio
  si la restricción está en `POR_RESTRICCION`).

Pruebas: `npm run test:e2e`. Un controller que solo existe en la prueba se agrega con
`crearApp([MiControllerDePrueba])` (ver `test/utils/crear-app.ts`).

> [!IMPORTANT]
> **Recordatorio (Fase RDA1):**
> Nos encontramos en la fase **RDA1**. En esta etapa **aún no hay integración** entre plataformas. 
> El archivo OpenAPI sirve actualmente solo como una **guía obligatoria** para que todos sigamos los mismos parámetros y estructuras.
> 
> **Objetivo Actual:** Cada equipo debe construir su aplicativo para que funcione de manera independiente y **subir su API correspondiente a Render**. La verdadera integración (la comunicación entre las APIs) se realizará en las siguientes fases (RDA2, etc.), una vez que se haya verificado que todas las aplicaciones individuales funcionan correctamente en la nube.
