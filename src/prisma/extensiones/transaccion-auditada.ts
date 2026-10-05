/**
 * Quién hace el cambio. Los triggers de auditoría (sección 13 de db/esquema_vuelos.sql)
 * lo leen de app.id_usuario y app.direccion_ip; null deja la columna vacía.
 */
export interface ActorAuditoria {
  /** `sub` del JWT. */
  idUsuario: string | null;
  /** IP del cliente. Si no es una IP válida, el trigger la guarda como null. */
  direccionIp: string | null;
}

export interface OpcionesTransaccion {
  maxWait?: number;
  timeout?: number;
}

interface EjecutorSql {
  $executeRaw(consulta: TemplateStringsArray, ...valores: unknown[]): PromiseLike<number>;
}

/**
 * Fija el actor solo para la transacción en curso (tercer parámetro de set_config en true),
 * así el valor no se filtra a otra petición que reciba la misma conexión del pool.
 */
export async function fijarActor(tx: EjecutorSql, actor: ActorAuditoria): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.id_usuario', ${actor.idUsuario ?? ''}, true),
                              set_config('app.direccion_ip', ${actor.direccionIp ?? ''}, true)`;
}
