import { Injectable } from '@nestjs/common';
import { noExiste } from '../../compartido/errores';
import { aFecha } from '../../compartido/formatos-salida';
import { EstadoVuelo } from './estado-vuelo.modelo';
import { EstadoVueloRepository } from './estado-vuelo.repository';

/**
 * GET /flights/{flightNumber}/status?date=. El número lleva el código IATA de la aerolínea
 * comercializadora (dos caracteres) y el número de vuelo (de uno a cuatro dígitos); la fecha es
 * la local de salida en el aeropuerto de origen, la misma que usa la búsqueda. Todo sale de la
 * salida programada: estimadas, reales y terminales son null mientras la base no las tenga.
 */
@Injectable()
export class EstadoVueloService {
  constructor(private readonly repositorio: EstadoVueloRepository) {}

  async consultar(numeroVuelo: string, fecha: Date): Promise<EstadoVuelo> {
    const estado = await this.repositorio.buscar(
      numeroVuelo.slice(0, 2),
      numeroVuelo.slice(2),
      fecha,
    );
    if (!estado) throw noExiste(`Flight ${numeroVuelo} was not found on ${aFecha(fecha)}`);
    return estado;
  }
}
