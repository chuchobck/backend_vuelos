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
  y `boleto/` (`/bookings` y `/bookings/{bookingId}/tickets`, fase 7).
- `compartido/`: traducción de los ENUM al contrato (`enums.ts`, con `ORDEN_CABINAS`), formatos de
  salida (`formatos-salida.ts`), los pasajeros de la búsqueda y el hold (`dto/pasajeros.dto.ts` y
  `pasajeros.ts`), `FechaIso` (`dto/validadores.ts`), las claves de idempotencia
  (`idempotencia.repository.ts`), el PNR y el número de boleto (`generador-codigos.ts`) y la Payment
  API (`pagos/`).
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
| Un pago                               | Inyectar `SERVICIO_PAGOS` (`compartido/pagos`): `autorizar` al crear y `consultar` después; nunca datos de tarjeta        |
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
`booking.ticket_failed`, `booking.confirmed`, `booking.failed`). Hoy solo escribe el historial; la
fase 10 agrega ahí la bandeja de webhooks (tabla `evento`) sin tocar a quien los emite.

**Consultas.** Solo el dueño (el `sub` del hold); para cualquier otro, 404. `GET /bookings` ordena
por creación e id (descendente) y pagina con un cursor opaco (`creación|id` en base64url).

### Cómo se reemplaza ServicioPagos (RDA2)

`compartido/pagos/servicio-pagos.ts` es la interfaz; `PagosSimulados`, la implementación de RDA1
(el prefijo de la referencia decide: `PAY-OK-`, `PAY-PEND-`, `PAY-REJ-`). Para la Payment API real:

1. Escribir `PagosHttp implements ServicioPagos`: `autorizar(cobro)` consulta el pago con esa
   referencia y comprueba moneda, monto y concepto; `consultar(referencia)` devuelve su estado
   actual. Traduce la respuesta a `APROBADO`, `PENDIENTE`, `RECHAZADO` o `INVALIDO`.
2. En `PagosModule`, cambiar `useClass: PagosSimulados` por `useClass: PagosHttp` (y sus variables
   de entorno en `entorno.ts` y `.env.example`).

Las reservas, el proceso de emisión y las pruebas no cambian (las pruebas reemplazan el provider con
`crearApp({ reemplazos: [{ proveedor: SERVICIO_PAGOS, valor }] })`).

### Cómo se apoyan las fases 8 y 9

- **Equipaje (fase 8).** `reserva_detalle_equipaje` cuelga del pasajero y del itinerario de la
  reserva y de un pago nuevo (`concepto = EQUIPAJE_ADICIONAL`, otra `paymentReference` vía
  `ServicioPagos`). `POST /bookings` rechaza `extraBaggage` (422): se compra después.
- **Cambio de fecha (fase 8).** Apaga la línea de `reserva_detalle_itinerario` (`vigente = false`) y
  agrega la nueva; libera los asientos de los vuelos viejos (`fecha_liberacion`), asigna los nuevos
  con las mismas reglas (`asientos-reserva.ts`) y emite los cupones nuevos. El cupo se mueve con el
  orden de bloqueo (salida, cabina).
- **Cancelación (fase 8).** `ReservaRepository.liberarAsientos` y `devolverCupo` ya hacen lo que
  pide (los usa hoy la reserva `FALLIDA`); los boletos pasan a `ANULADO` o `REEMBOLSADO`.
- **Check-in y pase de abordar (fase 9).** Parten del pasajero (`reserva_detalle_pasajero`), su
  asiento vigente en ese vuelo (`reserva_detalle_asiento`) y su cupón `EMITIDO` (`boleto_detalle`):
  solo una reserva `CONFIRMADA` hace check-in.
- Todas pasan sus cambios de estado por `EventosReserva` para que la fase 10 los notifique.

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
