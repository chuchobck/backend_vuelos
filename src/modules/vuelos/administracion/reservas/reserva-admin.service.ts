import { Injectable } from '@nestjs/common';
import {
  CancelacionService,
  ResultadoCancelacion,
} from '../../operaciones/cancelacion/cancelacion.service';
import { Reserva } from '../../operaciones/reserva/reserva.modelo';
import { FilaListado } from '../../operaciones/reserva/reserva.repository';
import { ReservaService } from '../../operaciones/reserva/reserva.service';
import {
  CancelarReservaAdminDto,
  ConsultaReservasAdminDto,
  PropietarioReservaDto,
} from './dto/reserva-admin.dto';
import { ReservaAdminRepository } from './reserva-admin.repository';

/**
 * Reservas de todos los clientes para la administración. No tiene reglas propias: lee con el
 * mismo código que /bookings (sin el filtro de dueño) y cancela con el mismo servicio de
 * cancelación, de modo que el reembolso, los eventos y la auditoría son los de siempre.
 */
@Injectable()
export class ReservaAdminService {
  constructor(
    private readonly reservas: ReservaService,
    private readonly cancelaciones: CancelacionService,
    private readonly repositorio: ReservaAdminRepository,
  ) {}

  listar(
    consulta: ConsultaReservasAdminDto,
  ): Promise<{ filas: FilaListado[]; nextCursor?: string }> {
    return this.reservas.listarTodas(consulta, {
      correoPropietario: consulta.ownerEmail,
      numeroVuelo: consulta.flightNumber,
    });
  }

  async detalle(reservaId: string): Promise<{ reserva: Reserva; owner: PropietarioReservaDto }> {
    const { reserva, idPropietario } = await this.reservas.detalleAdministracion(reservaId);
    return {
      reserva,
      owner: { id: idPropietario, email: await this.repositorio.correoDe(idPropietario) },
    };
  }

  /** Cancela y devuelve la reserva (y el dueño) como quedó. */
  async cancelar(
    reservaId: string,
    idAdministrador: string,
    clave: string,
    cuerpo: CancelarReservaAdminDto,
  ): Promise<ResultadoCancelacion & { owner: PropietarioReservaDto }> {
    const resultado = await this.cancelaciones.cancelarComoAdministrador(
      reservaId,
      idAdministrador,
      clave,
      cuerpo.reason,
    );
    const { owner } = await this.detalle(reservaId);
    return { ...resultado, owner };
  }
}
