import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lo que cualquier capa necesita saber de la petición en curso sin recibirlo como parámetro:
 * el logger lo imprime, PrismaService lo manda a los triggers de auditoría.
 */
export interface ContextoPeticion {
  /** X-Request-Id: el que mandó el cliente si tenía un formato válido, o uno generado. */
  requestId: string;
  /**
   * X-Correlation-Id: el proceso de negocio completo (una compra de punta a punta). El que llegó
   * sin cambios si es válido, o uno generado (`corr-<uuid>`). Va en cada respuesta y en cada
   * línea de log, y se propaga a todo lo que la petición llama (correlation-id.ts).
   */
  correlationId: string;
  /** IP del cliente (con `trust proxy` configurado, la de X-Forwarded-For). */
  ip: string | null;
  /**
   * `sub` del JWT, que JwtAuthGuard llena con `fijarUsuario`; null en una ruta pública.
   * Es el `id_propietario` de retenciones, reservas y webhooks.
   */
  usuario: string | null;
  /**
   * `client_id` del token, solo si es de un cliente máquina a máquina (AUTH_MODE=external,
   * client_credentials). Ese `sub` es el id del cliente en el servicio de identidad, así que la
   * auditoría ya lo identifica; esto es su código legible, que va a la línea de acceso.
   */
  cliente?: string;
  /**
   * La operación que atiende la petición: el operationId del contrato v2 o `Controller.método`
   * en v1. La fija GuardOperacion, el primer guard; `undefined` si ninguna ruta la atendió.
   */
  operacion?: string;
  /**
   * El span SERVER de la petición (o de la llamada gRPC), para que hasta la línea de acceso, que
   * se escribe cuando el contexto de OpenTelemetry ya no está activo, lleve su traceId y spanId.
   */
  traza?: { traceId: string; spanId: string };
}

const almacen = new AsyncLocalStorage<ContextoPeticion>();

/**
 * El contexto de una petición nueva (HTTP o gRPC). `correlationId` y `operacion` se agregan como
 * propiedades no enumerables: son de la fachada v2 y del log de acceso, y quien vuelca el
 * contexto (una prueba de v1, un log de depuración) sigue viendo los mismos campos de siempre.
 */
export function crearContexto(datos: {
  requestId: string;
  correlationId: string;
  ip: string | null;
}): ContextoPeticion {
  const contexto = { requestId: datos.requestId, ip: datos.ip, usuario: null };
  return Object.defineProperties(contexto, {
    correlationId: { value: datos.correlationId, enumerable: false },
    operacion: { value: undefined, enumerable: false, writable: true },
  }) as ContextoPeticion;
}

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
 * token y, si lo trae, su `client_id` (y el login, al verificar la contraseña); desde ahí
 * PrismaService escribe el `sub` en `app.id_usuario` en cada escritura.
 */
export function fijarUsuario(usuario: string, cliente?: string): void {
  const contexto = almacen.getStore();
  if (!contexto) return;
  contexto.usuario = usuario;
  if (cliente !== undefined) contexto.cliente = cliente;
}

/** `::ffff:203.0.113.7` (IPv4 dentro de IPv6) → `203.0.113.7`; lo demás queda igual. */
export function normalizarIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
}
