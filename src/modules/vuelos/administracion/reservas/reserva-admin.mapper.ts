import { aDetalleReserva, aResumenReserva } from '../../operaciones/reserva/reserva.mapper';
import { Reserva } from '../../operaciones/reserva/reserva.modelo';
import { FilaListado } from '../../operaciones/reserva/reserva.repository';
import {
  DetalleReservaAdminDto,
  ListaReservasAdminDto,
  PropietarioReservaDto,
  ResumenReservaAdminDto,
} from './dto/reserva-admin.dto';

/** Reusa los mapeos de /bookings y les suma el dueño. */
export function aResumenAdmin(fila: FilaListado): ResumenReservaAdminDto {
  return {
    ...aResumenReserva(fila),
    owner: { id: fila.idPropietario, email: fila.correoPropietario },
  };
}

export function aListaAdmin(pagina: {
  filas: FilaListado[];
  nextCursor?: string;
}): ListaReservasAdminDto {
  const items = pagina.filas.map(aResumenAdmin);
  return pagina.nextCursor === undefined ? { items } : { items, nextCursor: pagina.nextCursor };
}

export function aDetalleAdmin(
  reserva: Reserva,
  owner: PropietarioReservaDto,
): DetalleReservaAdminDto {
  return { ...aDetalleReserva(reserva), owner };
}
