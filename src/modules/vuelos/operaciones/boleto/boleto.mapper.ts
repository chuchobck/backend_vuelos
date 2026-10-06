import { ESTADO_BOLETO, ESTADO_CUPON } from '../../compartido/enums';
import { aInstante } from '../../compartido/formatos-salida';
import { Boleto } from './boleto.modelo';
import { BoletoDto, ListaBoletosDto } from './dto/boleto.dto';

export function aBoleto(boleto: Boleto): BoletoDto {
  return {
    ticketId: boleto.id,
    bookingId: boleto.reservaId,
    passengerId: boleto.codigoPasajero,
    eTicketNumber: boleto.numero,
    status: ESTADO_BOLETO.aContrato(boleto.estado),
    issuedAt: aInstante(boleto.emitido),
    segments: boleto.cupones.map((cupon) => ({
      segmentId: cupon.salidaId,
      status: ESTADO_CUPON.aContrato(cupon.estado),
      couponNumber: cupon.numero === null ? null : String(cupon.numero),
    })),
    failureReason: boleto.motivoFallo,
  };
}

export function aListaBoletos(reservaId: string, boletos: Boleto[]): ListaBoletosDto {
  return { bookingId: reservaId, tickets: boletos.map(aBoleto) };
}
