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
ya no existe: se quitó en la fase 1. Hoy `VuelosModule` está vacío y las entidades se agregan por
fases (ver [docs/PLAN.md](../../../docs/PLAN.md)):

- `catalogo/<entidad>/`: CRUD de administrador en `/admin/...` con una clase base (fase 4).
- `operaciones/<entidad>/`: los endpoints del contrato (fases 5 a 10).
- Cada entidad lleva `<entidad>.routes.ts`, controller, service, repository (el único que usa Prisma),
  mapper y `dto/`; las rutas se cuelgan en `vuelos.routes.ts`.

Lo transversal ya lo da la API a cualquier controller nuevo, sin código extra:

| Qué                                   | Cómo se usa                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Errores `application/problem+json`    | Lanzar `ErrorNegocio(status, CodigoError.X, 'detalle en inglés')` desde el service; el filtro global arma el cuerpo     |
| Errores de la base                    | No se capturan: el filtro traduce unique, FK, `RESTRICT`, CHECK y los triggers del esquema (`common/errores`)           |
| Validación de la entrada              | DTO con class-validator; el `ValidationPipe` global rechaza campos de más con 400 `VALIDATION_FAILED`                    |
| Parámetros de ruta y de query         | `@Param('id', UuidPipe)`, `@Query('date', FechaPipe)`, `CodigoIataAeropuertoPipe`, `CodigoIataAerolineaPipe`            |
| Texto libre del cliente               | `@TextoLimpio()` en el DTO (recorta, normaliza y rechaza controles y HTML); ver `src/common/sanitizacion/README.md`    |
| Límite de peticiones                  | Ya aplica a toda ruta; `@LimiteEstricto(5, 60)` da uno propio y `@SinLimiteDePeticiones()` la excluye                  |
| Escritura con auditoría               | `prisma.transaccionAuditada(tx => ...)` toma usuario e IP del contexto de la petición                                   |
| Request id, IP y usuario              | `obtenerContexto()` en `common/contexto`; el guard de JWT (fase 3) llamará a `fijarUsuario(sub)`                        |

Pruebas: `npm run test:e2e`. Un controller que solo existe en la prueba se agrega con
`crearApp([MiControllerDePrueba])` (ver `test/utils/crear-app.ts`).

> [!IMPORTANT]
> **Recordatorio (Fase RDA1):**
> Nos encontramos en la fase **RDA1**. En esta etapa **aún no hay integración** entre plataformas. 
> El archivo OpenAPI sirve actualmente solo como una **guía obligatoria** para que todos sigamos los mismos parámetros y estructuras.
> 
> **Objetivo Actual:** Cada equipo debe construir su aplicativo para que funcione de manera independiente y **subir su API correspondiente a Render**. La verdadera integración (la comunicación entre las APIs) se realizará en las siguientes fases (RDA2, etc.), una vez que se haya verificado que todas las aplicaciones individuales funcionan correctamente en la nube.
