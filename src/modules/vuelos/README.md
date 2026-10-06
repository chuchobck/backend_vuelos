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
- `operaciones/<entidad>/`: los endpoints del contrato (fases 5 a 10). Hechos: `busqueda/` (`POST /search`)
  y `oferta/` (`GET /offers/{offerId}/seatmap`).
- `compartido/`: traducción de los ENUM al contrato (`enums.ts`) y formatos de salida (`formatos-salida.ts`).
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
