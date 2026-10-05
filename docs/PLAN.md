# Plan del backend — Quinde · API de Vuelos

Actualizado: 2026-10-05 · Este archivo se actualiza al cerrar cada fase.

El backend se construye sobre la plantilla del equipo (NestJS 10 en TypeScript), con Prisma sobre la base PostgreSQL 18 que ya está cargada, en 12 fases que terminan con la API desplegada en Render para RDA1.

## Avance

| Fase | Estado | Verificado |
| --- | --- | --- |
| 0. Base del repo | Hecha (2026-10-05) | `npm ci`, `npm run lint`, `npm run format:check` y `npm run build` pasan en un clon limpio; el hook rechaza mensajes de commit inválidos; `db/reset.sh` carga esquema y semilla en PostgreSQL 18 |
| 1. Núcleo | Siguiente | |
| 2 a 11 | Pendientes | |

## Decisiones

La plantilla manda en lenguaje y framework; lo único que se reemplaza es el ORM.

| Tema | Decisión | Por qué |
| --- | --- | --- |
| Lenguaje | TypeScript | La plantilla ya está en TypeScript. Nest usa decoradores y tipos para validar los DTO y generar Swagger; en JavaScript habría que reescribirla y agregar Babel. Esto cambia lo que habíamos dicho antes (JavaScript). |
| Framework | NestJS 10, el de la plantilla | Es Nest, no Next: Next.js es para frontend con React. Se queda en la versión 10 para no separarse de los otros equipos. |
| ORM | Prisma 7 en lugar de TypeORM | La plantilla trae TypeORM con `synchronize: true`, que crea y altera tablas a partir de las entidades. Nuestra base nace del SQL y tiene triggers y ENUM; Prisma solo la lee con `db pull`. |
| Fuente de verdad de la base | Los archivos de `db/` | Un cambio se hace en el SQL y después se corre `prisma db pull`. No se usa `prisma migrate`. |
| Rutas | Una sola tabla en `src/routes/index.routes.ts` | Usa el `RouterModule` de Nest: cada módulo declara su ruta en un `*.routes.ts` y el índice las junta. Los controladores no llevan prefijos. |
| Versionado | En la URL: `/flights/v1/...` | Es la misma base que el `servers` del contrato. Prefijo global `flights` más versionado de Nest con versión 1 por defecto; una v2 se agrega por controlador con `@Version('2')`. |
| Capas de cada módulo | routes → controller → service → repository | El controller solo maneja HTTP, el service tiene las reglas y el repository es el único que usa Prisma. |
| Idioma | Rutas y JSON en inglés; código, carpetas y base en español | El contrato fija el inglés hacia afuera. Un mapper por módulo traduce entre los dos. |
| Errores | Filtro global que responde `application/problem+json` | El contrato exige `ProblemDetails` con un `code` de lista cerrada. |
| Documentación viva | Swagger generado del código en `/api/docs` | Una prueba compara el OpenAPI generado con `contracts/vuelos-openapi.yaml`, para que no se separen. |
| Autenticación | Módulo `auth` propio que emite JWT | El contrato deja la identidad en otro servicio, pero en RDA1 la API tiene que funcionar sola. En RDA2 se cambia por el proveedor real. |
| Eliminación | Lógica: `activo = false` o cambio de estado | Ningún endpoint ejecuta un `DELETE` de SQL sobre datos de negocio. |
| CRUD de catálogo | Rutas `/flights/v1/admin/...`, fuera del contrato | El contrato no tiene mantenimiento de aeropuertos, vuelos ni tarifas, y el curso pide CRUD. |
| Pagos y GDS | Simulados | El pago llega como `paymentReference` y se da por bueno; la emisión de boletos es local. |

El diseño de rutas está probado sobre la plantilla: `GET /flights/v1/bookings/{bookingId}/tickets` respondió 200 y `/flights/v2/...` respondió 404.

## Nombre y logo

El proyecto se llama **Quinde**: así se le dice al colibrí en Ecuador, la palabra viene del kichwa y el ave es rápida y precisa al volar.

| Dónde | Valor |
| --- | --- |
| Repositorio y `name` del `package.json` | `quinde-vuelos-api` |
| Título en Swagger | Quinde · API de Vuelos |
| Descripción en Swagger | Implementación del contrato GDS Flight Core API v1.5.0.0 para vuelos nacionales de Ecuador |
| Emisor de los JWT (`iss`) | `quinde-vuelos-api` |
| Logo | `docs/logo.svg`, usado en el README y como ícono de Swagger |

Una búsqueda rápida no mostró ninguna aerolínea ecuatoriana con ese nombre. No es una revisión de marcas registradas; para un proyecto de curso alcanza.

## Camino de una petición

Cada llamada baja por siete capas y solo la última usa Prisma; guards, validación, service y repository pueden cortar el camino, y el filtro de errores le da a todos los fallos la misma forma.

```mermaid
flowchart TD
    C([Petición del cliente]) --> A1["1. Seguridad HTTP<br/>helmet, CORS, límite de peticiones y de tamaño"]
    A1 --> A2["2. Tabla de rutas<br/>index.routes.ts resuelve /flights/v1/..."]
    A2 --> A3["3. Guards<br/>JWT válido, permiso requerido, Idempotency-Key"]
    A3 --> A4["4. Validación y sanitización<br/>DTO del contrato: tipos, formatos, texto limpio"]
    A4 --> A5["5. Controller<br/>Solo HTTP: recibe el DTO y devuelve la respuesta"]
    A5 --> A6["6. Service<br/>Reglas de negocio y transacciones"]
    A6 --> A7["7. Repository<br/>Único punto con Prisma; filtra por dueño y activo"]
    A7 --> DB[("PostgreSQL 18, esquema vuelos<br/>Triggers de integridad y de auditoría")]
    A3 & A4 & A6 & A7 -. si rechaza o falla .-> E["Filtro de errores<br/>application/problem+json con el code del contrato"]
```

Por eso un controlador nunca abre la base ni arma un error a mano: recibe un DTO ya validado, llama al service y devuelve lo que este responde.

## Esqueleto

Todo lo de vuelos queda dentro de `src/modules/vuelos`, como pide la plantilla, dividido en submódulos. Lo transversal va en `common`, `config`, `prisma` y `routes`.

```text
quinde-vuelos-api/
├── contracts/                    # contratos de la plantilla, no se tocan
├── db/
│   ├── esquema_vuelos.sql
│   ├── esquema_seguridad.sql     # fase 3: usuarios, roles y tokens
│   ├── semilla_vuelos.sql
│   ├── semilla_seguridad.sql     # roles, permisos y usuario administrador
│   ├── prueba_esquema.sql
│   └── reset.sh
├── docs/
│   ├── logo.svg
│   ├── logo-icono.svg
│   └── PLAN.md
├── prisma/
│   └── schema.prisma             # lo genera db pull, no se edita a mano
├── src/
│   ├── main.ts                   # arranque: seguridad, versionado, Swagger
│   ├── app.module.ts
│   ├── config/                   # variables de entorno validadas al arrancar
│   ├── routes/
│   │   └── index.routes.ts       # la única tabla de rutas de la API
│   ├── prisma/
│   │   ├── prisma.module.ts
│   │   ├── prisma.service.ts
│   │   └── extensiones/          # bloqueo de delete físico, transacción auditada
│   ├── common/
│   │   ├── contexto/             # usuario e IP de la petición en curso
│   │   ├── decorators/           # @Publico, @Scopes, @UsuarioActual
│   │   ├── dto/                  # de la plantilla: respuesta base y paginación
│   │   ├── errores/              # códigos del contrato, excepción de negocio
│   │   ├── filters/              # problem-details.filter.ts
│   │   ├── guards/               # jwt-auth, scopes, idempotency-key (plantilla)
│   │   ├── interceptors/         # idempotencia, request-id
│   │   ├── pipes/                # uuid, fecha, código IATA
│   │   └── sanitizacion/         # limpieza de texto para los DTO
│   └── modules/
│       ├── salud/                # GET /health
│       ├── auth/                 # registro, login, refresh, logout, me
│       └── vuelos/
│           ├── vuelos.module.ts  # junta los submódulos
│           ├── vuelos.routes.ts  # rutas de todos los submódulos
│           ├── compartido/       # cálculo de precios, mapeo de enums
│           ├── catalogo/         # aeropuertos, aerolíneas, vuelos, tarifas
│           ├── busqueda/
│           ├── retenciones/
│           ├── reservas/
│           ├── boletos/
│           ├── postventa/
│           ├── checkin/
│           ├── estado-vuelos/
│           └── webhooks/
├── test/                         # pruebas e2e, una carpeta por fase
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

Cada submódulo repite la misma forma. Ejemplo con reservas:

```text
reservas/
├── reservas.module.ts
├── reservas.routes.ts      # { path: 'bookings', module: ReservasModule }
├── reservas.controller.ts  # solo HTTP: recibe el DTO y responde
├── reservas.service.ts     # reglas de negocio y transacciones
├── reservas.repository.ts  # único archivo que usa Prisma
├── reservas.mapper.ts      # fila en español → JSON del contrato
└── dto/                    # entrada y salida, con validación y Swagger
```

El índice de rutas queda así de corto:

```ts
// src/routes/index.routes.ts
export const rutas: Routes = [
  { path: 'health', module: SaludModule },
  { path: 'auth', module: AuthModule },
  ...vuelosRoutes, // search, offers, bookings, flights, webhooks, admin
];
```

## Mapa del contrato

Los 22 endpoints del contrato se reparten en 8 submódulos. Todas las rutas cuelgan de `/flights/v1`.

| Endpoint | Submódulo | Permiso | Idempotency-Key | Tablas principales |
| --- | --- | --- | --- | --- |
| `POST /search` | busqueda | Público, exige `X-Device-Fingerprint` | No | `vuelo_programado`, `inventario_cabina`, `tarifa_*`, `itinerario_*`, `oferta_*` |
| `GET /offers/{offerId}/seatmap` | busqueda | Público | No | `mapa_asientos_*`, `asiento`, `reserva_detalle_asiento` |
| `POST /offers/hold` | retenciones | `flights:hold` | Sí | `retencion_*`, `inventario_cabina` |
| `GET /offers/hold/{holdId}` | retenciones | `flights:read` | No | `retencion_*` |
| `DELETE /offers/hold/{holdId}` | retenciones | `flights:hold` | No | `retencion_cabecera` cambia de estado y devuelve el cupo |
| `GET /bookings` | reservas | `flights:read` | No | `reserva_cabecera` |
| `POST /bookings` | reservas | `flights:book` | Sí | `reserva_cabecera` y sus detalles, `boleto_*` |
| `GET /bookings/{bookingId}` | reservas | `flights:read` | No | `reserva_*` |
| `GET /bookings/{bookingId}/tickets` y `/tickets/{ticketId}` | boletos | `flights:read` | No | `boleto_cabecera`, `boleto_detalle` |
| `GET /bookings/{bookingId}/baggage-options` | postventa | `flights:read` | No | `tarifa_*`, `familia_tarifa` |
| `POST /bookings/{bookingId}/baggage` | postventa | `flights:book` | Sí | `reserva_detalle_equipaje`, `reserva_detalle_pago` |
| `POST /bookings/{bookingId}/date-change/search` | postventa | `flights:read` | No | `cambio_*` |
| `POST /bookings/{bookingId}/date-change` | postventa | `flights:book` | Sí | `cambio_*`, `reserva_detalle_itinerario` |
| `GET /bookings/{bookingId}/cancellation-quote` | postventa | `flights:read` | No | `cotizacion_cancelacion` |
| `POST /bookings/{bookingId}/cancel` | postventa | `flights:cancel` | Sí | `reserva_cabecera`, `boleto_*`, `inventario_cabina` |
| `POST /bookings/{bookingId}/check-in` | checkin | `flights:book` | No | `checkin`, `pase_abordar` |
| `GET /bookings/{bookingId}/boarding-passes` | checkin | `flights:read` | No | `pase_abordar` |
| `GET /flights/{flightNumber}/status` | estado-vuelos | Público | No | `vuelo`, `vuelo_programado` |
| `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/{id}` | webhooks | `flights:webhooks` | No | `webhook_*`, `evento`, `evento_entrega` |

Fuera del contrato se agregan tres grupos de rutas:

| Rutas | Submódulo | Permiso | Para qué |
| --- | --- | --- | --- |
| `GET /health` | salud | Público | Chequeo de vida para Render; consulta la base |
| `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | auth | Público, salvo `logout` y `me` | Emitir los JWT mientras no exista el proveedor de identidad |
| `/admin/airports`, `/admin/airlines`, `/admin/flights`, `/admin/departures`, `/admin/fares` | catalogo | `flights:admin` | CRUD con eliminación lógica |

## Seguridad

La API niega por defecto: toda ruta exige un JWT válido salvo las que se marcan con `@Publico()`.

### Autenticación

- El módulo `auth` hace de proveedor de identidad mientras no exista el real.
- Contraseñas con argon2id; nunca se guardan ni se registran en texto plano.
- Token de acceso JWT de 15 minutos con `sub`, `scope`, `iss`, `aud` y `jti`. El `sub` es el `id_propietario` de retenciones, reservas y webhooks.
- Token de refresco opaco de 7 días, guardado como hash, con rotación: cada uso lo reemplaza y reusar uno viejo cierra la sesión.
- Login limitado a 5 intentos por minuto por IP y con el mismo mensaje de error para usuario inexistente y contraseña mala.
- Las tablas `usuario`, `rol`, `alcance`, `rol_alcance`, `usuario_rol` y `token_refresco` van en `db/esquema_seguridad.sql`, dentro del esquema `vuelos`. Ninguna tabla de vuelos apunta a ellas, así que en RDA2 se quitan sin tocar el resto.

### Autorización

Dos controles, en este orden: el permiso del token y la propiedad del recurso.

| Rol | Permisos (`scope`) | Cómo se obtiene |
| --- | --- | --- |
| cliente | `flights:read`, `flights:hold`, `flights:book`, `flights:cancel` | Registro público |
| integrador | Los de cliente más `flights:webhooks` | Lo asigna un administrador |
| administrador | Todos más `flights:admin` | Semilla de seguridad |

- `@Scopes('flights:book')` en cada ruta; si el token no lo trae, responde 403.
- Toda consulta de retenciones, reservas y webhooks filtra por `id_propietario = sub`. Un recurso ajeno responde 404, para no revelar que existe.
- `flights:admin` es un permiso propio; no está en el contrato.

### Validación y sanitización

- `ValidationPipe` global con `whitelist`, `forbidNonWhitelisted` y `transform`: un campo que no está en el DTO rechaza la petición.
- Los DTO copian las reglas del contrato: tipos, enums, longitudes, formatos de fecha, UUID y códigos IATA.
- Texto libre (nombres, documentos, URL de webhook): se recorta, se normaliza a NFC y se rechaza si trae caracteres de control o etiquetas HTML.
- Prisma parametriza todas las consultas. `$queryRaw` solo con plantillas etiquetadas, nunca concatenando texto.
- Cabeceras de seguridad con helmet, CORS con lista de orígenes permitidos, cuerpo máximo de 100 kB y límite de peticiones con respuesta 429 y `Retry-After`.
- Los secretos viven en variables de entorno validadas al arrancar; si falta una, la API no levanta.
- La URL de un webhook debe ser `https` y no puede apuntar a direcciones internas.

### Eliminación lógica

- Catálogos y suscripciones tienen columna `activo`: el `DELETE` de la API hace `UPDATE ... SET activo = false` y las lecturas filtran `activo = true`.
- Lo transaccional no se da de baja, cambia de estado: una retención se libera y una reserva se cancela.
- El cliente de Prisma lleva una extensión que lanza error si alguien llama `delete` o `deleteMany` sobre una tabla de negocio.
- Solo se borran físicamente datos temporales vencidos: ofertas, itinerarios y claves de idempotencia.

### Auditoría

Cada escritura corre dentro de una transacción que primero fija `app.id_usuario` y `app.direccion_ip`. Con eso los triggers de la base llenan la tabla `auditoria` sin código extra en los servicios.

## Fases

Las fases 0 a 3 son la base, la 4 fija el patrón de módulo y las 5 a 7 son el flujo de compra. La API se despliega desde la fase 1, no al final, para que los problemas de nube aparezcan temprano.

| Fase | Rama | Entrega | Hecha cuando |
| --- | --- | --- | --- |
| 0. Base del repo | `chore/f0-base` | Repo propio, lint, formato, reglas de commit, `db/` versionado, compose con PostgreSQL 18 | Un clon limpio levanta la base con `./db/reset.sh` y `npm run lint` pasa |
| 1. Núcleo | `feat/f1-nucleo` | Sin TypeORM, Prisma conectado, tabla de rutas, `/health`, Swagger, primer despliegue | `/flights/v1/health` responde 200 en Render y `/api/docs` abre |
| 2. Transversales | `feat/f2-transversales` | Errores `ProblemDetails`, validación, sanitización, helmet, CORS, límite de peticiones | Cualquier error, incluido un 404 de ruta, sale como `application/problem+json` |
| 3. Auth | `feat/f3-auth` | Registro, login, refresh, logout, guards de JWT y de permisos | Una ruta protegida responde 401 sin token y 403 sin el permiso |
| 4. Catálogo | `feat/f4-catalogo` | CRUD de aeropuertos, aerolíneas, vuelos, salidas y tarifas | Un `DELETE` deja la fila con `activo = false` y una fila en `auditoria` con el `sub` del administrador |
| 5. Búsqueda | `feat/f5-busqueda` | `POST /search` y mapa de asientos | UIO→GYE devuelve ofertas directas y UIO→GPS ofertas con escala, con precios iguales a los de la base |
| 6. Retenciones | `feat/f6-retenciones` | Hold con idempotencia y vencimiento | Dos peticiones simultáneas por el último cupo: una gana y la otra recibe 409 |
| 7. Reservas y boletos | `feat/f7-reservas` | `POST /bookings`, consultas, emisión de boletos | El flujo búsqueda → hold → reserva → boleto pasa de punta a punta en una prueba e2e |
| 8. Postventa | `feat/f8-postventa` | Equipaje, cambio de fecha, cancelación | Una oferta de cambio vencida responde 410 y una tarifa no cambiable responde 409 |
| 9. Check-in y estado | `feat/f9-checkin-estado` | Check-in, pases de abordar, estado de vuelo | El check-in fuera de ventana se rechaza y el pase sale con su código de barras |
| 10. Webhooks | `feat/f10-webhooks` | Suscripciones, eventos y entrega con reintentos | Una reserva confirmada llega firmada a una URL de prueba |
| 11. Entrega | `chore/f11-entrega` | Prueba de contrato, CI, guía de despliegue, versión 1.0.0 | El OpenAPI generado coincide con el contrato y la URL de Render pasa el flujo completo |

Si el tiempo aprieta antes de RDA1, lo primero que se recorta es la fase 10: se dejan alta, listado y baja de suscripciones y se pospone la entrega de eventos.

## Commits y reglas de Git

Cada fase es una rama, cada rama termina en un pull request a `main` y cada commit deja el proyecto compilando.

### Reglas

- Repositorio propio creado desde la plantilla, con la plantilla como remoto `upstream` para traer cambios del contrato.
- `main` protegida y siempre desplegable; Render despliega desde ahí.
- Mensajes en formato Conventional Commits y en español: `tipo(ámbito): verbo en infinitivo y qué cambia`. Tipos: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `style`, `perf`, `build`, `revert`. Un hook de husky con commitlint rechaza los que no cumplen.
- El pull request se une con merge commit, no con squash, para que el historial de commits quede visible.
- Una etiqueta por fase: `v0.1.0` al cerrar la fase 1 hasta `v1.0.0` en la entrega.
- `.env` nunca se sube. Una variable nueva entra a `.env.example` en el mismo commit que la usa.
- Un cambio de base va completo en un commit: el SQL de `db/`, el `schema.prisma` regenerado y el código que lo usa.

### Fase 0 · Base del repo

1. `chore: renombrar el proyecto a quinde-vuelos-api`
2. `chore: agregar eslint, prettier y editorconfig`
3. `style: aplicar prettier y quitar imports sin usar`
4. `fix(build): activar el módulo de vuelos y compilar solo ese dominio`
5. `chore: validar mensajes de commit con husky y commitlint`
6. `chore(db): versionar esquema, semilla y reset.sh`
7. `fix(docker): usar postgres 18 y montar el volumen en /var/lib/postgresql`
8. `docs: agregar README, logo y plan del backend`

Dos commits no estaban en el plan original. La plantilla no compila tal como viene (el módulo de atracciones tiene errores de TypeScript), así que el commit 4 activa solo `VuelosModule` y deja los módulos de los otros equipos fuera de la compilación. El commit 3 separa el cambio de formato del cambio de configuración.

### Fase 1 · Núcleo

1. `refactor: quitar TypeORM y las entidades de ejemplo`
2. `feat(config): validar las variables de entorno al arrancar`
3. `feat(prisma): introspección del esquema vuelos y PrismaService`
4. `feat(prisma): bloquear el delete físico y agregar la transacción auditada`
5. `feat(rutas): tabla de rutas con prefijo flights y versión v1`
6. `feat(salud): endpoint health con chequeo de base`
7. `docs(swagger): título, versión del contrato y esquema bearer`
8. `ci: Dockerfile y primer despliegue en Render con Neon`

### Fase 2 · Transversales

1. `feat(errores): filtro global ProblemDetails`
2. `feat(errores): traducir errores de Prisma y de triggers a códigos del contrato`
3. `feat(validacion): ValidationPipe global y pipes de uuid, fecha e IATA`
4. `feat(sanitizacion): transformadores de texto para los DTO`
5. `feat(seguridad): helmet, CORS por lista y límite de tamaño del cuerpo`
6. `feat(seguridad): límite de peticiones con Retry-After`
7. `feat(contexto): request-id y contexto de usuario e IP`

### Fase 3 · Auth

1. `feat(db): tablas de seguridad y semilla de roles`
2. `feat(auth): registro e inicio de sesión con argon2 y JWT`
3. `feat(auth): refresh con rotación y cierre de sesión`
4. `feat(auth): guard JWT global y decorador Publico`
5. `feat(auth): guard de permisos y decorador Scopes`
6. `feat(auth): decorador UsuarioActual y endpoint me`
7. `test(auth): e2e de login, token vencido y permiso faltante`

### Fase 4 · Catálogo

1. `feat(catalogo): repositorio base con eliminación lógica`
2. `feat(catalogo): CRUD de aeropuertos`
3. `feat(catalogo): CRUD de aerolíneas`
4. `feat(catalogo): CRUD de vuelos y salidas programadas`
5. `feat(catalogo): CRUD de tarifas`
6. `test(catalogo): e2e de alta, edición, baja lógica y auditoría`

### Fase 5 · Búsqueda

1. `feat(busqueda): DTO de búsqueda según el contrato`
2. `feat(busqueda): armar itinerarios directos y con escala`
3. `feat(busqueda): calcular precios por tipo de pasajero y crear ofertas`
4. `feat(busqueda): mapa de asientos por segmento`
5. `test(busqueda): e2e de ruta directa, con escala y sin vuelos`

### Fase 6 · Retenciones

1. `feat(idempotencia): interceptor sobre clave_idempotencia`
2. `feat(retenciones): crear hold descontando cupo en una transacción`
3. `feat(retenciones): consultar y liberar hold`
4. `feat(retenciones): vencer holds y devolver cupos`
5. `test(retenciones): e2e de concurrencia sobre el último cupo`

### Fase 7 · Reservas y boletos

1. `feat(reservas): crear reserva desde un hold con pasajeros y pago simulado`
2. `feat(reservas): asignar asientos y aplicar reglas de infantes`
3. `feat(reservas): listado paginado y detalle del dueño`
4. `feat(boletos): emitir y consultar boletos`
5. `test(reservas): e2e de búsqueda a boleto`

### Fase 8 · Postventa

1. `feat(postventa): opciones y compra de equipaje`
2. `feat(postventa): buscar y confirmar cambio de fecha`
3. `feat(postventa): cotizar y cancelar la reserva`
4. `test(postventa): e2e de oferta vencida y tarifa no cambiable`

### Fase 9 · Check-in y estado

1. `feat(checkin): check-in con ventana de tiempo`
2. `feat(checkin): pases de abordar`
3. `feat(estado): estado de vuelo por número y fecha`
4. `test(checkin): e2e de check-in y pase de abordar`

### Fase 10 · Webhooks

1. `feat(webhooks): alta, listado y baja lógica de suscripciones`
2. `feat(eventos): registrar eventos de negocio`
3. `feat(eventos): entrega firmada con reintentos`
4. `test(webhooks): e2e de suscripción y entrega`

### Fase 11 · Entrega

1. `test(contrato): comparar el OpenAPI generado con el contrato`
2. `ci: lint, build y pruebas en GitHub Actions`
3. `docs: guía de despliegue y colección de peticiones`
4. `chore(release): versión 1.0.0 para RDA1`

## Pendientes

Tres cosas las decides tú o el equipo; el resto se verifica en la fase que corresponde.

- [ ] Confirmar con el equipo o el docente que el módulo de vuelos puede usar Prisma en lugar del TypeORM de la plantilla.
- [ ] Definir dónde vive el código: repo propio o una rama `vuelos` dentro de la plantilla. El plan sirve para los dos casos.
- [ ] Fecha de entrega de RDA1, para repartir las fases en semanas.
- [ ] Fase 1: probar `prisma db pull` contra `?schema=vuelos`. No se pudo probar todavía. Hay que instalar `prisma@7`: sin versión, npm instala hoy una candidata de la 8 que no trae `db pull`.
- [ ] Fase 2: revisar cómo reporta Prisma el error de PostgreSQL 18 al violar un `ON DELETE RESTRICT` (código 23001 en lugar de 23503).
- [ ] Fase 1: el servicio gratuito de Render se duerme tras 15 minutos sin uso; la primera petición después tarda.
- [ ] Fase 7: la tabla `pais` solo tiene Ecuador, así que un pasajero con otra nacionalidad se rechaza hasta agregar su país.
- [ ] Fase 11: la semilla cubre 90 días desde el día en que se carga; hay que volver a sembrar antes de la entrega.
