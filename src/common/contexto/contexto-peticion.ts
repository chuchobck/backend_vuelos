import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lo que cualquier capa necesita saber de la petición en curso sin recibirlo como parámetro:
 * el logger lo imprime, PrismaService lo manda a los triggers de auditoría.
 */
export interface ContextoPeticion {
  /** X-Request-Id: el que mandó el cliente si tenía un formato válido, o uno generado. */
  requestId: string;
  /** IP del cliente (con `trust proxy` configurado, la de X-Forwarded-For). */
  ip: string | null;
  /**
   * `sub` del JWT, que JwtAuthGuard llena con `fijarUsuario`; null en una ruta pública.
   * Es el `id_propietario` de retenciones, reservas y webhooks.
   */
  usuario: string | null;
}

const almacen = new AsyncLocalStorage<ContextoPeticion>();

/** El contexto de la petición en curso, o `undefined` fuera de una petición (arranque, tareas). */
export function obtenerContexto(): ContextoPeticion | undefined {
  return almacen.getStore();
}

/** Corre `trabajo` con `contexto` visible desde `obtenerContexto()`, también tras cada `await`. */
export function ejecutarEnContexto<T>(contexto: ContextoPeticion, trabajo: () => T): T {
  return almacen.run(contexto, trabajo);
}

/**
 * Registra el usuario autenticado en el contexto. Lo llama JwtAuthGuard con el `sub` del
 * token (y el login, al verificar la contraseña); desde ahí PrismaService lo escribe en
 * `app.id_usuario` en cada escritura.
 */
export function fijarUsuario(usuario: string): void {
  const contexto = almacen.getStore();
  if (contexto) contexto.usuario = usuario;
}

/** `::ffff:203.0.113.7` (IPv4 dentro de IPv6) → `203.0.113.7`; lo demás queda igual. */
export function normalizarIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
}
