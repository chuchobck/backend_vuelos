import { Injectable } from '@nestjs/common';
import { esUuid, fechaIsoAUtc } from '../../../../common/pipes/formatos';
import { Reloj } from '../../../../common/reloj';
import { codificarCursor, decodificarCursor } from '../../catalogo/base/paginacion';
import { cuerpoInvalido, noExiste } from '../../compartido/errores';
import { fechaLocal } from '../../compartido/fechas';
import { ConsultaSalidasDto } from './dto/tablero-salidas.dto';
import { TableroDeSalidas } from './tablero-salidas.modelo';
import { DespuesDe, TableroSalidasRepository } from './tablero-salidas.repository';

/** Salidas por página si no se pide otra cosa, y el tope. */
export const LIMITE_SALIDAS = { porDefecto: 50, maximo: 100 };

/**
 * GET /airports/{iataCode}/departures: la pantalla pública de salidas de un aeropuerto (fase F1,
 * fuera del contrato). `date` es la fecha LOCAL del aeropuerto; sin ella, hoy en su zona horaria
 * según el `Reloj`. Paginada por hora programada. Sin datos de reservas ni de pasajeros.
 */
@Injectable()
export class TableroSalidasService {
  constructor(
    private readonly repositorio: TableroSalidasRepository,
    private readonly reloj: Reloj,
  ) {}

  async consultar(iata: string, consulta: ConsultaSalidasDto): Promise<TableroDeSalidas> {
    const aeropuerto = await this.repositorio.aeropuerto(iata);
    if (!aeropuerto) throw noExiste(`Airport ${iata} was not found`);

    const fecha = consulta.date
      ? fechaIsoAUtc(consulta.date)!
      : fechaLocal(this.reloj.ahora(), aeropuerto.zonaHoraria);
    const limite = consulta.limit ?? LIMITE_SALIDAS.porDefecto;
    const despuesDe = consulta.cursor ? leerCursor(consulta.cursor) : undefined;
    // Una fila de más dice si hay otra página
    const filas = await this.repositorio.salidas(iata, fecha, limite + 1, despuesDe);
    if (filas.length <= limite) return { aeropuerto, fecha, salidas: filas };
    const ultima = filas[limite - 1];
    return {
      aeropuerto,
      fecha,
      salidas: filas.slice(0, limite),
      nextCursor: codificarCursor(`${ultima.programada.toISOString()}|${ultima.id}`),
    };
  }
}

/** El cursor: `hora programada|id` en base64url. Otro texto es 400. */
function leerCursor(cursor: string): DespuesDe {
  const [programada, id, ...resto] = (decodificarCursor(cursor) ?? '').split('|');
  const fecha = new Date(programada);
  if (resto.length > 0 || Number.isNaN(fecha.getTime()) || !esUuid(id)) {
    throw cuerpoInvalido('cursor', 'is not a cursor of this list');
  }
  return { programada: fecha, id };
}
