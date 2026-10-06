import { Injectable } from '@nestjs/common';
import { AerolineaRepository } from '../aerolinea/aerolinea.repository';
import { AeropuertoRepository } from '../aeropuerto/aeropuerto.repository';
import { cuerpoInvalido, referenciaInvalida, usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { ActualizarVueloDto, CrearVueloDto } from './dto/vuelo.dto';
import { FilaVuelo, FiltroVuelo, VueloRepository } from './vuelo.repository';

@Injectable()
export class VueloService extends ServicioCatalogo<
  FilaVuelo,
  CrearVueloDto,
  ActualizarVueloDto,
  FiltroVuelo
> {
  protected readonly entidad = 'Flight';

  constructor(
    private readonly vuelos: VueloRepository,
    private readonly aerolineas: AerolineaRepository,
    private readonly aeropuertos: AeropuertoRepository,
  ) {
    super(vuelos);
  }

  /**
   * Aerolíneas y aeropuertos deben estar activos (422) y la ruta debe unir dos aeropuertos
   * distintos (400). Aerolínea + número repetidos es 409.
   */
  protected async insertar(dto: CrearVueloDto, tx: Ejecutor): Promise<string> {
    if (dto.origin === dto.destination) {
      throw cuerpoInvalido('destination', 'must be different from origin');
    }
    const aerolineaId = await this.aerolineaActiva('marketingCarrier', dto.marketingCarrier, tx);
    const operadoraId =
      dto.operatingCarrier === undefined || dto.operatingCarrier === dto.marketingCarrier
        ? aerolineaId
        : await this.aerolineaActiva('operatingCarrier', dto.operatingCarrier, tx);
    const origenId = await this.aeropuertoActivo('origin', dto.origin, tx);
    const destinoId = await this.aeropuertoActivo('destination', dto.destination, tx);

    await this.vuelos.insertar(
      { aerolineaId, operadoraId, numero: dto.number, origenId, destinoId },
      tx,
    );
    return `${dto.marketingCarrier}${dto.number}`;
  }

  protected async modificar(fila: FilaVuelo, dto: ActualizarVueloDto, tx: Ejecutor): Promise<void> {
    const operadoraId =
      dto.operatingCarrier === undefined
        ? undefined
        : await this.aerolineaActiva('operatingCarrier', dto.operatingCarrier, tx);
    await this.vuelos.modificar(fila, { operadoraId }, tx);
  }

  protected async usosQueImpidenDesactivar(fila: FilaVuelo, tx: Ejecutor): Promise<string[]> {
    return usos(await this.vuelos.contarSalidasProximas(fila, tx), 'upcoming departure');
  }

  protected async motivoQueImpideReactivar(fila: FilaVuelo): Promise<[string, string] | undefined> {
    const inactivos: Array<[string, string, boolean]> = [
      ['marketingCarrier', `Airline ${fila.comercializa.codigo_iata}`, fila.comercializa.activo],
      ['operatingCarrier', `Airline ${fila.opera.codigo_iata}`, fila.opera.activo],
      ['origin', `Airport ${fila.origen.codigo_iata}`, fila.origen.activo],
      ['destination', `Airport ${fila.destino.codigo_iata}`, fila.destino.activo],
    ];
    const inactivo = inactivos.find(([, , activo]) => !activo);
    return inactivo ? [inactivo[0], `${inactivo[1]} is inactive; reactivate it first`] : undefined;
  }

  private async aerolineaActiva(campo: string, codigo: string, tx: Ejecutor): Promise<bigint> {
    const aerolinea = await this.aerolineas.buscar(codigo, tx);
    if (!aerolinea || !aerolinea.activo) {
      throw referenciaInvalida(campo, `Airline ${codigo} does not exist or is inactive`);
    }
    return aerolinea.id;
  }

  private async aeropuertoActivo(campo: string, codigo: string, tx: Ejecutor): Promise<bigint> {
    const aeropuerto = await this.aeropuertos.buscar(codigo, tx);
    if (!aeropuerto || !aeropuerto.activo) {
      throw referenciaInvalida(campo, `Airport ${codigo} does not exist or is inactive`);
    }
    return aeropuerto.id;
  }
}
