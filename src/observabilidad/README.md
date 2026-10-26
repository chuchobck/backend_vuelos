# src/observabilidad

Trazas (OpenTelemetry, W3C Trace Context) y métricas (prom-client) del core, con el estándar de
Quinde: [docs/OBSERVABILIDAD.md del gateway](https://github.com/chuchobck/gateway_vuelos/blob/main/docs/OBSERVABILIDAD.md)
(fase 7a). Ese documento manda; un cambio de nombres, etiquetas o atributos se hace allí primero.

| Archivo | Qué hace |
| --- | --- |
| `traceparent.ts`, `atributos.ts`, `trazas.ts`, `metricas.ts` | **Copiados tal cual del gateway** (`src/observabilidad/`), salvo lo de abajo. No se editan aquí |
| `observabilidad.ts` | `Observabilidad`: crea `Trazas` y `Metricas`, sirve `/metrics` en `METRICS_PORT` y ofrece `interno`, `cliente` y `corridaDeJob` |
| `express.ts` | El middleware que va **primero**: el span SERVER de cada petición REST y `X-Trace-Id` (el equivalente de `fastify.ts`) |
| `plantilla-ruta.ts` | La plantilla de la ruta (`/flights/v1/bookings/{bookingId}`), para el span, la etiqueta `route` y el log |
| `grpc.ts` | El span SERVER de una llamada gRPC, hijo del `traceparent` de la metadata |
| `contexto-traza.ts` | `traceparentActivo()` (se guarda en la bandeja) y `contextoDeTraceparent()` (lo continúa el relevo) |
| `metricas-core.ts`, `metricas-bandeja.ts` | Las métricas `core_*`: reservas, publicaciones, jobs y los gauges de la bandeja |

**Una divergencia respecto del gateway**: `atributos.ts` suma `rpc.system`, `rpc.service`, `rpc.method`
y `rpc.grpc.status_code` a la lista de atributos permitidos, para el span de una llamada gRPC. El
estándar todavía no los lista: hay que subirlos a `docs/OBSERVABILIDAD.md` del gateway.

Reglas que no se rompen:

- Sin instrumentaciones automáticas ni un span por consulta SQL. Los `INTERNAL` llevan nombre fijo:
  `retencion.crear`, `reserva.crear`, `reserva.emitir-boletos`, `cancelacion.cancelar` y
  `job <nombre>`.
- Nada de pnr, ids, correos, IPs, tokens ni cuerpos en un atributo, una etiqueta o una línea de log.
- Un error lleva `error.type` de la lista cerrada, nunca su mensaje.
- La entrega de un webhook a un **tercero** nunca lleva `traceparent`.
