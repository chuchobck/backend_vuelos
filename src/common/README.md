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
| `JwtAuthGuard`          | `guards/jwt-auth.guard`          | 401 con `WWW-Authenticate: Bearer` (y `error="invalid_token"` si falla)  |
| `ScopesGuard`           | `guards/scopes.guard`            | 403 con los scopes que faltan y `error="insufficient_scope"`             |

Con un token válido, `JwtAuthGuard` deja el usuario para `@UsuarioActual()` y llama a
`fijarUsuario(sub)`: toda escritura con `PrismaService.transaccionAuditada` queda en `auditoria`
con ese usuario, sin código extra.

## Reglas

- Los scopes salen de `src/modules/auth/scopes.ts` (tipados: un scope mal escrito no compila).
  Para el contrato, usa el mismo scope que declara la operación en `contracts/vuelos-openapi.yaml`.
- `@Scopes` también documenta la ruta en Swagger como el contrato (`OAuth2Security` con sus
  scopes, el candado `bearer` y las respuestas 401 y 403). Una ruta que solo pide token, sin
  scopes, se documenta con `@DocumentarAutenticacion()`.
- `@Publico()` y `@Scopes()` juntos no tienen sentido: `ScopesGuard` niega igual.
- Límite más estricto para una ruta: `@LimiteEstricto(limite, ventanaSegundos)`.
- La propiedad del recurso (filtrar por `id_propietario = usuario.id` y responder 404 si es
  ajeno) la hace el repository de cada entidad, desde las fases 6 y 7.
- El token de acceso no se revoca: vale hasta que vence (15 minutos) aunque la cuenta se
  desactive. Si una ruta necesita saberlo al instante, que consulte la base.
