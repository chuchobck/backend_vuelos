import { Injectable } from '@nestjs/common';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { Reserva } from '../reserva/reserva.modelo';
import { ReservaService } from '../reserva/reserva.service';
import { clase_cabina } from '../../../../generated/prisma/client';
import { CodigoPase, grupoDeAbordaje, posicionDeAbordaje, tipoDeCodigo } from './codigo-pase';
import { PaseAbordar } from './pase-abordar.modelo';
import { PaseAbordarRepository } from './pase-abordar.repository';

/** Un check-in recién registrado de un pasajero con asiento, con lo que su pase necesita. */
export interface PedidoDePase {
  checkinId: bigint;
  reserva: Reserva;
  codigoPasajero: string;
  numeroVuelo: string;
  fechaSalida: Date;
  origen: string;
  destino: string;
  asiento: string;
  cabina: clase_cabina;
  emitido: Date;
}

/**
 * Pases de abordar. Se emiten al registrar el check-in, en la misma transacción, y desde
 * entonces no cambian: pedir los pases dos veces devuelve exactamente lo mismo. Solo existen
 * para pasajeros con asiento (BoardingPass.seat es obligatorio): un infante viaja en brazos de
 * su adulto, con el pase de este.
 */
@Injectable()
export class PaseAbordarService {
  constructor(
    private readonly repositorio: PaseAbordarRepository,
    private readonly codigo: CodigoPase,
    private readonly reservas: ReservaService,
  ) {}

  /** Emite el pase de un check-in: código firmado, grupo por cabina y posición por fila. */
  async emitir(tx: TransaccionVuelos, pedido: PedidoDePase): Promise<void> {
    const { reserva, codigoPasajero } = pedido;
    const boleto = reserva.boletos.find(
      (b) => b.codigoPasajero === codigoPasajero && b.estado === 'EMITIDO',
    );
    await this.repositorio.crear(tx, {
      checkinId: pedido.checkinId,
      grupo: grupoDeAbordaje(pedido.cabina),
      posicion: posicionDeAbordaje(pedido.asiento),
      codigoBarras: this.codigo.generar({
        pnr: reserva.pnr,
        numeroBoleto: boleto!.numero!,
        numeroVuelo: pedido.numeroVuelo,
        fechaSalida: pedido.fechaSalida,
        origen: pedido.origen,
        destino: pedido.destino,
        asiento: pedido.asiento,
        secuencia: reserva.pasajeros.findIndex((p) => p.codigo === codigoPasajero) + 1,
      }),
      tipo: tipoDeCodigo(pedido.cabina),
      emitido: pedido.emitido,
    });
  }

  /**
   * GET /bookings/{bookingId}/boarding-passes: solo el dueño (404 para otro). Los pases de los
   * pasajeros con check-in; sin check-in, lista vacía con 200 (el contrato solo declara 404 para
   * la reserva que no existe). Una reserva que ya no está CONFIRMED (cancelada, por ejemplo) no
   * tiene pases válidos: lista vacía.
   */
  async consultar(reservaId: string, idPropietario: string): Promise<PaseAbordar[]> {
    const reserva = await this.reservas.detalle(reservaId, idPropietario);
    if (reserva.estado !== 'CONFIRMADA') return [];
    return this.repositorio.deReserva(reserva.id);
  }
}
