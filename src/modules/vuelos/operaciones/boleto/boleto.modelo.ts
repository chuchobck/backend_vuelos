import { estado_boleto, estado_cupon } from '../../../../generated/prisma/client';

/** Un cupón del boleto: el tramo de un vuelo (boleto_detalle). */
export interface Cupon {
  salidaId: string;
  /** null hasta que el cupón se emite. */
  numero: number | null;
  estado: estado_cupon;
}

/** Un boleto electrónico de un pasajero (boleto_cabecera). */
export interface Boleto {
  id: string;
  reservaId: string;
  /** passengerId del contrato (reserva_detalle_pasajero.codigo_pasajero). */
  codigoPasajero: string;
  /** eTicketNumber de 13 dígitos; null hasta que se emite. */
  numero: string | null;
  estado: estado_boleto;
  emitido: Date | null;
  motivoFallo: string | null;
  cupones: Cupon[];
}
