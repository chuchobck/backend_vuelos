# Pruebas de seguridad

Fecha: 2026-10-06 · Rama `chore/f11-entrega` · Base de pruebas local (PostgreSQL 18 con la semilla).

## Qué se prueba y dónde

Todo corre en `npm run test:e2e`, contra la API real.

| Tema | Resultado | Suite |
| --- | --- | --- |
| Sin token → 401 en cada operación protegida | Las 19 operaciones del contrato con `OAuth2Security` y todas las rutas propias protegidas (catálogo `/admin` y `/auth`), recorridas desde el contrato y desde el OpenAPI generado: 401 `ProblemDetails` | `seguridad-api` |
| Las públicas | Solo `POST /search`, `GET /offers/{offerId}/seatmap` y `GET /flights/{flightNumber}/status`, como en el contrato | `seguridad-api` |
| Scope insuficiente → 403 | Cada operación del contrato con un token que tiene todos los scopes menos el suyo, y todo `/admin` con un token de cliente | `seguridad-api` |
| Recurso ajeno → 404 | Otro usuario sobre la reserva (consulta, boletos, equipaje, cambio, cotización, cancelación, check-in, pases), el hold y el webhook: 404, igual que si no existiera; nada cambia para la dueña y su reserva no aparece en la lista del otro | `seguridad-api` (y cada suite de su operación) |
| JWT manipulado, vencido, otra clave, `alg: none`, basura | 401 sin repetir el token | `seguridad-api`, `autorizacion` |
| Refresh reutilizado | Reusar un refresh ya rotado revoca la familia: el vigente también responde 401 | `seguridad-api`, `auth` |
| Inyección SQL y XSS | En el PNR de la query, el número de vuelo y la fecha de la ruta, el origen de la búsqueda, la huella del dispositivo, el nombre y apellido del pasajero y la URL de un webhook: 4xx, nunca 500, y la respuesta no refleja `<script>` ni `DROP TABLE`; la base sigue entera. SQL crudo solo con plantillas etiquetadas (parámetros enlazados) | `seguridad-api`, `sanitizacion` |
| Cuerpo de más de 100 kB → 413 | En una operación del contrato y en JSON y formularios | `seguridad-api`, `seguridad` |
| Content-Type distinto de JSON → 415 | Texto, XML, formulario, multipart, `+json` y sin Content-Type. **Bug encontrado y corregido** en esta fase: antes llegaban vacíos a la validación y respondían 400 (commit `fix(seguridad): responder 415 a un cuerpo que no es JSON`) | `seguridad` |
| Cabeceras de helmet | `X-Content-Type-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy`, sin `X-Powered-By`, también en los errores; en producción la CSP agrega `upgrade-insecure-requests` | `seguridad-api`, `seguridad`, `seguridad-produccion` |
| CORS | Solo los orígenes de `CORS_ORIGINS` reciben `Access-Control-Allow-Origin`, también en el preflight | `seguridad-api`, `seguridad` |
| Errores en producción | Con `NODE_ENV=production`: 500, 404, 405, JSON roto, cuerpo inválido, 401 y 415 salen como `ProblemDetails` sin líneas de stack, rutas de archivos, nombres de tablas ni el mensaje interno; el 500 solo trae `type`, `title`, `status` y `code` | `seguridad-produccion`, `errores` |
| Límite de peticiones | 429 con `Retry-After` en cada ruta con límite; ahora con el reloj inyectable y estable ante saltos del reloj | `limite-peticiones` y las suites de cada operación |

## npm audit --omit=dev

Corrido el 2026-10-06: **15 avisos (0 críticos, 8 altos, 6 moderados, 1 bajo)**, todos en
dependencias de Nest 10 y Prisma 7. No se forzó ninguna actualización mayor (`npm audit fix
--force` pasaría a Nest 12 y bajaría Prisma a 6).

| Paquete | Severidad | Directa | Arreglo | Qué implica aquí |
| --- | --- | --- | --- | --- |
| `@nestjs/platform-express` (multer, body-parser) | alta | sí | mayor (Nest 12) | multer solo se usa con interceptores de archivos: la API no los tiene y ahora rechaza multipart con 415. body-parser: el aviso es para un `limit` inválido; aquí es fijo (`100kb`) |
| `multer` | alta | no | mayor (Nest 12) | Ídem |
| `prisma`, `@prisma/config`, `deepmerge-ts`, `mysql2` | alta | sí / no | mayor (Prisma 6) | `mysql2` es del adaptador de MySQL, no se usa (PostgreSQL). `deepmerge-ts` se usa al leer la configuración de Prisma (CLI), no con datos del cliente |
| `js-yaml` (vía `@nestjs/swagger`) | alta | no | mayor | Solo para el YAML interno de Swagger; ningún YAML viene del cliente |
| `lodash` (vía `@nestjs/config`, `@nestjs/swagger`) | alta | no | mayor | `_.template` no se usa con datos del cliente |
| `@nestjs/core`, `@nestjs/swagger`, `@nestjs/config` | moderada | sí | mayor | Avisos heredados de los anteriores |
| `@nestjs/common`, `file-type` | moderada | sí / no | `npm audit fix` (sin cambio mayor) | `file-type` no se usa (sin subida de archivos) |
| `qs` | moderada | no | `npm audit fix` (sin cambio mayor) | Lo usa el parser de formularios y de la query |
| `body-parser` | baja | no | mayor | Ver arriba |

Propuesta: correr `npm audit fix` (sin `--force`) en una rama aparte con la suite completa, y
planificar el paso a Nest 11/12 y Prisma 8 después de RDA1. Ninguno de los avisos es explotable
con lo que la API expone hoy, pero el análisis anterior es razonado, no probado contra cada CVE.
