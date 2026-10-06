import { Injectable } from '@nestjs/common';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { EventoWebhook, Suscripcion } from './webhook.modelo';

/**
 * Suscripciones (webhook_cabecera) y los eventos a los que se suscribieron (webhook_detalle, sin
 * controller propio). Las bajas son lógicas (`activo = false`); la tabla no se borra. El secreto
 * llega y sale cifrado: este repository nunca lo ve en claro.
 */
@Injectable()
export class WebhookRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cuántas suscripciones activas tiene el usuario, con un candado de transacción por usuario:
   * dos altas simultáneas se esperan y la segunda cuenta la primera, así nunca pasan del máximo.
   */
  async contarActivasBloqueando(tx: TransaccionVuelos, idPropietario: string): Promise<number> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'webhook:' + idPropietario}, 0))`;
    return tx.webhook_cabecera.count({ where: { id_propietario: idPropietario, activo: true } });
  }

  /** Crea la suscripción y sus eventos. Una URL activa repetida del usuario viola el único (409). */
  async crear(
    tx: TransaccionVuelos,
    nueva: {
      idPropietario: string;
      url: string;
      secretoCifrado: string;
      eventos: readonly EventoWebhook[];
      creada: Date;
    },
  ): Promise<string> {
    const fila = await tx.webhook_cabecera.create({
      data: {
        id_propietario: nueva.idPropietario,
        url: nueva.url,
        secreto: nueva.secretoCifrado,
        fecha_creacion: nueva.creada,
      },
      select: { id: true },
    });
    await tx.$executeRaw`
      INSERT INTO vuelos.webhook_detalle (webhook_id, tipo_evento_id)
      SELECT ${fila.id}::uuid, t.id FROM vuelos.tipo_evento t WHERE t.codigo = ANY(${[...nueva.eventos]})`;
    return fila.id;
  }

  /** Las suscripciones activas del usuario, de la más vieja a la más nueva. */
  async activasDe(idPropietario: string): Promise<Suscripcion[]> {
    const filas = await this.prisma.db.webhook_cabecera.findMany({
      where: { id_propietario: idPropietario, activo: true },
      orderBy: [{ fecha_creacion: 'asc' }, { id: 'asc' }],
      include: {
        webhook_detalle: { select: { tipo_evento: { select: { id: true, codigo: true } } } },
      },
    });
    return filas.map((f) => ({
      id: f.id,
      url: f.url,
      secretoCifrado: f.secreto,
      eventos: f.webhook_detalle
        .map((d) => d.tipo_evento)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((t) => t.codigo as EventoWebhook),
    }));
  }

  /** Da de baja (lógica) la suscripción activa del usuario. Devuelve si existía. */
  async desactivar(tx: TransaccionVuelos, id: string, idPropietario: string): Promise<boolean> {
    const { count } = await tx.webhook_cabecera.updateMany({
      where: { id, id_propietario: idPropietario, activo: true },
      data: { activo: false },
    });
    return count === 1;
  }
}
