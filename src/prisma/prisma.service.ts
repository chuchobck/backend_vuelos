import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ITXClientDenyList } from '@prisma/client/runtime/client';
import { PrismaClient } from '../generated/prisma/client';
import { bloqueoBorradoFisico } from './extensiones/bloqueo-borrado-fisico';
import {
  ActorAuditoria,
  fijarActor,
  OpcionesTransaccion,
} from './extensiones/transaccion-auditada';

function crearCliente(url: string) {
  const adaptador = new PrismaPg({ connectionString: url }, { schema: esquemaDeUrl(url) });
  return new PrismaClient({ adapter: adaptador }).$extends(bloqueoBorradoFisico);
}

/** Cliente de Prisma con las extensiones del proyecto. */
export type ClienteVuelos = ReturnType<typeof crearCliente>;

/** Cliente que recibe el callback de una transacción interactiva (sin $connect, $on ni $extends). */
export type TransaccionVuelos = Omit<ClienteVuelos, ITXClientDenyList>;

/**
 * Dueño de la conexión a PostgreSQL. Solo los repositories lo inyectan.
 *
 * - `db` sirve para lecturas; bloquea el delete físico sobre tablas de negocio.
 * - `transaccionAuditada` es la vía para escribir: fija el actor antes del cambio.
 *
 * Prisma 7 se conecta con el adaptador de `pg`, que no lee el `?schema=` de la URL:
 * el esquema se toma de la URL y se pasa aparte (por defecto, `vuelos`).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly db: ClienteVuelos;

  constructor(config: ConfigService) {
    this.db = crearCliente(config.getOrThrow<string>('DATABASE_URL'));
  }

  async onModuleInit(): Promise<void> {
    await this.db.$connect();
    this.logger.log('Conectado a PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }

  /**
   * Corre `trabajo` en una transacción que primero fija app.id_usuario y app.direccion_ip,
   * para que los triggers llenen la tabla auditoria con el actor correcto.
   */
  transaccionAuditada<T>(
    actor: ActorAuditoria,
    trabajo: (tx: TransaccionVuelos) => Promise<T>,
    opciones?: OpcionesTransaccion,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await fijarActor(tx, actor);
      return trabajo(tx);
    }, opciones);
  }
}

function esquemaDeUrl(url: string): string {
  return new URL(url).searchParams.get('schema') ?? 'vuelos';
}
