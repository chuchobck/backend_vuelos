# Proteger un endpoint

Toda ruta exige un JWT de acceso válido: `JwtAuthGuard` es global y niega por defecto. No hay que
agregar nada para protegerla; hay que decir qué permisos pide o, a propósito, que es pública.

```ts
@Scopes('flights:book')                                   // exige el JWT y ese scope (403 si falta)
@Post()
crear(@UsuarioActual() usuario: UsuarioAutenticado) {}     // usuario.id es el sub (id_propietario)
```

```ts
@Publico()                                                // sin JWT: solo health, login y similares
@Get('status')
estado() {}
```

## Qué pasa en cada petición

Los guards globales corren en este orden:

| Guard                   | Dónde                            | Si falla                                                                 |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `GuardLimitePeticiones` | `guards/limite-peticiones.guard` | 429 `RATE_LIMIT_EXCEEDED` con `Retry-After`. Cuenta también los 401      |
| `JwtAuthGuard`          | `guards/jwt-auth.guard`          | 401 con `WWW-Authenticate: Bearer` (y `error="invalid_token"` si falla); 503 `AUTH_UNAVAILABLE` si no hay claves con las que verificar (solo `AUTH_MODE=external`) |
| `ScopesGuard`           | `guards/scopes.guard`            | 403 con los scopes que faltan y `error="insufficient_scope"`             |

Con un token válido, `JwtAuthGuard` deja el usuario para `@UsuarioActual()` y llama a
`fijarUsuario(sub)`: toda escritura con `PrismaService.transaccionAuditada` queda en `auditoria`
con ese usuario, sin código extra.

`JwtAuthGuard` no verifica el token él mismo: depende de `VerificadorToken`
(`modules/auth/seguridad/`), que según `AUTH_MODE` es `VerificadorLocal` (HS256, los tokens del
propio `/auth`) o `VerificadorJwks` (RS256, los del servicio de identidad, con su JWKS). Para un
endpoint no cambia nada: `usuario.id` es el `sub` en los dos modos, y `usuario.clienteId` trae el
`client_id` cuando el token es de un cliente máquina a máquina (solo en external).

## Reglas

- Los scopes salen de `src/modules/auth/scopes.ts` (tipados: un scope mal escrito no compila).
  Para el contrato, usa el mismo scope que declara la operación en `contracts/vuelos-openapi.yaml`.
- `@Scopes` también documenta la ruta en Swagger como el contrato (`OAuth2Security` con sus
  scopes, el candado `bearer` y las respuestas 401 y 403). Una ruta que solo pide token, sin
  scopes, se documenta con `@DocumentarAutenticacion()`.
- `@Publico()` y `@Scopes()` juntos no tienen sentido: `ScopesGuard` niega igual.
- Límite más estricto para una ruta: `@LimiteEstricto(limite, ventanaSegundos)`.
  Los contadores (`guards/almacen-limites.ts`) usan el `Reloj` inyectable con una ventana
  deslizante: una prueba de límites crea la app con un `RelojDePrueba` y lo adelanta, sin esperas.
- La propiedad del recurso (comparar `id_propietario` con `usuario.id` y responder 404 si es
  ajeno, nunca 403: no se revela que existe) la hace el service de cada entidad, como en
  `retencion.service.ts`.
- El token de acceso no se revoca: vale hasta que vence (15 minutos) aunque la cuenta se
  desactive. Si una ruta necesita saberlo al instante, que consulte la base.

## gRPC

El servidor gRPC interno (`src/config/grpc.ts`, [docs/GRPC.md](../../docs/GRPC.md)) no hereda los
guards, el filtro ni el pipe globales de HTTP. Un controlador gRPC lleva `@ControladorGrpc()`, que
los pone para gRPC:

| Pieza                     | Dónde                                     | Qué hace                                                                            |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `GuardSoloPublicoGrpc`    | `guards/solo-publico-grpc.guard`          | Sin `@Publico()` responde UNAUTHENTICATED: gRPC todavía no acepta tokens            |
| `InterceptorContextoGrpc` | `contexto/contexto-grpc.interceptor`      | `x-request-id` de la metadata al contexto, de vuelta en la respuesta y en el log    |
| `FiltroErroresGrpc`       | `filters/errores-grpc.filter`             | El ProblemDetails de REST como status gRPC (`errores/codigo-grpc.ts`) y metadata    |
| `crearPipeValidacion()`   | `pipes/validacion.pipe`                   | El mismo DTO y las mismas reglas que REST                                           |

## Idempotency-Key y hora

```ts
@Scopes('flights:hold')
@Post()
crear(@ClaveIdempotencia() clave: string, @Body() dto: X) {}   // 400 si falta o no es uuid
```

- `@ClaveIdempotencia()` (`decorators/clave-idempotencia.decorator.ts`) solo valida la cabecera y
  la entrega en minúsculas, sin repetir el valor recibido en el error. Guardarla en
  `clave_idempotencia` y repetir la respuesta es del service, en la misma transacción que el
  cambio que protege (ver `src/modules/vuelos/README.md`, Retenciones).
- `Reloj` (`reloj.ts`, global) da la hora de la aplicación. Todo lo que decide si algo venció la
  pide ahí; las pruebas lo reemplazan por `RelojDePrueba` (`test/utils/reloj.ts`).
