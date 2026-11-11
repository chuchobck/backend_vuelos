import { EstadoDeCheckin } from '../checkin/checkin.modelo';
import { Reserva } from '../reserva/reserva.modelo';

/** Una reserva abierta en el kiosko: la sesión que la autoriza y lo que se muestra de ella. */
export interface ReservaEnKiosko {
  token: string;
  vence: Date;
  reserva: Reserva;
  checkin: EstadoDeCheckin;
}
