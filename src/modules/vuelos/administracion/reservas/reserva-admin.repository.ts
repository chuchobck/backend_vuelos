import { Injectable } from '@nestjs/common';
import { esUuid } from '../../../../common/pipes/formatos';
import { PrismaService } from '../../../../prisma/prisma.service';

/** Lectura del dueño de una reserva. La lista ya lo trae en su propia consulta (sin N+1). */
@Injectable()
export class ReservaAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** El correo de la cuenta, o null si no existe (el `id_propietario` es texto libre). */
  async correoDe(idPropietario: string): Promise<string | null> {
    if (!esUuid(idPropietario)) return null;
    const usuario = await this.prisma.db.usuario.findUnique({
      where: { id: idPropietario },
      select: { correo: true },
    });
    return usuario?.correo ?? null;
  }
}
