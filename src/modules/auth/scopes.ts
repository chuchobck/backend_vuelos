/**
 * Permisos (`scope` del JWT) y qué roles los tienen.
 *
 * DÓNDE VIVE ESTA TABLA: en código y no en la base, a propósito.
 * - Un scope solo significa algo si un `@Scopes(...)` del código lo exige: agregar uno en la
 *   base sin cambiar el código no protege nada, y quitar uno exige revisar los controllers.
 *   Cualquier cambio de permisos ya implica un despliegue, así que se revisa en el mismo
 *   pull request que el endpoint que lo usa.
 * - Son 2 roles y 6 scopes fijados por el contrato: una tabla `alcance` y otra `rol_alcance`
 *   sumarían dos joins a cada login y refresh sin dar flexibilidad real.
 * - En RDA2 los scopes los emitirá el proveedor de identidad real; esta tabla y las de
 *   db/esquema_seguridad.sql se quitan juntas.
 * Lo que sí está en la base es qué rol tiene cada usuario (usuario_rol): eso cambia sin
 * desplegar. Los códigos de rol de aquí deben coincidir con los de db/semilla_seguridad.sql.
 */

/**
 * Los 5 scopes de components.securitySchemes.OAuth2Security del contrato, más
 * `flights:admin`, propio del proyecto para el CRUD de catálogo en /admin (no está en el
 * contrato). El orden es el de la respuesta (`scope` del token y `scopes` de /auth/me).
 */
export const SCOPES = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
  'flights:admin',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Roles de db/semilla_seguridad.sql (tabla rol, columna codigo). */
export const ROLES = ['cliente', 'administrador'] as const;

export type CodigoRol = (typeof ROLES)[number];

/** El rol que recibe una cuenta creada con POST /auth/register. */
export const ROL_DEL_REGISTRO: CodigoRol = 'cliente';

export const SCOPES_POR_ROL: Readonly<Record<CodigoRol, readonly Scope[]>> = {
  // Todo lo que el contrato permite a un cliente, incluidos sus propios webhooks
  cliente: ['flights:read', 'flights:hold', 'flights:book', 'flights:cancel', 'flights:webhooks'],
  administrador: SCOPES,
};

export function esScope(valor: string): valor is Scope {
  return (SCOPES as readonly string[]).includes(valor);
}

/**
 * Unión de los scopes de los roles, en el orden de SCOPES. Un rol que no está en la tabla
 * (uno nuevo en la base sin su entrada aquí) no concede nada: se niega por defecto.
 */
export function scopesDeRoles(roles: readonly string[]): Scope[] {
  const concedidos = new Set<Scope>(roles.flatMap((rol) => SCOPES_POR_ROL[rol as CodigoRol] ?? []));
  return SCOPES.filter((scope) => concedidos.has(scope));
}
