# CLAUDE.md

Reglas permanentes del proyecto. Léelas antes de tocar código.

## Proyecto

Quinde · API de Vuelos: backend NestJS 10 + TypeScript + Prisma 7 que implementa el contrato
GDS Flight Core API v1.5.0.0 (`contracts/vuelos-openapi.yaml`), solo vuelos nacionales de Ecuador, y
la fachada del contrato de Vuelos v2 (`contracts/vuelos-openapi-v2.yaml`) para Booking Prototipo; sus
diferencias y decisiones, en `docs/V2-DIFERENCIAS.md`.
Los pagos y el GDS son simulados. El plan y el estado de las fases están en `docs/PLAN.md`; las
diferencias con el contrato, en `docs/DISCREPANCIAS-CONTRATO.md`. Versión 1.1.0 (`CHANGELOG.md`),
más las fases 4b (auth externa, `AUTH_MODE`), 5b (eventos al notifier, `WEBHOOKS_MODE`), 7c
(observabilidad) y V1 (fachada v2) sin publicar.
Además de REST, un servidor gRPC interno para el BFF (`docs/GRPC.md`), apagado por defecto.

## Alcance

Este repo es solo del dominio de vuelos. Los otros dominios (alojamientos, autos, atracciones) viven
en los repos de sus equipos; la plantilla original queda como remoto `upstream` solo de referencia.

## Idioma

- Código, carpetas y base de datos en español.
- Rutas y JSON hacia afuera en inglés, como el contrato. Un mapper por entidad traduce.

## Estructura

- Cada entidad lleva `<entidad>.controller.ts` y `<entidad>.routes.ts`, más module, service,
  repository (el único archivo que usa Prisma), mapper y `dto/`.
- Catálogo (CRUD de administrador en `/admin/...`, con clase base): `src/modules/vuelos/catalogo/<entidad>/`
  con pais, ciudad, aeropuerto, aerolinea, modelo-aeronave, familia-tarifa, mapa-asientos, vuelo,
  vuelo-programado y tarifa.
- Operaciones del contrato: `src/modules/vuelos/operaciones/<entidad>/` con busqueda, oferta,
  retencion, reserva, boleto, equipaje, cambio-fecha, cancelacion, checkin, pase-abordar,
  estado-vuelo y webhook.
- Fuera de vuelos: `salud` y `auth`.
- gRPC: un `<entidad>.grpc.ts` junto a la entidad, con `@ControladorGrpc()`, que llama al mismo
  service y usa el mismo DTO o pipes y el mismo mapper que REST (solo cambia los enums con
  `aEnumProto`). El contrato es `contracts/proto/flights/v1/flights.proto`: nunca renumerar ni
  reusar un campo, `reserved` al quitar, y `npm run proto:lint` y `npm run proto:breaking` limpios.
- Una sola tabla de rutas: `src/routes/index.routes.ts`.
- Las tablas de detalle no tienen controller: las maneja el service de su cabecera.
- El catálogo extiende `catalogo/base/` (`RepositorioCatalogo` y `ServicioCatalogo`); el patrón está
  en `src/modules/vuelos/README.md`. Rutas, query y JSON en inglés (`/reactivate`, `includeInactive`).
- Todas las URLs cuelgan de `/flights/v1`, salvo la fachada v2. Swagger en `/api/docs` con las 7
  etiquetas del contrato.
- Fachada v2: `src/modules/vuelos/v2/` (`FachadaV2Module`), en `/api/v2/vuelos` fuera del prefijo
  global y con controllers `VERSION_NEUTRAL`: un controller por microservicio del contrato v2
  (`vuelos.v2`, `reservas.v2`, `postventa.v2`) que llama a los mismos services de v1 y suma lo de v2
  con su mapper (`_links`, `status` de asiento, cancelación extendida). Cada ruta lleva
  `@OperacionContrato('<operationId>')`. Nada de lógica de negocio propia: si v2 necesita una regla
  distinta, el service de v1 la recibe como opción (`OpcionesReservaV2`, `PagoDeFachada`...) y v1 no
  la pasa. Swagger aparte en `/api/v2/docs`.
- Un error que cambia de `code` o de status en v2 lleva la pista en `ErrorNegocio` (`v2: { code,
  status? }`); el filtro arma el `ProblemDetails` v2 en `/api/v2/**` y el de v1 no cambia.

## Seguridad

- Toda ruta exige JWT (guard global). Las públicas llevan `@Publico()`; las del contrato,
  `@Scopes(...)` con el scope que declara la operación en el contrato. Ver `src/common/README.md`.
- Quién emite el JWT lo decide `AUTH_MODE`: `local` (por defecto, el core con `/auth` y HS256) o
  `external` (identity_vuelos, RS256 por su JWKS; `/auth` y `/admin/users` no se montan). El guard
  depende solo de `VerificadorToken`; el algoritmo se fija en el código, nunca se lee del token.
  Sin claves con las que verificar, 503 `AUTH_UNAVAILABLE`, nunca 401 ni dejar pasar. El modo
  local no se quita hasta que ya no haga falta volver a él (docs/DEPLOY.md, sección 6).
- Ni un token ni el JWKS van al log: sí el `kid` y el motivo de un rechazo.
- El usuario de la petición sale de `@UsuarioActual()`; su `id` es el `id_propietario`. En v2 sale de
  `@UsuarioFachada()`: un token con `client_id` es un partner y solo con él cuentan `X-User-Id` y
  `X-User-Roles`; con un token de persona se ignoran. Un partner con `X-User-Id` solo ve y opera las
  reservas de ese usuario (`FachadaV2Service.exigirAcceso`).
- Nunca registrar ni devolver contraseñas, hashes ni tokens, tampoco en mensajes de error.
- Los datos de un pasajero (nombre, documento, correo, teléfono) no van a logs ni a mensajes de
  error: el error nombra el campo, no el valor. Solo el dueño de la reserva los ve.
- Lo que sale en una respuesta como identificador legible (el código de barras de un pase, por
  ejemplo) lleva PNR, número de boleto o ids públicos, nunca nombre ni documento.
- Un pago se juzga solo con `Cobros` y `ServicioPagos` (`compartido/pagos`); la API nunca recibe ni
  guarda datos de tarjeta, solo la `paymentReference`. Con `provider = BOOKING_PROTOTIPO` (v2) cobró
  Booking: no se llama a la Payment API, solo se valida la referencia y el monto, y un reembolso se
  calcula pero no se ejecuta.
- Los scopes de cada rol están en `src/modules/auth/scopes.ts`, no en la base.
- Una operación pública lleva `@Publico()` y, si es costosa, su propio `@LimiteEstricto`.
- Toda petición con cuerpo es `application/json` (otro tipo: 415). El límite de peticiones
  cuenta con el `Reloj` (`AlmacenLimites`); una prueba de límites pasa un `RelojDePrueba`.
- El secreto de un webhook se guarda cifrado (AES-256-GCM, clave `WEBHOOK_SECRET_KEY`) y nunca se
  devuelve ni se registra: las respuestas lo enmascaran (`****` y los últimos 4) y la auditoría
  guarda `***`.
- Quién reparte los webhooks lo decide `WEBHOOKS_MODE`: `local` (por defecto, el core con
  `webhook_entrega` y `EntregaWebhooks`) o `notifier` (el core guarda un evento por hecho en
  `evento_saliente`, con el `traceparent` del hecho, y `RelevoEventos` lo publica al notifier;
  `/webhooks` no se monta). Los que
  publican usan siempre `PublicadorEventos`, con las mismas firmas en los dos modos. El sobre se
  congela al guardarlo y se manda byte a byte; su forma es la de `contracts/notifier-eventos` (no se
  edita a mano: `npm run eventos:sync`). Ni el `client_secret` ni el token del notifier van al log.
- Un webhook solo se envía desde `EntregaWebhooks` y por `ClienteWebhook`; nunca una llamada HTTP
  dentro de una transacción de negocio. Un evento nuevo se encola con `PublicadorEventos` en la
  misma transacción del hecho. Su URL se valida (https, sin redes internas) al registrar y otra vez
  al conectar (SSRF), y no se siguen redirecciones.

## Correlación

- `X-Correlation-Id` (v1 y v2): el que llega con formato válido (`[A-Za-z0-9._:-]{1,100}`) se usa SIN
  cambios; si no, `corr-<uuid>`. Lo pone el primer middleware en el contexto (`correlationId`), sale en
  cada respuesta y en el `ProblemDetails` v2, y se propaga a todo lo que la petición llama: la Payment
  API (`CobroEsperado.correlationId`), el notifier (`evento_saliente.correlation_id` y la cabecera de
  la publicación) y gRPC (metadata `x-correlation-id`). Una llamada saliente nueva lo manda con
  `correlacionActual()`.
- Cada línea de log de texto lleva `[corr=...]` al final de la primera línea, y cada petición deja
  una línea de acceso JSON (`registro-acceso.ts`) sin URL, query, cuerpo, IP ni usuario.

## Observabilidad

- El estándar es `docs/OBSERVABILIDAD.md` del gateway (chuchobck/gateway_vuelos): un cambio de
  nombres, etiquetas, atributos o propagación se hace allí primero. Los cuatro archivos de
  `src/observabilidad/` (`traceparent`, `atributos`, `trazas`, `metricas`) se copian de ahí y no se
  editan aquí (la única divergencia, los atributos `rpc.*`, está anotada en su README).
- El SDK de trazas siempre arranca; el exportador, solo con `OTEL_EXPORTER_OTLP_ENDPOINT`. Una
  petición nunca espera al recolector. El core continúa el `traceparent` que recibe
  (`TRACE_TRUST_INCOMING=true`): solo lo alcanzan el gateway y el BFF.
- El middleware de `express.ts` va **primero** en `configurar-app.ts`. Una llamada gRPC abre su
  span en `contextoDeLlamada` y lo cierra `registrarLlamada` (el interceptor en éxito, el filtro en
  error).
- Spans manuales con `Observabilidad`: `interno(nombre)` con nombre FIJO para una operación de
  negocio (nunca un span por consulta SQL), `cliente(...)` para un servicio al que se llama (la
  Payment API, detrás de `PagosObservados`) y `corridaDeJob(job)`: cada corrida de un proceso
  periódico es su propia traza raíz. El relevo abre su CLIENT hacia el notifier como hijo del
  `traceparent` que guardó la bandeja.
- `route` (nombre del span, etiqueta y línea de log) es siempre la **plantilla** o `__unmatched__`,
  nunca la URL pedida. Ni pnr, ni ids de reserva, ni correos, ni IPs, ni tokens, ni cuerpos en un
  atributo, una etiqueta o un log; las etiquetas de `core_*` son de listas cerradas.
- La entrega de un webhook a un **tercero** (`EntregaWebhooks`, `ClienteWebhook`) NUNCA manda
  `traceparent` ni `tracestate`.
- `/metrics` solo en `METRICS_PORT`, aparte de `PORT`; el ingress no lo expone. Los gauges de la
  bandeja se leen al raspar, con plazo, y solo con `WEBHOOKS_MODE=notifier`.
- Cada línea del log lleva `traceId` y `spanId` (el span activo, o el SERVER de la petición).

## Datos

- La base es la fuente de verdad (`db/*.sql`); no se usa `prisma migrate`. Un cambio de esquema va
  en `db/esquema_vuelos.sql` y, para las bases que ya existen, en una migración idempotente de
  `db/migraciones/` que aplica `./db/migrar.sh`. CI comprueba (`scripts/comprobar-migraciones.sh`) que
  el esquema de `main` más las migraciones deja una base igual a una nueva.
- Eliminación lógica siempre; nada de `DELETE` físico en datos de negocio.
- Las fechas van siempre en UTC (un `date` llega a medianoche UTC).
- El dinero llega como `Decimal` y se convierte en el mapper; un `bigint` nunca sale al cliente.
  El id en una URL es un código natural (ISO, IATA, número de vuelo) o un uuid; una tabla sin
  clave natural lleva `id_publico uuid` en el esquema.
- El dinero que entra también es texto (`"35.00"`), validado con expresión regular; nunca `number`.
- El cupo (`inventario_cabina`) solo se mueve con UPDATE condicionado dentro de una transacción
  auditada, bloqueando las filas en orden (salida, cabina) para no cruzarse con otro proceso.
- Un vencimiento nuevo se decide con la hora de `Reloj` (`src/common/reloj.ts`), no con
  `new Date()` ni `now()` de la base: las pruebas lo adelantan. Ya lo usan los holds, las claves
  de idempotencia, la entrega de webhooks y el límite de peticiones; las ofertas de la búsqueda todavía no (ver Pendientes del plan).
- Una baja de catálogo es `activo = false` (una salida: estado `CANCELADO`) y responde 409 si otras
  filas activas la usan. Las filas de detalle (asientos, cupos, precios) no se quitan.
- Las pruebas e2e no borran: crean cuentas `@e2e.quinde.example` y catálogo con códigos libres al
  azar, y al final lo dan de baja.
- Ningún `.json` con el mismo nombre base que un `.ts`: Jest importaría el JSON.
- SQL crudo solo con plantillas etiquetadas (`$queryRaw\`...\``), tablas calificadas `vuelos.` y los ENUM
  comparados como `::text`. Solo ofertas, itinerarios, claves de idempotencia, ofertas de cambio sin
  confirmar y cotizaciones sin aceptar se borran físicamente (las vencidas), con `deleteMany` para
  que pase por la extensión de bloqueo (`TABLAS_CON_BORRADO_FISICO`).
- `webhook_entrega` es la bandeja de salida: no se borra. Cada intento se anota con un UPDATE
  condicionado al intento tomado, y el log de un intento no lleva URL, secreto ni cuerpo.
- Las respuestas de las operaciones del contrato se validan contra sus esquemas en las pruebas
  (`test/utils/contrato.ts`, Ajv); las de v2, contra el contrato v2 por operationId y status
  (`test/utils/contrato-v2.ts`, `test/contrato-v2.e2e-spec.ts`).
- Una respuesta que el contrato no declara (status nuevo, cuerpo distinto) va a `EXCEPCIONES` de
  `test/contrato.e2e-spec.ts` con su motivo y a `docs/DISCREPANCIAS-CONTRATO.md`; una diferencia
  de Swagger con el contrato, a `DIFERENCIAS_ACEPTADAS` de `test/swagger.e2e-spec.ts`. Los
  ejemplos de Swagger (`example`) tienen que funcionar con la semilla.

## Git

- Commits en Conventional Commits y en español: `tipo(ámbito): verbo en infinitivo y qué cambia`.
- Un commit por paso, y cada uno compila con `npm run lint`, `npm run format:check` y
  `npm run build` limpios.
- Una rama por fase. Push solo de esa rama, al cerrar la fase y ya verificada; nunca a `main`,
  nunca `--force`, nunca reescribir commits subidos. El merge lo hace el dueño del repo.

## Verificación

- Verificar con `curl` o pruebas, no solo compilando. CI (`.github/workflows/ci.yml`) corre lint,
  formato, build y la suite e2e en cada push y pull request a `main`.
- Contra un despliegue: `scripts/smoke.sh <BASE_URL>` (guía en `docs/DEPLOY.md`).
- Una variable de entorno nueva va en `src/config/entorno.ts`, `.env.example`, `docs/DEPLOY.md`
  y, si es obligatoria, en `render.yaml` (`sync: false`) y en el `env` de CI.
- Al terminar cada fase: actualizar `docs/PLAN.md` y entregar un resumen con qué se verificó,
  qué no se pudo verificar y qué se decidió sin consultar.
