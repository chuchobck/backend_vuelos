# Plan del backend — Quinde · API de Vuelos

Actualizado: 2026-10-05 (cierre de la fase 7) · Este archivo se actualiza al cerrar cada fase.

El backend se construye sobre la plantilla del equipo (NestJS 10 en TypeScript), con Prisma sobre la base PostgreSQL 18 que ya está cargada, en 12 fases que terminan con la API desplegada en Render para RDA1.

## Avance

| Fase | Estado | Verificado |
| --- | --- | --- |
| 0. Base del repo | Hecha (2026-10-05) | `npm ci`, `npm run lint`, `npm run format:check` y `npm run build` pasan en un clon limpio; el hook rechaza mensajes de commit inválidos; `db/reset.sh` carga esquema y semilla en PostgreSQL 18 |
| 1. Núcleo | Hecha en local (2026-10-05); falta el despliegue en Render | Cada commit pasa `npm ci`, `build`, `lint` y `format:check` por separado. Con el `.env` local: `GET /flights/v1/health` responde 200 y la base registra el `SELECT 1`; `/flights/v2/health` responde 404; `/api/docs` abre y `/api/docs-json` lista la ruta. Con la base caída, `/health` responde 503. La imagen de `docker build` arranca, responde lo mismo contra la base local y su HEALTHCHECK queda `healthy`. La extensión bloquea `delete` y `deleteMany` y la transacción auditada deja usuario e IP en `auditoria` (probado dentro de una transacción revertida) |
| 2. Transversales | Hecha (2026-10-05) | `lint`, `format:check`, `build` y `test:e2e` (137 pruebas contra la base real) pasan en cada commit. Con `curl` contra la API: ruta inexistente → 404 `application/problem+json`; `POST` sobre ruta existente que no lo admite → 405 con `Allow`; cuerpo inválido, campo no permitido, HTML en un texto y UUID mal formado → 400 `VALIDATION_FAILED` con `invalidParams`; errores de base provocados a propósito (unique, FK, `ON DELETE RESTRICT`) → 409/422 sin detalles internos, y la base queda igual (0 filas nuevas en `pais` y en `auditoria`); error no controlado → 500 sin detalle ni stack; 105 peticiones en un minuto → 429 con `Retry-After`; cuerpo de más de 100 kB → 413; cabeceras de helmet presentes; Swagger UI en `/api/docs` carga en un navegador headless sin errores de consola ni peticiones fallidas; `X-Request-Id` generado, respetado si es válido, reemplazado si no, y presente en los errores |
| 3. Auth | Hecha (2026-10-05) | `lint`, `format:check`, `build` y `test:e2e` (184 pruebas, 47 nuevas, contra la base real) pasan. `./db/reset.sh` carga los dos esquemas y las dos semillas; sin `SEED_ADMIN_PASSWORD` no crea el administrador y con una de menos de 12 caracteres falla. Con `curl` contra la API en el puerto 3010: register 201 (correo normalizado) y 409 si se repite; login 200 con `Cache-Control: no-store` y el mismo 401 para contraseña errónea, correo inexistente y cuenta inactiva; `GET /auth/me` 401 sin token (`WWW-Authenticate: Bearer realm=...`) y 200 con token; refresh rota el token; reusar uno rotado da 401 y revoca también el vigente; logout 204 y el refresh siguiente 401; token manipulado 401 `invalid_token`; el sexto login en un minuto 429 aunque la contraseña sea correcta; 403 con `insufficient_scope` y los scopes que faltan (con un controller de sonda, porque ningún endpoint real usa `@Scopes` todavía). Swagger: Authorize con `bearer` probado en un navegador headless (`/auth/me` pasa de 401 a 200). argon2 funciona dentro de la imagen Docker. Ninguna contraseña ni token completo aparece en los logs ni en las respuestas de error |
| 4. Catálogo | Hecha (2026-10-05) | `lint`, `format:check`, `build` y `test:e2e` (277 pruebas, 93 nuevas, contra la base real) pasan; la prueba del catálogo se repitió dos veces seguidas sin chocar con sus propios datos. Con la base recién cargada (`./db/reset.sh`) y la API en el puerto 3010, entrando como el administrador de desarrollo, `curl` recorre el ciclo completo de una aerolínea y de una salida programada: crear 201, leer 200, PATCH 200, DELETE 204 (la salida queda `CANCELLED`), la lista la oculta y con `includeInactive=true` la muestra, reactivate 200; la auditoría guarda cada cambio con el `sub` del administrador. Un cliente recién registrado recibe 403 (`Missing required scopes: flights:admin`) y sin token, 401: el 403 pendiente de la fase 3 queda verificado contra endpoints reales. Swagger lista las 10 etiquetas `Admin · …` aparte de las 7 del contrato, y en un navegador headless Authorize con `bearer` lleva `GET /admin/airlines` de 401 a 200. Ningún DELETE físico: el código del catálogo no los tiene (prueba de escaneo, que falla si se inyecta uno), la extensión los corta en sus 14 tablas y la auditoría no tiene ninguna `ELIMINACION` |
| 5. Búsqueda | Hecha (2026-10-05) | `lint`, `format:check`, `build` y `test:e2e` (313 pruebas, 36 nuevas, contra la base real) pasan. Con la base recién cargada y la API en el puerto 3010, sin token: `curl` de UIO-GYE solo ida (8 ofertas), ida y vuelta con 2 adultos y 1 niño (20, el tope), multidestino UIO-GPS-GYE-CUE con un infante (9, con escala por GYE en el primer tramo), una búsqueda sin resultados (200 con la lista vacía) y una inválida (400 por fecha pasada), y el mapa de asientos de una de las ofertas (200). Las seis respuestas cumplen `SearchResponse`, `SeatMapResponse` y `ProblemDetails` del contrato según Ajv 8.20 con ajv-formats 3, y ninguna trae un campo que el contrato no declare. Con las 4012 salidas de la semilla: una búsqueda de un tramo hace 11 sentencias SQL (2 lecturas, la transacción de guardado y 2 DELETE de purga) y tarda una mediana de 35 ms; ida y vuelta, 51 ms. El mapa de asientos hace 6 lecturas. Repetir la misma búsqueda no acumula ofertas sin límite: cada búsqueda igual suma sus 8 ofertas (de 187 a 227 tras 5 repeticiones), y con todas vencidas la siguiente búsqueda las purga junto con sus itinerarios huérfanos y deja solo sus 8 ofertas nuevas: lo vivo queda acotado a las ofertas de los últimos 30 minutos |
| 6. Retenciones | Hecha (2026-10-05) | `lint`, `format:check`, `build` y `test:e2e` (355 pruebas, 42 nuevas, contra la base real) pasan tres corridas seguidas. Con la base recién cargada y la API en el puerto 3010: un cliente recién registrado busca UIO-GYE (8 ofertas), retiene la primera (201, `lockedPrice` 73,92 igual al de la búsqueda, el cupo baja de 126 a 125), la consulta (HELD, 899 s), repite el POST con la misma clave (201 con la misma respuesta, `Idempotent-Replayed: true`, un solo hold en la base), la libera (204), la consulta (RELEASED, el cupo vuelve a 126, `fecha_cierre` puesta) y otro usuario recibe 404 en GET y DELETE. Las respuestas cumplen `HoldResponse`, `HoldStatusResponse` y `ProblemDetails` (400, 401, 404, 409, 422) según Ajv. Concurrencia contra la API real: una salida de la semilla con 5 cupos en económica, 20 holds simultáneos con claves distintas → 5 × 201 y 15 × 409 `OFFER_NO_LONGER_AVAILABLE` en 188 ms; en 194 muestras de la base tomadas durante la ráfaga el cupo nunca bajó de 0 y retenido + disponible fue siempre el total; liberar las 5 a la vez devolvió exactamente 5. El proceso periódico, con `HOLD_TTL_MINUTES=1` e intervalo de 5 s, venció un hold real y devolvió su cupo, con la auditoría sin usuario. Todo `UPDATE` de `inventario_cabina` corre dentro de `transaccionAuditada`; el borrado físico sigue solo en ofertas, itinerarios y claves de idempotencia, y la auditoría no tiene ninguna `ELIMINACION`. El log no tiene tokens, contraseñas ni claves de idempotencia |
| 7. Reservas y boletos | Hecha (2026-10-05) | `lint`, `format:check` y `build` pasan; `test:e2e` (425 pruebas, 70 nuevas, contra la base real) pasó en la primera y la segunda de tres corridas seguidas y en la tercera tuvo una prueba fallida que no quedó registrada; en las 15 corridas completas siguientes no volvió a fallar (ver Hallazgos). Con la base recién cargada y la API en el puerto 3010 (`HOLD_TTL_MINUTES=1`, emisión cada 5 s), como un cliente recién registrado: busca UIO-GYE, retiene (73,92), reserva con pago aprobado (201 `CONFIRMED`, `grandTotal` igual al `lockedPrice`, boleto `045…` emitido, asiento 10A), consulta detalle, listado, tickets y un ticket; repite el POST con la misma clave (la misma reserva, `Idempotent-Replayed: true`, una sola reserva para el hold); pago pendiente (202 `PENDING_PAYMENT`, el proceso la confirma y emite el boleto en la corrida siguiente); pago rechazado (422 `PAYMENT_NOT_AUTHORIZED`, el hold sigue `RETENIDA` y sin reserva); hold vencido (410); otro usuario recibe 404 en detalle y tickets y 422 con el hold ajeno. Las respuestas de las cinco operaciones cumplen `BookingDetail`, `BookingListResponse`, `TicketListResponse`, `Ticket` y `ProblemDetails` (400, 404, 409, 410, 422) según Ajv. Concurrencia contra la API real: 10 POST simultáneos sobre el mismo hold con claves distintas → 1 × 201 y 9 × 409 (una reserva en la base); 5 reservas simultáneas por el mismo asiento → 1 × 201 y 4 × 409 `SEAT_TAKEN` (un pasajero en ese asiento, los otros holds siguen `RETENIDA`); en la salida, disponibles + retenidos = total y asientos asignados = holds consumidos; en toda la base, ningún hold con dos reservas ni asiento con dos pasajeros. Las escrituras de reserva y boleto van todas dentro de `transaccionAuditada` (la auditoría no tiene ninguna `ELIMINACION`); el borrado físico sigue solo en ofertas, itinerarios y claves vencidas. El log de la API (522 líneas) no tiene documentos, correos, teléfonos, nombres, referencias de pago, claves de idempotencia ni tokens |
| 8 a 11 | Pendientes | |

## Decisiones

La plantilla manda en lenguaje y framework; lo único que se reemplaza es el ORM.

| Tema | Decisión | Por qué |
| --- | --- | --- |
| Lenguaje | TypeScript | La plantilla ya está en TypeScript. Nest usa decoradores y tipos para validar los DTO y generar Swagger; en JavaScript habría que reescribirla y agregar Babel. Esto cambia lo que habíamos dicho antes (JavaScript). |
| Framework | NestJS 10, el de la plantilla | Es Nest, no Next: Next.js es para frontend con React. Se queda en la versión 10 para no separarse de los otros equipos. |
| ORM | Prisma 7.10 (versión fija) en lugar de TypeORM | La plantilla trae TypeORM con `synchronize: true`, que crea y altera tablas a partir de las entidades. Nuestra base nace del SQL y tiene triggers y ENUM; Prisma solo la lee con `db pull`. Prisma 7 exige un adaptador: se usa `@prisma/adapter-pg`. |
| Cliente de Prisma | Generado en `src/generated`, fuera de git | Lo crea `prisma generate` en el `postinstall`; así no se versiona código generado ni se desfasa del `schema.prisma`. |
| Fuente de verdad de la base | Los archivos de `db/` | Un cambio se hace en el SQL y después se corre `prisma db pull`. No se usa `prisma migrate`. |
| Rutas | Una sola tabla en `src/routes/index.routes.ts` | Usa el `RouterModule` de Nest: cada módulo declara su ruta en un `*.routes.ts` y el índice las junta. Los controladores no llevan prefijos. |
| Versionado | En la URL: `/flights/v1/...` | Es la misma base que el `servers` del contrato. Prefijo global `flights` más versionado de Nest con versión 1 por defecto; una v2 se agrega por controlador con `@Version('2')`. |
| Capas de cada módulo | routes → controller → service → repository, más mapper y dto | Un módulo por entidad. El controller solo maneja HTTP, el service tiene las reglas, el repository es el único que usa Prisma y el mapper traduce la fila en español al JSON del contrato. |
| Idioma | Rutas y JSON en inglés; código, carpetas y base en español | El contrato fija el inglés hacia afuera. Un mapper por módulo traduce entre los dos. |
| Errores | Filtro global que responde `application/problem+json` | El contrato exige `ProblemDetails` con un `code` de lista cerrada. |
| Documentación viva | Swagger generado del código en `/api/docs` | Una prueba compara el OpenAPI generado con `contracts/vuelos-openapi.yaml`, para que no se separen. |
| Autenticación | Módulo `auth` propio que emite JWT | El contrato deja la identidad en otro servicio, pero en RDA1 la API tiene que funcionar sola. En RDA2 se cambia por el proveedor real. |
| Scopes por rol | Constante en `src/modules/auth/scopes.ts`; la base solo guarda qué rol tiene cada usuario | Un scope solo protege algo si un `@Scopes` del código lo exige: cambiar la tabla implica desplegar igual. Son 2 roles y 6 scopes; tablas `alcance` y `rol_alcance` sumarían joins sin flexibilidad real. |
| Respuesta de tokens | Nombres de OAuth 2.0 (`access_token`, `token_type`, `expires_in`, `refresh_token`, `scope`), en snake_case | El contrato delega la identidad en un servidor OAuth2; un cliente de OAuth2 espera esos campos. Es la única excepción al camelCase del contrato. |
| JWT | HS256 con `jsonwebtoken`, sin `@nestjs/jwt` | Se fija a mano el único algoritmo aceptado, `iss`, `aud` y que `exp` exista; `@nestjs/jwt` no agrega nada que haga falta. |
| Eliminación | Lógica: `activo = false` o cambio de estado | Ningún endpoint ejecuta un `DELETE` de SQL sobre datos de negocio. |
| CRUD de catálogo | Rutas `/flights/v1/admin/...`, fuera del contrato, con una clase base compartida | El contrato no tiene mantenimiento de aeropuertos, vuelos ni tarifas, y el curso pide CRUD. Las 10 entidades repiten listar, ver, crear, editar y dar de baja lógica. |
| Swagger | `/api/docs`, versión 1.5.0.0, esquema bearer, 7 etiquetas del contrato más las propias | Las etiquetas viven en `src/config/swagger.ts` (`ETIQUETAS`) para que cada controller use la misma. |
| Identificador del catálogo en la URL | El código natural (ISO alfa-2, IATA, número de vuelo) o un uuid; nunca el `bigint` | CLAUDE.md prohíbe que el `bigint` salga. `ciudad`, `familia_tarifa`, `mapa_asientos_cabecera` y `tarifa_cabecera` no tienen clave natural simple: se les agregó `id_publico uuid` en `esquema_vuelos.sql` (decidido con el dueño del repo en la fase 4). |
| Baja de una salida programada | `DELETE /admin/departures/:id` la deja en estado `CANCELADO`; `reactivate` la vuelve a `PROGRAMADO` | `vuelo_programado` no tiene columna `activo`, y una segunda bandera podría contradecir al estado. Decidido con el dueño del repo. |
| Nombres de las rutas admin | En inglés: `/reactivate`, `?includeInactive=true` | CLAUDE.md fija rutas y JSON en inglés; el pedido de la fase 4 los nombraba en español. Decidido con el dueño del repo. |
| Cursor de las listas admin | La clave pública de la última fila en base64url; respuesta `{ nextCursor, items }` como `GET /bookings` del contrato | El contrato no define el formato del cursor. Así es opaco y no contiene el `bigint`; el orden es el id interno (o salida y uuid en las salidas). |
| Detalle del catálogo | Asientos, cupos y precios por pasajero se crean con su cabecera y no se quitan | Quitarlos sería un borrado físico. La distribución de un mapa no cambia (las reservas apuntan a sus asientos): se crea otro mapa. Un cupo se baja a 0, no se borra. |
| Ofertas de la búsqueda | Una oferta es de una sola aerolínea y trae un itinerario por tramo pedido; cada itinerario lleva sus `pricingOptions` (las familias con cupo en todos sus segmentos). `grandTotal` es el de la familia más barata de cada itinerario, para todos los pasajeros | `oferta_cabecera` guarda una aerolínea por oferta y `oferta_detalle` un itinerario por tramo. El contrato pone las familias en el itinerario y el total en la oferta: el total "desde" es el único que no depende de una elección que todavía no se hizo |
| Itinerarios | Directos o con una escala de la misma aerolínea comercializadora, con conexión de 45 minutos a 6 horas; entre tramos, al menos 45 minutos | La semilla no tiene UIO-GPS directo (el PLAN pide UIO→GPS con escala). Sin código compartido entre aerolíneas: `oferta_cabecera` admite una sola |
| Orden y tope de la búsqueda | Precio total, luego hora de salida de cada segmento y el id de la salida; a lo sumo 10 itinerarios por tramo y aerolínea y 20 ofertas | Determinista (la misma búsqueda da el mismo orden) y acotado aunque un multidestino tenga 6 tramos |
| Vigencia de una oferta | 30 minutos, configurable con `SEARCH_OFFER_TTL_MINUTES` (de 5 a 240) | Alcanza para mirar el mapa y retener (el hold dura 15 minutos más), y deja pocas filas vivas |
| Limpieza de ofertas vencidas | Cada búsqueda, después de guardar, borra las ofertas vencidas sin retención y los itinerarios que ya nadie referencia | Son las únicas tablas con borrado físico permitido (`TABLAS_CON_BORRADO_FISICO`); así la basura queda acotada a las ofertas de los últimos 30 minutos sin esperar una tarea programada |
| Límites de las operaciones públicas | `/search`: 20 por minuto e IP; `/seatmap`: 60 por minuto e IP; aparte del global de 100 | La búsqueda hace varias consultas y guarda ofertas; el mapa es una lectura liviana pero pública |
| `X-Device-Fingerprint` | De 8 a 128 letras, dígitos o `. _ : + / = -`; se guarda en `oferta_cabecera.huella_dispositivo` y no se registra | El esquema ya tiene la columna. El valor identifica un dispositivo: no va en el log ni en los errores |
| Errores del hold | Oferta inexistente o vencida, tarifa o salida que ya no se vende, monedas distintas o falta de cupo: 409 `OFFER_NO_LONGER_AVAILABLE`. Itinerario ajeno a la oferta, oferta sin cubrir entera o familia que la aerolínea no tiene: 422. Cuerpo inválido, itinerario repetido, ids o clave que no son uuid: 400 | El contrato del POST solo declara 400, 409 y 422 (no 404). Las ofertas vencidas se purgan, así que "no existe" y "venció" son indistinguibles: los dos son "ya no está disponible", el único código del contrato para eso. 422 queda para lo que no corresponde a la oferta |
| Precio del hold | Se lee de nuevo de la tarifa al retener y se congela en `retencion_detalle` (base e impuestos por itinerario, para todos los pasajeros); vale aunque la tarifa cambie después | La oferta no guarda precios (ver Hallazgos de la fase 5): no hay con qué comparar el precio de la búsqueda, y el contrato no tiene un código de "cambió el precio". La cuenta es la misma de la búsqueda |
| Cupo del hold | Una sola sentencia por hold: bloquea las filas de `inventario_cabina` en orden (salida, cabina) y resta solo donde alcanza; si cambió menos filas de las pedidas, la transacción entera se deshace. Devolver recalcula desde la base con el mismo orden | Sin sobreventa (lo prueba la concurrencia) y sin deadlocks entre holds; el catálogo ajusta cabinas en el mismo orden (`ORDEN_CABINAS`). Bloqueos de milisegundos: nada se lee y después se escribe |
| Vigencia del hold | 15 minutos, configurable con `HOLD_TTL_MINUTES` (de 1 a 60) | Alcanza para pagar y reservar; más de una hora inmovilizaría cupo. La oferta dura 30: un hold puede durar más que su oferta |
| Idempotencia del hold | En el service, no en un interceptor: la clave se reclama con `INSERT ... ON CONFLICT DO NOTHING` en la misma transacción que crea el hold, ya con la respuesta. Por usuario y por 24 horas; huella SHA-256 del cuerpo con los valores por defecto puestos. Misma clave y mismo cuerpo: 201 con la respuesta guardada y `Idempotent-Replayed: true`; otro cuerpo: 422 | Dos peticiones simultáneas con la misma clave no crean dos holds (la segunda espera a la primera). Un 409 se deshace con la clave, así que se puede reintentar. 201 y no 200 porque el contrato solo declara 201; 422 y no 409 porque la petición es válida pero no procesable con esa clave |
| Vencimiento del hold | Perezoso al consultarlo (GET, DELETE) y antes de competir por el cupo de sus salidas (POST); y un proceso con `setInterval` cada `HOLD_EXPIRY_JOB_INTERVAL_SECONDS` (60) que también borra las claves vencidas, apagable con `HOLD_EXPIRY_JOB_ENABLED=false`. Vencer se audita sin usuario | Sin `@nestjs/schedule`: un intervalo alcanza. Una corrida a la vez por proceso; entre instancias, `FOR UPDATE SKIP LOCKED` y el `UPDATE ... WHERE estado = 'RETENIDA'` impiden devolver un cupo dos veces. El COMMENT de `auditoria.id_usuario` pide NULL para los procesos internos |
| Propiedad del hold | El dueño es el `sub`; el hold de otro usuario responde 404 (no 403). `flights:admin` puede consultar cualquiera, pero solo el dueño lo libera | No revelar que un id existe. Liberar el hold de un cliente no es una tarea del administrador |
| DELETE del hold | Liberado o vencido: 204 sin cambiar nada. Consumido por una reserva: 409 | DELETE idempotente. El contrato solo declara 204 y 404; un 204 para un consumido diría que se liberó un cupo que es de la reserva |
| Límite de POST /offers/hold | 30 por minuto e IP, aparte del global | Cada hold toma cupo real: frena a quien quiera vaciar un vuelo, y alcanza para reintentos y varios clientes detrás de una misma IP |
| Hora de la aplicación | `Reloj` inyectable (`src/common/reloj.ts`); los vencimientos se comparan con su hora, nunca con `now()` de la base | Las pruebas lo reemplazan por uno quieto que se adelanta a mano: sin esperas reales y sin depender del reloj de WSL, que salta |
| Pagos y GDS | Simulados | El pago llega como `paymentReference` y lo juzga `ServicioPagos` (hoy `PagosSimulados`); la emisión de boletos es local. |
| Pago simulado | `PAY-OK-<código>` aprobado, `PAY-PEND-<código>` pendiente (aprobado en la consulta siguiente), `PAY-REJ-<código>` rechazado; cualquier otra referencia es inválida. `<código>`: 4 a 50 mayúsculas o dígitos | Determinista y sin estado: la misma referencia da siempre lo mismo, y el frontend puede provocar cada caso. La interfaz (`autorizar` al crear, `consultar` después) es la que tendrá el cliente de la Payment API real |
| Resultados del pago | Aprobado: 201 con los boletos emitidos. Pendiente: 202 en `PENDING_PAYMENT`. Rechazado: 422 `PAYMENT_NOT_AUTHORIZED`; inválido: 422 `PAYMENT_REFERENCE_INVALID`; ya usado en otra operación: 409 `PAYMENT_REFERENCE_INVALID` | El pago se juzga antes de abrir la transacción: un rechazo no deja reserva ni consume el hold. La referencia es única en la base (`uq_reserva_detalle_pago_referencia`) |
| Errores del hold en POST /bookings | Inexistente o de otro usuario: 422 (`holdId: the hold was not found`, el mismo texto). Vencido o liberado: 410. Ya consumido: 409. Los dos con `OFFER_NO_LONGER_AVAILABLE` | POST /bookings no declara 404; el `holdId` es un dato del cuerpo que no se puede procesar. El mismo mensaje no revela si el hold existe |
| Tipo de pasajero por edad | Cumplida el día de la primera salida: INFANT menos de 2, CHILD 2 a 11, YOUTH 12 a 17, ADULT 18 o más; un INFANT además menos de 2 en la última salida | El contrato no fija edades; son las de IATA con YOUTH como franja propia, sin solaparse. El tipo decide el precio del hold |
| Documento | Se quitan espacios y guiones y se pasa a mayúsculas; cédula ecuatoriana (NATIONAL_ID con nacionalidad EC) con su dígito verificador (módulo 10); pasaporte con vencimiento posterior a la última salida | El esquema pide el dígito verificador en la aplicación (COMMENT de `numero_documento`) y el vencimiento con pasaporte (`ck_reserva_detalle_pasajero_pasaporte`) |
| Asignación de asientos | El elegido (`assignedSeats`): de la aeronave (422), de la cabina del hold (422 `SEAT_CABIN_MISMATCH`) y libre (409 `SEAT_TAKEN`). Sin elegir: el primero libre de la cabina por fila y letra, en el orden de los pasajeros del cuerpo. Los infantes no ocupan asiento (422 `INFANT_SEAT_NOT_ALLOWED`) | Determinista. Las reservas de la misma cabina se serializan bloqueando su fila de `inventario_cabina` (el orden de los holds), así dos reservas no eligen el mismo asiento libre; el índice único `uq_reserva_detalle_asiento_ocupado` queda de respaldo |
| PNR | 6 caracteres de `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (sin 0, O, 1, I ni L), al azar con `crypto`; se reclama con `INSERT ... ON CONFLICT DO NOTHING` y se prueba otro si existía (hasta 5) | 887 millones de PNR; dictarlo por teléfono no confunde letras con dígitos. Cumple `ck_reserva_cabecera_pnr` |
| Número de boleto | `prefijo_boleto` de la aerolínea de la oferta (3 dígitos) + 10 dígitos al azar; se asigna con un UPDATE que solo lo toma si nadie lo tiene (hasta 5 intentos). Sin prefijo, la aerolínea no emite: 422 `TICKET_ISSUANCE_FAILED` al reservar, o la reserva `FALLIDA` si lo pierde antes de emitir | Es el formato IATA (código numérico de la aerolínea y serie); cumple `ck_boleto_cabecera_numero`. Un boleto por pasajero, también los infantes, con un cupón por vuelo numerado en orden de viaje |
| Estados de la reserva | `PENDIENTE` → `CONFIRMADA` pasando por `EMITIENDO_BOLETOS` (201) o por `PENDIENTE_PAGO` (202); `FALLIDA` si el pago se rechaza después o la emisión falla: boletos `FALLIDO` con el motivo, asientos liberados y cupo devuelto | Las transiciones son UPDATE condicionados al estado anterior y cada una deja una línea en `reserva_detalle_historial` (el `changes` del contrato) |
| Idempotencia de POST /bookings | Por usuario y 24 horas, en la misma transacción que la reserva. Se guarda solo `{ bookingId }` y el status: un reintento devuelve la reserva como está hoy con el status original (201 o 202) y `Idempotent-Replayed: true`. Otro cuerpo: 422 | El COMMENT de `clave_idempotencia.respuesta` pide el cuerpo original, pero ese cuerpo tiene documentos, correos y teléfonos: no se duplican datos personales en otra tabla por 24 horas |
| Emisión asíncrona | `EmisionPendiente` cada `BOOKING_ISSUE_JOB_INTERVAL_SECONDS` (30), apagable con `BOOKING_ISSUE_JOB_ENABLED=false`; una transacción por reserva con `FOR UPDATE SKIP LOCKED`, auditada sin usuario | Igual que el vencimiento de holds: sin dependencias nuevas, una corrida a la vez por proceso y segura con varias instancias |
| Eventos de la reserva | `EventosReserva.registrar(tx, reservaId, evento)` en la transacción del cambio; hoy solo escribe el historial | Punto único para que la fase 10 agregue la bandeja de webhooks (tabla `evento`) sin rehacer la reserva |
| Equipaje al reservar | `extraBaggage` en POST /bookings debe ir vacío (422) | El hold no congela el precio de la maleta; se compra después con `POST /bookings/{bookingId}/baggage` (fase 8), con su propio pago |
| Límite de POST /bookings | 10 por minuto e IP, aparte del global | Cada reserva consume un hold y bloquea el inventario de sus cabinas mientras elige asientos |
| Propiedad de la reserva | El dueño es el de su hold (`retencion_cabecera.id_propietario`): una reserva ajena es 404 para todos, también para un administrador | El pedido de la fase 7: solo el dueño. `reserva_cabecera` no tiene columna de dueño (3FN) |

### Ajuste de estructura

Lo que cambió del plan original y es la regla desde la fase 1:

- **Un módulo por entidad**, cada uno con su `<entidad>.controller.ts` y su `<entidad>.routes.ts`, más module, service, repository (el único que usa Prisma), mapper y `dto/`.
- **Dos grupos** dentro de `src/modules/vuelos`: `catalogo/` (CRUD de administrador en `/admin/...`, sobre la base común de `catalogo/base/`) y `operaciones/` (los endpoints del contrato). `compartido/` tiene lo de los dos: ENUM del contrato, formatos de salida, fechas, errores y `MoneyAmount`. Fuera de vuelos quedan `salud` y `auth`.
- **Las tablas de detalle no tienen controller**: asientos, cupos por cabina, precios por pasajero, itinerarios y segmentos de una oferta los maneja el service de su cabecera.
- **Rutas anidadas con `RouterModule`**: cada `<entidad>.routes.ts` exporta su arreglo, `catalogo.routes.ts` los cuelga bajo `admin`, `operaciones.routes.ts` los deja en la raíz (por ejemplo `search` y `offers`), `vuelos.routes.ts` junta los dos grupos y `src/routes/index.routes.ts` es la única tabla de la API. Los controllers no llevan prefijo y todo queda en `/flights/v1`.

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

Todo lo de vuelos queda dentro de `src/modules/vuelos`, como pide la plantilla, con **un módulo por entidad**: `catalogo/` para el CRUD de administrador y `operaciones/` para los endpoints del contrato. Fuera de vuelos quedan `salud` y `auth`. Lo transversal va en `common`, `config`, `prisma` y `routes`. Lo marcado con ✓ ya existe al cerrar la fase 1.

```text
quinde-vuelos-api/
├── contracts/                    # vuelos-openapi.yaml, el contrato que se implementa
├── db/                           # fuente de verdad de la base
│   ├── esquema_vuelos.sql
│   ├── esquema_seguridad.sql     # ✓ usuarios, roles y tokens de refresco
│   ├── semilla_vuelos.sql
│   ├── semilla_seguridad.sql     # ✓ roles y administrador local (SEED_ADMIN_PASSWORD)
│   ├── hash-contrasena.js        # ✓ hash argon2id del administrador para la semilla
│   ├── prueba_esquema.sql
│   └── reset.sh
├── docs/                         # PLAN.md, logo.svg, logo-icono.svg (ícono de Swagger)
├── prisma/
│   └── schema.prisma             # ✓ lo escribe db pull, no se edita a mano
├── prisma.config.ts              # ✓ datasource del CLI (lee .env con dotenv)
├── src/
│   ├── main.ts                   # ✓ arranque: crea la app y llama a configurarApp
│   ├── configurar-app.ts         # ✓ prefijo flights, versión v1, middlewares, pipes, Swagger (lo usan main y los e2e)
│   ├── app.module.ts             # ✓
│   ├── config/
│   │   ├── entorno.ts            # ✓ variables validadas al arrancar (obligatorias y opcionales)
│   │   ├── seguridad.ts          # ✓ helmet, CORS y tope del cuerpo
│   │   ├── limite-peticiones.ts  # ✓ opciones de @nestjs/throttler
│   │   ├── origenes-cors.ts      # ✓ lectura y validación de CORS_ORIGINS
│   │   ├── proxy.ts              # ✓ lectura y validación de TRUST_PROXY
│   │   └── swagger.ts            # ✓ título, versión, bearer, ETIQUETAS, ícono
│   ├── routes/
│   │   └── index.routes.ts       # ✓ la única tabla de rutas de la API
│   ├── generated/prisma/         # ✓ cliente generado (fuera de git)
│   ├── prisma/
│   │   ├── prisma.module.ts      # ✓ global
│   │   ├── prisma.service.ts     # ✓ db (cliente extendido) y transaccionAuditada
│   │   ├── serializacion-bigint.ts  # ✓ BigInt → texto en JSON
│   │   └── extensiones/          # ✓ bloqueo de delete físico, actor de auditoría
│   ├── common/
│   │   ├── reloj.ts              # ✓ hora de la aplicación, inyectable (fase 6)
│   │   ├── decorators/           # ✓ @Publico, @Scopes, @UsuarioActual, @LimiteEstricto, @SinLimiteDePeticiones, @HuellaDispositivo, @ClaveIdempotencia
│   │   ├── dto/                  # de la plantilla: respuesta base y paginación
│   │   ├── guards/               # ✓ limite-peticiones, jwt-auth y scopes (globales)
│   │   ├── contexto/             # ✓ request id, IP y usuario de la petición en curso (AsyncLocalStorage)
│   │   ├── errores/              # ✓ códigos del contrato, ErrorNegocio, traducción de errores de Prisma y de triggers
│   │   ├── filters/              # ✓ problem-details.filter.ts
│   │   ├── logger/               # ✓ logger de Nest con el request id en cada línea
│   │   ├── pipes/                # ✓ ValidationPipe global, uuid, fecha, código IATA
│   │   └── sanitizacion/         # ✓ @TextoLimpio, @CorreoNormalizado y piezas sueltas (ver su README)
│   └── modules/
│       ├── salud/                # ✓ GET /health
│       ├── auth/                 # ✓ registro, login, refresh, logout, me; scopes.ts y seguridad/
│       └── vuelos/
│           ├── vuelos.module.ts  # ✓ junta los submódulos
│           ├── vuelos.routes.ts  # ✓ cuelga las rutas de catálogo y operaciones
│           ├── compartido/       # ✓ enums.ts, formatos-salida.ts, fechas.ts, errores.ts, pasajeros.ts, idempotencia.repository.ts, generador-codigos.ts, pagos/ (ServicioPagos), dto/
│           ├── catalogo/         # ✓ CRUD de administrador en /admin/... (fase 4)
│           │   ├── base/         # ✓ RepositorioCatalogo, ServicioCatalogo, paginación, errores, Swagger
│           │   ├── pais/
│           │   ├── ciudad/
│           │   ├── aeropuerto/
│           │   ├── aerolinea/
│           │   ├── modelo-aeronave/
│           │   ├── familia-tarifa/
│           │   ├── mapa-asientos/
│           │   ├── vuelo/
│           │   ├── vuelo-programado/
│           │   └── tarifa/
│           └── operaciones/      # ✓ endpoints del contrato (operaciones.module.ts y .routes.ts)
│               ├── busqueda/     # ✓ POST /search (fase 5)
│               ├── oferta/       # ✓ GET /offers/{offerId}/seatmap (fase 5)
│               ├── retencion/    # ✓ /offers/hold y el vencimiento periódico (fase 6)
│               ├── reserva/      # ✓ /bookings y la emisión periódica (fase 7)
│               ├── boleto/       # ✓ /bookings/{bookingId}/tickets (fase 7)
│               ├── equipaje/
│               ├── cambio-fecha/
│               ├── cancelacion/
│               ├── checkin/
│               ├── pase-abordar/
│               ├── estado-vuelo/
│               └── webhook/
├── test/                         # ✓ pruebas e2e (Jest + supertest) contra la base real; utils/ con crearApp y fixtures
├── Dockerfile                    # ✓ multi-etapa para Render
├── docker-compose.yml            # ✓ PostgreSQL 18; puerto con DB_PORT
└── .env.example                  # ✓
```

Cada entidad repite la misma forma. Ejemplo con aeropuerto:

```text
catalogo/aeropuerto/
├── aeropuerto.module.ts
├── aeropuerto.routes.ts      # [{ path: 'airports', module: AeropuertoModule }]
├── aeropuerto.controller.ts  # @Controller() sin prefijo: solo HTTP
├── aeropuerto.service.ts     # reglas de negocio y transacciones
├── aeropuerto.repository.ts  # único archivo que usa Prisma
├── aeropuerto.mapper.ts      # fila en español → JSON del contrato en inglés
└── dto/                      # entrada y salida, con validación y Swagger
```

Las rutas se anidan con `RouterModule`: cada `*.routes.ts` exporta su arreglo, `vuelos.routes.ts` los cuelga (el catálogo bajo `admin`, las operaciones anidadas, por ejemplo `bookings/:bookingId/tickets` dentro de `bookings`) y el índice junta todo:

```ts
// src/routes/index.routes.ts
export const rutas: Routes = [
  ...saludRoutes, // health
  ...authRoutes, // auth
  ...vuelosRoutes, // admin/..., search, offers, bookings, flights, webhooks
];
```

El prefijo `flights` y la versión `1` no van en la tabla: los ponen `setGlobalPrefix` y `enableVersioning` en `main.ts`, así que toda ruta queda en `/flights/v1/<path>`.

## Mapa del contrato

Los 22 endpoints del contrato se reparten en 12 entidades de `operaciones/`. Todas las rutas cuelgan de `/flights/v1`.

| Endpoint | Entidad | Permiso | Idempotency-Key | Tablas principales |
| --- | --- | --- | --- | --- |
| `POST /search` (hecho en la fase 5) | busqueda | Público, exige `X-Device-Fingerprint`; 20 por minuto e IP | No | `vuelo_programado`, `inventario_cabina`, `tarifa_*`, `itinerario_*`, `oferta_*` |
| `GET /offers/{offerId}/seatmap` (hecho en la fase 5) | oferta | Público; 60 por minuto e IP | No | `mapa_asientos_*`, `asiento`, `reserva_detalle_asiento` |
| `POST /offers/hold` (hecho en la fase 6) | retencion | `flights:hold`; 30 por minuto e IP | Sí | `retencion_*`, `inventario_cabina`, `clave_idempotencia` |
| `GET /offers/hold/{holdId}` (hecho en la fase 6) | retencion | `flights:read` | No | `retencion_*`, `vista_retencion_precio` |
| `DELETE /offers/hold/{holdId}` (hecho en la fase 6) | retencion | `flights:hold` | No | `retencion_cabecera` cambia de estado y devuelve el cupo |
| `GET /bookings` (hecho en la fase 7) | reserva | `flights:read` | No | `reserva_cabecera`, `vista_reserva_total` |
| `POST /bookings` (hecho en la fase 7) | reserva | `flights:book`; 10 por minuto e IP | Sí | `reserva_cabecera` y sus detalles, `boleto_*`, `retencion_cabecera`, `clave_idempotencia` |
| `GET /bookings/{bookingId}` (hecho en la fase 7) | reserva | `flights:read` | No | `reserva_*`, `boleto_*` |
| `GET /bookings/{bookingId}/tickets` y `/tickets/{ticketId}` (hechos en la fase 7) | boleto | `flights:read` | No | `boleto_cabecera`, `boleto_detalle` |
| `GET /bookings/{bookingId}/baggage-options` | equipaje | `flights:read` | No | `tarifa_*`, `familia_tarifa` |
| `POST /bookings/{bookingId}/baggage` | equipaje | `flights:book` | Sí | `reserva_detalle_equipaje`, `reserva_detalle_pago` |
| `POST /bookings/{bookingId}/date-change/search` | cambio-fecha | `flights:read` | No | `cambio_*` |
| `POST /bookings/{bookingId}/date-change` | cambio-fecha | `flights:book` | Sí | `cambio_*`, `reserva_detalle_itinerario` |
| `GET /bookings/{bookingId}/cancellation-quote` | cancelacion | `flights:read` | No | `cotizacion_cancelacion` |
| `POST /bookings/{bookingId}/cancel` | cancelacion | `flights:cancel` | Sí | `reserva_cabecera`, `boleto_*`, `inventario_cabina` |
| `POST /bookings/{bookingId}/check-in` | checkin | `flights:book` | No | `checkin`, `pase_abordar` |
| `GET /bookings/{bookingId}/boarding-passes` | pase-abordar | `flights:read` | No | `pase_abordar` |
| `GET /flights/{flightNumber}/status` | estado-vuelo | Público | No | `vuelo`, `vuelo_programado` |
| `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/{id}` | webhook | `flights:webhooks` | No | `webhook_*`, `evento`, `evento_entrega` |

Fuera del contrato se agregan tres grupos de rutas:

| Rutas | Módulo | Permiso | Para qué |
| --- | --- | --- | --- |
| `GET /health` | salud | Público | Chequeo de vida para Render; consulta la base. Hecho en la fase 1 |
| `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | auth | Público, salvo `logout` y `me` | Emitir los JWT mientras no exista el proveedor de identidad |
| `/admin/countries`, `/admin/cities`, `/admin/airports`, `/admin/airlines`, `/admin/aircraft-models`, `/admin/fare-families`, `/admin/seat-maps`, `/admin/flights`, `/admin/departures`, `/admin/fares` | catalogo (pais, ciudad, aeropuerto, aerolinea, modelo-aeronave, familia-tarifa, mapa-asientos, vuelo, vuelo-programado, tarifa) | `flights:admin` | CRUD con eliminación lógica |

## Seguridad

La API niega por defecto: toda ruta exige un JWT válido salvo las que se marcan con `@Publico()`.

### Autenticación

- El módulo `auth` hace de proveedor de identidad mientras no exista el real.
- Contraseñas con argon2id; nunca se guardan ni se registran en texto plano.
- Token de acceso JWT de 15 minutos con `sub`, `scope`, `iss`, `aud` y `jti`. El `sub` es el `id_propietario` de retenciones, reservas y webhooks.
- Token de refresco opaco de 7 días, guardado como hash, con rotación: cada uso lo reemplaza y reusar uno viejo cierra la sesión.
- Login limitado a 5 intentos por minuto por IP y con el mismo mensaje de error para usuario inexistente y contraseña mala.
- Las tablas `usuario`, `rol`, `usuario_rol` y `token_refresco` van en `db/esquema_seguridad.sql`, dentro del esquema `vuelos`. Ninguna tabla de vuelos apunta a ellas, así que en RDA2 se quitan sin tocar el resto. No hay tablas `alcance` ni `rol_alcance`: los scopes de cada rol están en `src/modules/auth/scopes.ts` (ver Decisiones).
- Hecho en la fase 3: argon2id con 19 MiB, 2 pasadas y 1 hilo (`src/config/parametros-argon2.json`); JWT HS256 con `sub`, `scope`, `iss`, `aud`, `jti`, `iat` y `exp`; refresh opaco de 256 bits guardado como SHA-256, con familia, rotación y detección de reutilización (también cuando dos refresh compiten por el mismo token). Ver [src/common/README.md](../src/common/README.md) para proteger un endpoint.

### Autorización

Dos controles, en este orden: el permiso del token y la propiedad del recurso.

| Rol | Permisos (`scope`) | Cómo se obtiene |
| --- | --- | --- |
| cliente | `flights:read`, `flights:hold`, `flights:book`, `flights:cancel`, `flights:webhooks` | Registro público |
| administrador | Todos más `flights:admin` | Semilla de seguridad (`SEED_ADMIN_PASSWORD`) |

En la fase 3 el rol `integrador` del plan original se quitó: el cliente ya gestiona sus propios webhooks.

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

Cada escritura corre dentro de una transacción que primero fija `app.id_usuario` y `app.direccion_ip`. Con eso los triggers de la base llenan la tabla `auditoria` sin código extra en los servicios. La vía es `PrismaService.transaccionAuditada(actor, tx => ...)`, que usa `set_config(..., true)` para que el valor muera con la transacción y no pase a otra petición que reciba la misma conexión del pool.

## Fases

Las fases 0 a 3 son la base, la 4 fija el patrón de módulo y las 5 a 7 son el flujo de compra. La API se despliega desde la fase 1, no al final, para que los problemas de nube aparezcan temprano.

| Fase | Rama | Entrega | Hecha cuando |
| --- | --- | --- | --- |
| 0. Base del repo | `chore/f0-base` | Repo propio, lint, formato, reglas de commit, `db/` versionado, compose con PostgreSQL 18 | Un clon limpio levanta la base con `./db/reset.sh` y `npm run lint` pasa |
| 1. Núcleo | `feat/f1-nucleo` | Sin TypeORM, Prisma conectado, tabla de rutas, `/health`, Swagger, primer despliegue | `/flights/v1/health` responde 200 en Render y `/api/docs` abre |
| 2. Transversales | `feat/f2-transversales` | Errores `ProblemDetails`, validación, sanitización, helmet, CORS, límite de peticiones | Cualquier error, incluido un 404 de ruta, sale como `application/problem+json` |
| 3. Auth | `feat/f3-auth` | Registro, login, refresh, logout, guards de JWT y de permisos | Una ruta protegida responde 401 sin token y 403 sin el permiso |
| 4. Catálogo | `feat/f4-catalogo` | Clase base y CRUD de las 10 entidades de catálogo | Un `DELETE` deja la fila con `activo = false` y una fila en `auditoria` con el `sub` del administrador |
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

- Repositorio propio creado desde la plantilla; el remoto `upstream` queda solo como referencia histórica (ya no se traen cambios).
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

(Después, en la limpieza `chore/limpiar-otros-dominios`, se borraron los módulos y contratos de los otros dominios y las exclusiones que dejaron en tsconfig, ESLint y Prettier: el repo es solo de vuelos.) Dos commits no estaban en el plan original. La plantilla no compila tal como viene (el módulo de atracciones tiene errores de TypeScript), así que el commit 4 activa solo `VuelosModule` y deja los módulos de los otros equipos fuera de la compilación. El commit 3 separa el cambio de formato del cambio de configuración.

### Fase 1 · Núcleo

1. `fix(docker): hacer configurable el puerto de la base y de la API`
2. `refactor: quitar TypeORM y el controlador de ejemplo de vuelos`
3. `feat(config): validar las variables de entorno al arrancar`
4. `feat(prisma): introspeccionar el esquema vuelos y agregar PrismaService`
5. `feat(prisma): bloquear el delete físico y agregar la transacción auditada`
6. `feat(rutas): agregar la tabla de rutas con prefijo flights y versión v1`
7. `feat(salud): agregar GET /health con chequeo de la base`
8. `docs(swagger): configurar título, versión del contrato, esquema bearer e ícono`
9. `ci: agregar Dockerfile multi-etapa para Render`
10. `docs: cerrar la fase 1 en el plan y el README`

El despliegue en Render con Neon queda fuera de esta rama: necesita credenciales y se hace a mano desde el panel. El commit 1 no estaba en el plan; el 2 también borra los DTO de ejemplo de la plantilla, que solo usaba el controlador mock (siguen en el historial y en `upstream`).

### Fase 2 · Transversales

1. `docs: agregar CLAUDE.md con las reglas del proyecto`
2. `test(infra): agregar Jest y supertest con un primer e2e de /flights/v1/health`
3. `feat(errores): agregar filtro global ProblemDetails y ErrorNegocio`
4. `feat(errores): traducir errores de Prisma y de triggers a códigos del contrato`
5. `feat(validacion): agregar ValidationPipe global y pipes de uuid, fecha e IATA`
6. `feat(sanitizacion): agregar decoradores de limpieza de texto para los DTO`
7. `feat(seguridad): agregar helmet, CORS por lista de orígenes y tope de 100 kB`
8. `feat(seguridad): agregar límite de peticiones global con Retry-After`
9. `feat(contexto): agregar X-Request-Id y contexto por petición con AsyncLocalStorage`
10. `docs: cerrar la fase 2 en el plan y los README`

Los commits 1 y 2 (CLAUDE.md y Jest) no estaban en el plan original. El e2e del commit 2 obligó a sacar la configuración de la app de `main.ts` a `configurar-app.ts`, para que las pruebas levanten la misma API que se despliega.

Variables de entorno nuevas, todas opcionales y en `.env.example`: `CORS_ORIGINS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS` y `TRUST_PROXY`.

### Fase 3 · Auth

1. `feat(db): agregar el esquema de seguridad y la semilla de roles`
2. `feat(prisma): introspeccionar las tablas de seguridad`
3. `feat(auth): agregar hashing argon2id y tokens de acceso y de refresco`
4. `feat(auth): definir los scopes de cada rol`
5. `feat(auth): agregar registro, login y refresh con rotación`
6. `feat(auth): agregar guard JWT global, scopes, logout y perfil`
7. `feat(auth): limitar login, registro y refresh por IP`
8. `docs(swagger): documentar auth con bearer y los scopes del contrato`
9. `fix(auth): usar los parámetros de argon2id también bajo Jest`
10. `test(auth): agregar e2e de autenticación, autorización y límites`
11. `docs: cerrar la fase 3 en el plan, los README y CLAUDE.md`

Cambios frente al pedido: los scopes por rol (commit 4) van antes del módulo porque login y refresh los firman; logout y me entran con el guard (commit 6) porque necesitan al usuario autenticado. El commit 9 corrige un error que encontró la prueba del commit 10.

### Fase 4 · Catálogo

1. `feat(catalogo): agregar la clase base de CRUD con eliminación lógica`
2. `feat(catalogo): agregar el CRUD de países y ciudades`
3. `feat(catalogo): agregar el CRUD de aeropuertos`
4. `feat(catalogo): agregar el CRUD de aerolíneas y modelos de aeronave`
5. `feat(catalogo): agregar el CRUD de familias tarifarias y mapas de asientos`
6. `feat(catalogo): agregar el CRUD de vuelos y salidas programadas`
7. `feat(catalogo): agregar el CRUD de tarifas`
8. `test(catalogo): agregar e2e de alta, edición, baja lógica y auditoría`
9. `docs: cerrar la fase 4 en el plan, los README y CLAUDE.md`

Los commits 2, 5 y 7 incluyen el cambio de esquema que usan (`id_publico uuid`) junto con el `schema.prisma` regenerado, como pide la regla de un cambio de base completo por commit.

### Fase 5 · Búsqueda

1. `feat(busqueda): agregar los DTO, el modelo y el mapper de la búsqueda`
2. `feat(busqueda): agregar las consultas de salidas, cupos y precios vigentes`
3. `feat(busqueda): armar y guardar las ofertas de la búsqueda con su vigencia`
4. `feat(busqueda): exponer POST /search`
5. `feat(oferta): exponer el mapa de asientos de un segmento de la oferta`
6. `test(busqueda): agregar e2e de la búsqueda y el mapa de asientos`
7. `fix(busqueda): fijar creación y vencimiento de la oferta con el mismo reloj`
8. `test(catalogo): comparar la auditoría por id y no por hora`
9. `docs: cerrar la fase 5 en el plan, los README y CLAUDE.md`

Los commits 7 y 8 salieron de la verificación: el reloj de WSL salta respecto del de la base (ver Hallazgos).

No hubo commit de índices: `EXPLAIN ANALYZE` mostró que las dos consultas de la búsqueda ya usan índices existentes (ver Hallazgos).

### Fase 6 · Retenciones

1. `feat(retencion): agregar los DTO, el modelo y el mapper del hold`
2. `feat(retencion): agregar el repositorio de retenciones, cupos y claves`
3. `feat(retencion): crear el hold con precio congelado e idempotencia`
4. `feat(retencion): exponer POST /offers/hold con Idempotency-Key`
5. `feat(retencion): consultar y liberar un hold con vencimiento perezoso`
6. `feat(retencion): vencer periódicamente los holds y borrar claves vencidas`
7. `test(retencion): agregar e2e del hold con concurrencia, vencimiento e idempotencia`
8. `docs(retencion): documentar el 429 global y usar ejemplos de la semilla`
9. `docs: cerrar la fase 6 en el plan, los README y CLAUDE.md`

La idempotencia no quedó en un interceptor, como decía el plan: la clave tiene que guardarse en la misma transacción que el hold (ver Decisiones). El commit 8 salió de la verificación.

### Fase 7 · Reservas y boletos

1. `feat(reserva): agregar los DTO, modelos y mappers de reserva y boleto`
2. `feat(reserva): agregar los repositorios de reserva y boleto, y el PNR y el número de boleto`
3. `feat(pagos): agregar ServicioPagos con la Payment API simulada`
4. `feat(reserva): crear la reserva desde un hold en una sola transacción`
5. `feat(reserva): exponer POST /bookings con Idempotency-Key`
6. `feat(reserva): consultar reservas y boletos del dueño`
7. `feat(reserva): emitir periódicamente las reservas con pago pendiente`
8. `fix(reserva): repetir la respuesta si la misma clave ganó mientras se validaba`
9. `test(reserva): agregar e2e de reservas, boletos, pago simulado y concurrencia`
10. `docs: cerrar la fase 7 en el plan, los README y CLAUDE.md`

El commit 8 salió de las pruebas de concurrencia con la misma clave.

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

## Hallazgos

### Fase 1

Lo que hace Prisma 7 con nuestra base, verificado con `prisma db pull` contra PostgreSQL 18:

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| Introspección | 42 modelos y 16 enums desde `?schema=vuelos`, sin `@@schema` porque hay un solo esquema | Los modelos se llaman como las tablas (`vuelo_programado`, `reserva_cabecera`) |
| ENUM | Cada `CREATE TYPE ... AS ENUM` pasa a un `enum` de Prisma con los mismos valores en español (`PROGRAMADO`, `RETENIDA`...); en la consulta llegan como texto | La traducción al inglés del contrato va en los mappers (`compartido/`) |
| `COMMENT ON` | No se copia el texto. Prisma deja solo un aviso genérico (`/// This model or at least one of its fields has comments in the database...`) en el modelo o enum, y nada en los campos comentados | La documentación de columnas y la equivalencia de enums con el contrato siguen viviendo solo en `db/esquema_vuelos.sql` |
| `CHECK` | No se representan; solo un aviso por modelo | Las reglas las sigue haciendo cumplir la base; los DTO repiten las que el cliente debe conocer y el filtro de la fase 2 traduce la violación (23514) |
| Vistas | Las 3 vistas de la sección 16 no se introspeccionan (haría falta `previewFeatures = ["views"]`) | Se decide en la fase 5 o 7: activar `views` o leerlas con `$queryRaw` |
| Triggers y funciones | No aparecen en el esquema de Prisma | Siguen actuando igual; por eso la auditoría y la integridad no dependen del código |
| Índices parciales | `db pull` agregó `previewFeatures = ["partialIndexes"]` por sí solo | Ninguna acción |
| Comentarios en `schema.prisma` | `db pull` reescribe el archivo y borra cualquier comentario, incluso dentro del `generator` | Las explicaciones van en `prisma.config.ts`, no en el esquema |
| `bigint` | Llega como `BigInt` y `JSON.stringify` lanza `TypeError` | `BigInt.prototype.toJSON` lo serializa como texto (`habilitarBigIntEnJson` en `main.ts`). Las PK bigint son internas; el contrato expone los uuid |
| `numeric` | Llega como `Prisma.Decimal`, que en JSON sale como texto (`"100"`) | Los mappers lo convierten a número o a texto con dos decimales, según el contrato |
| `date` | Llega como `Date` a medianoche UTC (`fecha_salida`) | Al formatear, no aplicar zona horaria o se corre un día hacia atrás en Ecuador |
| `GENERATED ALWAYS AS IDENTITY` | Sale como `@default(autoincrement())` | Nunca enviar `id` al crear; la base lo rechaza |
| `?schema=vuelos` | El adaptador de `pg` no lo lee de la URL | `PrismaService` lo extrae de la URL y lo pasa en `{ schema }` |
| Conexión | Con el adaptador, `$connect()` no abre conexión; sin tope, `pg` espera indefinidamente a una base caída | Al arrancar se prueba con `SELECT 1`, y el pool corta a los 5 s |
| `prisma.config.ts` | Prisma 7 ya no lee `.env` por su cuenta | Se carga con `import 'dotenv/config'` |
| Extensión de imports | El generador deduce si poner `.ts` en los imports según encuentre un `tsconfig`; en `docker build` generaba `./internal/class.ts` y Node no arrancaba | `importFileExtension = ""` fijo en el `generator` |
| Peers opcionales | `@prisma/client` declara `prisma` y `typescript` como peers opcionales; npm los instala con `--omit=dev` | La imagen usa también `--omit=optional` (de 846 MB a 524 MB) |
| Transacciones anidadas | En Prisma 7, `$transaction` ya no está prohibido dentro de una transacción interactiva | `TransaccionVuelos` lo permite; no se usa por ahora |
| Bloqueo de delete | La extensión cubre `delete` y `deleteMany`, pero no los borrados anidados dentro de un `update` ni `$executeRaw` | Esos casos quedan para revisión de código; los `ON DELETE RESTRICT` del esquema siguen de respaldo |

### Fase 2

Lo que se vio al probar Prisma 7 (adaptador de `pg`) contra PostgreSQL 18.6, con transacciones que siempre se revierten:

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| Dónde está el error de la base | El dato útil está en `error.meta.driverAdapterError.cause`: `originalCode` (SQLSTATE), `kind` y a veces `constraint.index`. El `code` de Prisma cambia según cómo se consulte: el mismo SQLSTATE sale como P2003 con un modelo y como P2010 con `$queryRaw` | `traducir-error-bd.ts` decide por SQLSTATE, no por el `code` de Prisma |
| `ON DELETE RESTRICT` (pendiente de la fase 1) | PostgreSQL 18.6 responde SQLSTATE **23001** (`restrict_violation`), no 23503 (no se probó con otra versión). Prisma lo reconoce: `kind: RestrictViolation` y `constraint.index` con el nombre de la FK. Con un modelo (delete anidado en un `update`) llega como **P2003**; con SQL crudo como **P2010** (`Code: 23001`). Un `INSERT` con padre inexistente sí es 23503 | Se traduce a 409 en los dos caminos. Un `INSERT`/`UPDATE` con padre inexistente (23503) es 422 |
| Triggers de la sección 15 | `RAISE EXCEPTION ... USING ERRCODE = 'check_violation', CONSTRAINT = ...` llega como SQLSTATE 23514 con solo el mensaje: el nombre de la restricción **no** viaja (el adaptador copia `code`, `severity`, `message` y `detail`) | Los 4 triggers se reconocen por el texto de su mensaje en español. Si se cambia ese texto en el SQL, hay que cambiarlo en `POR_MENSAJE_TRIGGER`; `test/errores-bd.e2e-spec.ts` dispara los 4 contra la base y falla si se desfasan |
| CHECK sin trigger | El nombre sí viaja, dentro del mensaje (`violates check constraint "ck_..."`) | Se extrae con una expresión regular y se busca en `POR_RESTRICCION` |
| `auditoria` inmutable | `UPDATE`/`DELETE` sobre `auditoria` lanza SQLSTATE 42501 | No se traduce: es un error de programación, responde 500 y queda en el log |
| SQL crudo y el esquema | El adaptador solo aplica `{ schema }` a las consultas con modelo; `$queryRaw`/`$executeRaw` fallan con `relation "pais" does not exist` si la tabla no se califica | En SQL crudo, siempre `vuelos.<tabla>` |
| Base caída | Con un modelo: `PrismaClientKnownRequestError` P1001 (`kind: DatabaseNotReachable`); con `$queryRaw`: P2010 con el mismo `kind` | 503 con `Retry-After: 5`, sin host ni puerto en la respuesta |
| Choque concurrente | SQLSTATE 40001 llega como P2010 (raw) o P2034 (modelo), `kind: TransactionWriteConflict` | 409 con `Retry-After: 1` |
| Errores del parser de Express | El cuerpo de más de 100 kB o el JSON roto llegan como `http-errors` (`status`, `expose`, `type`), no como `HttpException`; sin tratarlos salían como 500 | `errorDelParser` los pasa a 413/400/415 |
| `ProblemDetails` y `code` | El esquema exige `code` y su lista no trae códigos para 401, 403, 404, 405, 413, 415 ni 5xx; no admite campos extra | Esos casos usan `VALIDATION_FAILED` y el `status` dice qué pasó (ver `CODIGO_SIN_EQUIVALENTE` en `codigo-error.ts`, un solo lugar para cambiarlo). El `type` es `about:blank` salvo cuando hay código específico |
| `invalidParams` | El esquema sí lo admite | La validación llena `detail` (`campo: razón; ...`) e `invalidParams` (lista estructurada, rutas como `pasajeros[0].edad`) |
| 405 | Nest responde 404 a un método no admitido | El filtro revisa las rutas registradas de Express (`app._router.stack`) y devuelve 405 con `Allow` |
| Límite de peticiones | `@nestjs/throttler` cuenta por ruta e IP por defecto; los guards no corren en rutas que no existen, así que un 404 no cuenta; `/health` se excluyó a propósito | El contador `default` se configuró por IP para toda la API; `estricto` (por ruta) solo corre con `@LimiteEstricto`. Los 404 siguen sin límite. El almacén es memoria de un proceso: con más de una instancia de la API cada una cuenta aparte |
| Parser y contexto asíncrono | Los eventos de la petición que escucha body-parser se emiten fuera del `AsyncLocalStorage`; si el contexto se abre antes, el parser lo pierde | El request id se asigna en el primer middleware (guardado también en `req`) y el contexto asíncrono se abre después del parser |
| `X-Request-Id` inválido | No se rechaza la petición: se reemplaza por un UUID generado | La respuesta siempre trae un id válido. No va en el cuerpo del error (el esquema no admite campos extra) |
| `trust proxy` | Sin configurarlo, detrás de Render todas las peticiones tienen la IP del proxy: el límite por IP se aplicaría a todos juntos y la auditoría guardaría la IP del proxy | `TRUST_PROXY=1` en Render. Por defecto `false`: así no se puede falsear la IP con `X-Forwarded-For`. `true` se rechaza |
| Windows y `\uXXXX` | Al escribir archivos con una herramienta, las secuencias `‮` se convirtieron en el carácter real y rompieron una expresión regular | Los invisibles se arman con `String.fromCodePoint` |

### Fase 3

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| argon2 en Docker | El paquete `argon2` trae binarios precompilados (glibc y musl, x64 y arm64) y no los genera un script de instalación; `--omit=optional` no lo afecta porque sus dependencias no son opcionales | La imagen funciona sin cambios en el `Dockerfile` (probado con hash y verificación dentro del contenedor). npm 11 deja el script de `argon2` "sin aprobar" y aun así funciona |
| Formato del hash | `argon2` de Node escribe los parámetros como `m=...,p=...,t=...`, no en el orden `m,t,p` de la documentación | El CHECK `ck_usuario_hash_contrasena` acepta cualquier orden. Lo detectó `reset.sh` al sembrar el administrador |
| Jest y archivos con el mismo nombre | Jest resuelve `config/argon2` probando `.js` y `.json` antes que `.ts`: con `argon2.ts` y `argon2.json` juntos importaba el JSON y argon2 usaba sus valores por defecto (64 MiB, 3 pasadas, 4 hilos) sin avisar. `tsc` no tiene ese problema | El JSON se llama `parametros-argon2.json` y el módulo falla al cargar si falta un parámetro. Regla: ningún `.json` con el mismo nombre que un `.ts` |
| Tiempo constante | Verificar contra un hash ficticio cuando el correo no existe tarda lo mismo que con un usuario real (mediana de 30,3 ms frente a 31,7 ms) | El login no revela qué correos existen por el tiempo. El registro sí lo revela (409); lo frena el límite de 10 cada 10 minutos |
| `db pull` con autorreferencia | La FK `token_refresco.reemplazado_por_id` genera las relaciones `token_refresco` y `other_token_refresco` | Nombres feos pero generados; no se editan a mano |
| Auditoría de contraseñas | `fn_auditar` copiaba la fila completa a `auditoria`, también el hash argon2 | `fn_auditar` enmascara `hash_contrasena` como ya hacía con `secreto`. `token_refresco` no se audita (dos filas por refresh) |
| Guards globales | El orden de los `APP_GUARD` es el de registro de los módulos: `CommonModule` (límite) se importa antes que `AuthModule` (JWT y scopes) | Una prueba lo comprueba: con el límite agotado, una ruta protegida sin token responde 429 y no 401 |
| Controllers de prueba | Con el guard global, los controllers de las pruebas de la fase 2 respondían 401 | Se marcaron `@Publico()` |
| `type` de los 401 y 403 | Un `ErrorNegocio` con el código de respaldo sale con `type: .../errors/validation-failed`, que no describe un error de autenticación | Se dejó como en la fase 2 para no cambiar el filtro; ver Pendientes |

### Fase 4

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| Identificadores | Cuatro tablas de catálogo solo tenían una PK `bigint` y ninguna clave natural simple | `id_publico uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE` en `ciudad`, `familia_tarifa`, `mapa_asientos_cabecera` y `tarifa_cabecera`. La semilla no cambió: el default llena las 15 316 tarifas |
| Salidas sin `activo` | `vuelo_programado` tiene `estado` y no `activo` | La base del catálogo deja que cada repository diga qué es "activa" (`estaActiva`, `fijarActivo`): para una salida, `estado <> 'CANCELADO'` |
| Integridad que el esquema no cubre | No hay triggers sobre catálogo ni inventario: solo CHECK y UNIQUE (`cupos_disponibles BETWEEN 0 AND cupos_totales`, un cupo por cabina) | En el service de salidas: el mapa es de la aerolínea que opera el vuelo, cada cupo existe en el mapa y no supera sus asientos físicos, la fecha local de salida se calcula con la zona de la ciudad de origen (00:30 UTC es el día anterior en Quito), y la salida es futura. En el de tarifas: la familia es de la aerolínea que comercializa el vuelo (la semilla lo cumple en las 15 316) y su cabina tiene cupo en la salida |
| Cambio de cupo concurrente | Un `UPDATE` con Prisma no puede comparar columnas entre sí | `$executeRaw` parametrizado: `SET disponibles = disponibles + (nuevo - totales), totales = nuevo WHERE nuevo >= totales - disponibles`. Una retención simultánea no puede dejar `cupos_disponibles` negativo; si el nuevo total queda por debajo de lo comprometido, 409 |
| Cancelar una salida | Las retenciones y reservas llegan a la salida por el itinerario (`retencion_detalle` / `reserva_detalle_itinerario` → `itinerario_detalle`) | Se cuentan con relaciones de Prisma: retenciones `RETENIDA` sin vencer y reservas que no están `CANCELADA` ni `FALLIDA`, con itinerario vigente. Una salida `DESPEGADO`, `ATERRIZADO` o `DESVIADO` no se cancela ni cambia horario ni cupos |
| "En uso" | Las filas de salidas pasadas referencian mapas, familias y vuelos para siempre | Solo bloquean la baja las salidas próximas no canceladas y las tarifas en venta; lo histórico no |
| `strictNullChecks` apagado | En un ternario, TypeScript no estrecha `string \| null \| undefined` y aceptaba devolver un `string` como `Date` | En los helpers que manejan `null` se escribe el `if` explícito |
| Límite de login en las pruebas manuales | Una ráfaga de `curl` que inicia sesión varias veces agota los 5 logins por minuto y los tokens salen vacíos (todo da 401) | Es el límite de la fase 3 funcionando. En las pruebas manuales se guarda el token (vale 15 minutos) en vez de volver a iniciar sesión |
| Pruebas que no borran | Lo que crean las pruebas queda dado de baja y los códigos naturales (ISO, IATA) son finitos | `test/utils/catalogo.ts` elige códigos libres al azar y los nombres únicos llevan un sufijo; la prueba se repite sin chocar. El país (676 códigos) es el primero que se agotaría: `./db/reset.sh` los libera |
| Una corrida lenta | Una vez, `test:e2e` marcó 318 s en `errores-bd.e2e-spec.ts` | Resuelto en la fase 5: no fue lentitud sino un salto del reloj de WSL (ver Hallazgos de la fase 5) |

### Fase 5

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| Lo que guarda una oferta | `oferta_cabecera` tiene aerolínea, huella, creación y vencimiento; `oferta_detalle`, los itinerarios en orden; `itinerario_detalle`, los segmentos. No guarda precios ni pasajeros | El precio de la respuesta es el del momento. El hold (fase 6) recibe `passengersBreakdown` y la familia de cada itinerario, y congela el precio en `retencion_detalle` leyéndolo de nuevo de la tarifa: si la tarifa cambió entre la búsqueda y el hold, vale la nueva |
| Asientos y retenciones | Una retención toma cupo de cabina (`inventario_cabina`), no asientos: ninguna tabla de retención apunta a `asiento`. Los asientos se asignan en la reserva (`assignedSeats`, `reserva_detalle_asiento`) | El mapa no tiene un estado "retenido" y el contrato solo expone `isAvailable`. No disponible = asignado en una reserva vigente o cabina sin cupo en la salida ("bloqueado"). La prueba de "asiento retenido" se reemplazó por la de un asiento reservado |
| Planes de las consultas | `EXPLAIN ANALYZE` con la semilla: las salidas del tramo usan `ix_vuelo_programado_fecha_salida` (2 días, unas 90 salidas) y 0,8 ms; los precios usan `uq_tarifa_cabecera_vuelo_familia`, `uq_inventario_cabina_vuelo_cabina` y `uq_tarifa_detalle_tarifa_tipo`, 3,8 ms | No hizo falta ningún índice. Con 100 veces más salidas por día convendría un índice por (aeropuerto, fecha), que hoy no es un caso claro |
| SQL crudo | `findMany` con `include` resuelve cada relación con una consulta aparte | La búsqueda usa dos `$queryRaw` parametrizados con joins (tablas calificadas `vuelos.`). Los ENUM se piden como `::text` para compararlos con `ANY` |
| Hoy en Ecuador | Galápagos va una hora detrás del continente | Una fecha es "pasada" solo si ya terminó en `Pacific/Galapagos`; la salida concreta se filtra después por su instante |
| Reloj de WSL | Jest marcó una prueba en +318 238 ms y la siguiente en −318 094 ms, con 7,7 s de tiempo real para todo el archivo; `pg_stat_activity` no mostró ninguna consulta esperando. Comparando `date` de WSL con el del contenedor, una de seis muestras dio +317,9 s: WSL resincroniza su reloj de vez en cuando | No es una espera de la base y explica los 318 s de la fase 4. Lo que mezclaba los dos relojes se corrigió: la oferta guarda creación y vencimiento con la hora de la aplicación, y la prueba de auditoría del catálogo compara por id. Las tres pruebas de límites (login, búsqueda y mapa) siguen dependiendo de `Date.now()`, porque `@nestjs/throttler` cuenta con él: si el reloj salta en medio, la ventana se vence antes y la prueba falla. Pasa sola al repetirla; en Render o en un CI con Linux el reloj no salta. Arreglo de fondo en la máquina: `wsl --shutdown` o sincronizar la hora de Windows |
| UIO-GYE también con escala | Entre UIO y GYE hay itinerarios con escala válidos (UIO-CUE-GYE con AV) | Salen después de los directos porque son más caros; la prueba de solo ida exige que haya directos, no que todos lo sean |

### Fase 6

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| La búsqueda no vence holds | Un hold vencido que nadie cerró sigue descontando su cupo hasta que lo cierra el proceso periódico, una consulta o un POST que compite por esas salidas | Por hasta `HOLD_EXPIRY_JOB_INTERVAL_SECONDS` (60 s), `/search` puede no ofrecer ese cupo. Quien ya tiene una oferta sí lo obtiene (el POST vence antes de competir). La búsqueda sigue sin escribir fuera de las ofertas |
| Orden de los bloqueos | `EXPLAIN` de la sentencia que toma el cupo: `LockRows` va encima de `Sort`, así que las filas se bloquean en el orden de `ORDER BY` | El orden fijo vale aunque sea una sola sentencia. El catálogo ajustaba las cabinas en el orden del cuerpo: ahora lo hace en el de `ORDEN_CABINAS`, el mismo |
| jsonb y el orden de las claves | La respuesta repetida salía con las claves en otro orden (`jsonb` no conserva el de escritura) | El mapper la rearma en el orden del contrato (`aRetencionRepetida`) |
| Variables de entorno en las pruebas | `ConfigModule` valida el entorno cuando se importa `AppModule`: cambiar `process.env` dentro de `crearApp` llega tarde si la variable está en `.env` | `HOLD_EXPIRY_JOB_ENABLED=false` se fija en `test/utils/entorno-pruebas.ts` (`setupFiles` de Jest), antes de cualquier import |
| Límite de peticiones en las pruebas | Una app de prueba hace más de 20 búsquedas y 30 holds; los contadores de `@nestjs/throttler` son privados | `LimitesReiniciables` (`test/utils/limites.ts`) reemplaza el almacenamiento y lo pone en cero entre pruebas; el límite se prueba en una app propia, sin él |
| Reloj de WSL otra vez | En la verificación del proceso periódico, el reloj de WSL saltó unos 5 minutos en medio del script, que midió mal su espera; el proceso (con `setInterval`, que no depende de la hora) venció el hold igual. Jest volvió a mostrar duraciones de +318 s y −318 s en dos pruebas | Las pruebas de vencimiento usan `RelojDePrueba` (quieto) y no se vieron afectadas en las tres corridas. La prueba del límite de holds se suma a las tres de límites que dependen de `Date.now()` (Hallazgos de la fase 5) |
| `strictNullChecks` apagado | Una unión discriminada (`{ creada: true } \| { creada: false; motivo }`) no se estrecha con `if` | El repository devuelve el motivo o `null`. Es la misma limitación de la fase 4 con los ternarios |
| La oferta no guarda los pasajeros | El hold no puede comprobar que `passengersBreakdown` sea el de la búsqueda | Se valida con las reglas de la búsqueda y el cupo se comprueba al retener; un cliente que retiene más pasajeros que los buscados recibe 409 si no hay cupo |

### Fase 7

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| `booking.created` no está en `tipo_evento` | El catálogo de eventos del esquema tiene `booking.confirmed`, `booking.failed` y `booking.ticket_issuing/issued/failed`, pero no `booking.created` ni uno para el pago pendiente | `EventosReserva` los emite igual (solo van al historial). La fase 10 decide si se agregan a `tipo_evento` o no se notifican |
| El hold congela totales, no precios por tipo | `retencion_detalle` guarda base e impuestos del itinerario para todos los pasajeros | En `BookingDetail.itineraries[].pricingOptions` la familia vendida va con `pricePerPassengerType: []`; `grandTotal` es el precio congelado. `CabinPricing` exige `availableSeats`: va el cupo de hoy de esa cabina |
| `PassengerItem` sirve de entrada y de salida | El contrato usa el mismo esquema para el cuerpo y para `BookingDetail.passengers` | La respuesta devuelve los datos del pasajero al dueño (documento, correo, teléfono) tal como se guardaron. Ningún error ni log los repite |
| `ticketId` sin formato en el contrato | El path de `/tickets/{ticketId}` es `string`, no `uuid` | Un `ticketId` que no es uuid no puede existir: 404, no 400. `bookingId` sí es uuid (400) |
| Orden en el listado con el reloj quieto | Tres reservas creadas en el mismo instante (reloj de prueba) salen por id, no por orden de creación | Es el desempate previsto (creación e id descendentes); la prueba adelanta el reloj un minuto entre reservas |
| Datos que dejan las pruebas | Las reservas confirmadas no se cancelan (fase 8): sus asientos y cupo quedan tomados, y las cadenas de catálogo con reservas no se pueden dar de baja | Las pruebas eligen asientos libres leyendo la base y toleran que la cadena quede activa; `./db/reset.sh` lo limpia todo |
| Una corrida con un fallo que no se repitió | En la verificación, la tercera de tres corridas seguidas tuvo una prueba fallida; la salida solo mostró el resumen (1 de 425) y no qué prueba fue. 15 corridas completas más, con la salida guardada para atraparla, pasaron todas | No se sabe cuál fue. Lo más probable es un salto del reloj de WSL en una de las cuatro pruebas de límites que dependen de `Date.now()` (Hallazgos de las fases 5 y 6), pero no está comprobado. Si vuelve a pasar, guardar la salida completa de `test:e2e` |
| Límite de POST /bookings en la verificación manual | Un script que hace 10 reservas en paralelo y luego otras 5 en el mismo minuto recibe 429 en las últimas | Es el límite de 10 por minuto funcionando; la prueba del asiento se corrió aparte, con la API reiniciada (los contadores están en memoria) |

## Pendientes

Tres cosas las decides tú o el equipo; el resto se verifica en la fase que corresponde.

- [ ] Confirmar con el equipo o el docente que el módulo de vuelos puede usar Prisma en lugar del TypeORM de la plantilla.
- [ ] Definir dónde vive el código: repo propio o una rama `vuelos` dentro de la plantilla. El plan sirve para los dos casos.
- [ ] Fecha de entrega de RDA1, para repartir las fases en semanas.
- [x] Fase 1: probar `prisma db pull` contra `?schema=vuelos`. Funciona con `prisma@7.10.0` fijo (ver Hallazgos).
- [ ] Fase 1: desplegar en Render con Neon (crear el servicio desde el `Dockerfile`, cargar `DATABASE_URL`, `NODE_ENV=production`, health check en `/flights/v1/health`) y cargar `db/esquema_vuelos.sql` y la semilla en Neon. Después, etiqueta `v0.1.0`.
- [x] Fase 2: el filtro de errores traduce `BorradoFisicoProhibidoError` (500, queda en el log) y la base caída (503).
- [x] Fase 3: el guard global de JWT respeta `@Publico()`, registra el `sub` con `fijarUsuario()` y corre después de `GuardLimitePeticiones`; el login lleva `@LimiteEstricto(5, 60)`.
- [ ] Equipo: el contrato declara `OAuth2Security` con los flujos `authorizationCode` y `clientCredentials` contra `https://auth.booking-hub.com/oauth2/token`, y la API usa un login propio con JSON (`POST /auth/login`). Se copió el esquema en Swagger para documentar los scopes, pero ese botón de Authorize no funciona en RDA1. Si se quiere usar el OAuth2 de Swagger, hace falta un `POST /auth/token` con `grant_type=password|refresh_token` en `application/x-www-form-urlencoded`.
- [ ] Equipo: el contrato no declara ninguna respuesta 401 y define `ProblemDetails403` sin usarlo en ninguna operación. La API responde 401 y 403 como `ProblemDetails` con el código de respaldo.
- [ ] Equipo: decidir si un `ErrorNegocio` con el código de respaldo (401, 403, 409 sin código propio) debe salir con `type: about:blank` en lugar de `.../errors/validation-failed` (`traducir-excepcion.ts`).
- [ ] Fase 1: en Render, poner `JWT_SECRET` (al menos 32 caracteres, generada para ese entorno) y, si hace falta un administrador, cargar `db/semilla_seguridad.sql` con `hash_admin` calculado con `db/hash-contrasena.js`.
- [x] Fase 6: la propiedad del hold (`id_propietario = usuario.id`, 404 si es ajeno) la hace el service; la fase 7 hace lo mismo con las reservas.
- [ ] Cuando haga falta: purgar los `token_refresco` vencidos con una tarea programada (y recién entonces agregarlo a `TABLAS_CON_BORRADO_FISICO`).
- [ ] Límite conocido: un access token sigue sirviendo hasta que vence (15 minutos) aunque se haga logout o se desactive la cuenta; `/auth/me` y `/auth/refresh` sí lo rechazan. Si hace falta cortarlo al instante, una lista de `jti` revocados.
- [ ] Límite conocido: dos refresh simultáneos con el mismo token (un cliente que reintenta) cuentan como reutilización y cierran la sesión. Si molesta, un margen de gracia de pocos segundos.
- [x] Fase 2: revisar cómo reporta Prisma el `ON DELETE RESTRICT`: SQLSTATE 23001, P2003 con un modelo y P2010 con SQL crudo (ver Hallazgos de la fase 2).
- [ ] Equipo: el contrato obliga a un `code` de lista cerrada pero no trae uno para 401, 403, 404, 405, 413, 415 ni 5xx. Hoy se usa `VALIDATION_FAILED` en esos casos; si el equipo acuerda códigos propios, se cambia en `codigo-error.ts`.
- [ ] Fase 1/2: en Render poner `TRUST_PROXY=1` y `CORS_ORIGINS` con el origen del frontend.
- [ ] Fase 2: las rutas que no existen (404) no cuentan en el límite de peticiones porque no pasan por ningún guard; si hace falta limitarlas, hay que pasar a un middleware.
- [ ] Fase 1: el servicio gratuito de Render se duerme tras 15 minutos sin uso; la primera petición después tarda.
- [ ] La tabla `pais` solo tiene Ecuador: un pasajero de otra nacionalidad recibe 422 hasta que se agregue su país con `POST /admin/countries`.
- [x] Fase 5: la búsqueda vende solo lo activo del catálogo: salidas `PROGRAMADO` o `DEMORADO` y futuras, con vuelo, aerolíneas, aeropuertos, tarifa, familia y moneda activos y cupo para los pasajeros.
- [x] Fase 6: el hold exige una oferta vigente, una selección por cada itinerario de la oferta y una familia de su aerolínea vendible en todos los segmentos; el precio se congela desde la tarifa actual y el cupo se descuenta con un UPDATE condicionado.
- [x] Fase 7: `POST /bookings` consume el hold con `RetencionService.consumir(holdId, sub, tx)` en su transacción, cobra `lockedPrice` y exige los pasajeros del hold.
- [ ] Fase 8: cancelar o cambiar una reserva reutiliza `ReservaRepository.liberarAsientos` y `devolverCupo`, y pasa sus cambios por `EventosReserva` (ver `src/modules/vuelos/README.md`, "Cómo se apoyan las fases 8 y 9").
- [ ] Fase 10: insertar en `evento` desde `EventosReserva.registrar`; decidir qué hacer con `booking.created` y `booking.payment_pending`, que no están en `tipo_evento`.
- [ ] RDA2: reemplazar `PagosSimulados` por el cliente de la Payment API real (ver "Cómo se reemplaza ServicioPagos").
- [ ] Equipo: el contrato solo declara 400, 409, 410 y 422 en POST /bookings y 404 en las consultas; la API también responde 401, 403 y 429, y 400 a un `bookingId` que no es uuid. Una respuesta repetida lleva `Idempotent-Replayed: true`, una cabecera que el contrato no nombra.
- [ ] Equipo: `clave_idempotencia.respuesta` dice "cuerpo de la respuesta original"; para POST /bookings guarda solo `{ bookingId }` para no duplicar datos personales (ver Decisiones).
- [ ] Límite conocido: una reserva `PENDIENTE_PAGO` espera sin tope de tiempo a que la Payment API decida; con la real convendría darla por fallida después de un plazo.
- [ ] Cuando se toque la búsqueda: pasar el vencimiento de las ofertas (`busqueda.service.ts`, `oferta.service.ts`, la purga) y `contarCompromisos` del catálogo al `Reloj`, como los holds. Hoy usan `Date.now()`; en producción es la misma hora, pero las pruebas no pueden adelantarla.
- [ ] Fase 8: cancelar una reserva devuelve el cupo de sus itinerarios con el mismo orden de bloqueo (salida, cabina) que el hold.
- [ ] Equipo: `DELETE /offers/hold/{holdId}` responde 409 si el hold ya se usó en una reserva; el contrato solo declara 204 y 404.
- [ ] Equipo: las tres operaciones del hold responden 400 si un id o la `Idempotency-Key` no son uuid, 401, 403 y 429; el contrato no los declara (GET y DELETE tampoco el 400). La respuesta repetida lleva `Idempotent-Replayed: true`, una cabecera que el contrato no nombra.
- [ ] Equipo: el contrato no fija formato a `offerId` ni a `itineraryId` en `HoldRequest`; la API exige uuid (400), porque así los genera la búsqueda.
- [ ] Equipo: `PassengerBreakdown` no tiene máximo en el contrato; la API aplica el de la base (9 pasajeros con asiento y no más infantes que adultos) y responde 400.
- [ ] Equipo: el contrato acepta campos de más dentro de cada tramo y de `passengers` (solo `SearchRequest` tiene `additionalProperties: false`); la API los rechaza con 400, como en todo el resto.
- [ ] Límite conocido: sin código compartido entre aerolíneas (una oferta, una aerolínea) y a lo sumo una escala por itinerario.
- [ ] Fase 5 o después: no hay CRUD de `moneda` (la tarifa la referencia por código ISO y la semilla solo trae USD) ni de `tipo_evento` (lo fija el contrato).
- [ ] Límite conocido del catálogo: el chequeo "en uso" y la escritura que lo sigue corren en la misma transacción, pero sin bloquear las filas hijas; un alta simultánea de una ciudad mientras se da de baja su país podría colarse. Para el uso de un administrador alcanza; si hiciera falta, `SELECT ... FOR UPDATE` sobre la fila padre.
- [ ] Límite conocido: una salida no cambia de mapa de asientos (cambio de aeronave). Hacerlo exige revalidar cupos y asientos ya asignados; queda para cuando haya reservas (fase 7).
- [ ] El pedido de la fase 4 citaba un "Ajuste de estructura" de este archivo que no existe: la estructura por entidad está en la sección Esqueleto.
- [ ] Fase 11: la semilla cubre 90 días desde el día en que se carga; hay que volver a sembrar antes de la entrega.
