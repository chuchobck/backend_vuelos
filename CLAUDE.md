# CLAUDE.md

Reglas permanentes del proyecto. Léelas antes de tocar código.

## Proyecto

Quinde · API de Vuelos: backend NestJS 10 + TypeScript + Prisma 7 que implementa el contrato
GDS Flight Core API v1.5.0.0 (`contracts/vuelos-openapi.yaml`), solo vuelos nacionales de Ecuador.
Los pagos y el GDS son simulados. El plan y el estado de las fases están en `docs/PLAN.md`; las
diferencias con el contrato, en `docs/DISCREPANCIAS-CONTRATO.md`. Versión 1.0.0 (`CHANGELOG.md`).

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
- Una sola tabla de rutas: `src/routes/index.routes.ts`.
- Las tablas de detalle no tienen controller: las maneja el service de su cabecera.
- El catálogo extiende `catalogo/base/` (`RepositorioCatalogo` y `ServicioCatalogo`); el patrón está
  en `src/modules/vuelos/README.md`. Rutas, query y JSON en inglés (`/reactivate`, `includeInactive`).
- Todas las URLs cuelgan de `/flights/v1`. Swagger en `/api/docs` con las 7 etiquetas del contrato.

## Seguridad

- Toda ruta exige JWT (guard global). Las públicas llevan `@Publico()`; las del contrato,
  `@Scopes(...)` con el scope que declara la operación en el contrato. Ver `src/common/README.md`.
- El usuario de la petición sale de `@UsuarioActual()`; su `id` es el `id_propietario`.
- Nunca registrar ni devolver contraseñas, hashes ni tokens, tampoco en mensajes de error.
- Los datos de un pasajero (nombre, documento, correo, teléfono) no van a logs ni a mensajes de
  error: el error nombra el campo, no el valor. Solo el dueño de la reserva los ve.
- Lo que sale en una respuesta como identificador legible (el código de barras de un pase, por
  ejemplo) lleva PNR, número de boleto o ids públicos, nunca nombre ni documento.
- Un pago se juzga solo con `ServicioPagos` (`compartido/pagos`); la API nunca recibe ni guarda
  datos de tarjeta, solo la `paymentReference`.
- Los scopes de cada rol están en `src/modules/auth/scopes.ts`, no en la base.
- Una operación pública lleva `@Publico()` y, si es costosa, su propio `@LimiteEstricto`.
- Toda petición con cuerpo es `application/json` (otro tipo: 415). El límite de peticiones
  cuenta con el `Reloj` (`AlmacenLimites`); una prueba de límites pasa un `RelojDePrueba`.
- El secreto de un webhook se guarda cifrado (AES-256-GCM, clave `WEBHOOK_SECRET_KEY`) y nunca se
  devuelve ni se registra: las respuestas lo enmascaran (`****` y los últimos 4) y la auditoría
  guarda `***`.
- Un webhook solo se envía desde `EntregaWebhooks` y por `ClienteWebhook`; nunca una llamada HTTP
  dentro de una transacción de negocio. Un evento nuevo se encola con `PublicadorEventos` en la
  misma transacción del hecho. Su URL se valida (https, sin redes internas) al registrar y otra vez
  al conectar (SSRF), y no se siguen redirecciones.

## Datos

- La base es la fuente de verdad (`db/*.sql`); no se usa `prisma migrate`.
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
  (`test/utils/contrato.ts`, Ajv).
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
