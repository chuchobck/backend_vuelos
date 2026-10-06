import { CheckInRespuestaDto } from './dto/checkin.dto';
import { ResultadoCheckin } from './checkin.modelo';

export function aCheckin(resultado: ResultadoCheckin): CheckInRespuestaDto {
  return {
    bookingId: resultado.reservaId,
    status: resultado.estado,
    checkedInPassengers: resultado.pasajeros.map((p) => ({
      passengerId: p.codigo,
      status: p.estado,
      segments: p.tramos.map((t) => ({ segmentId: t.salidaId, seat: t.asiento, status: t.estado })),
    })),
  };
}
