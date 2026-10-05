import { Injectable } from '@nestjs/common';
import { referenciaInvalida, usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { CiudadRepository } from '../ciudad/ciudad.repository';
import { AeropuertoRepository, FilaAeropuerto, FiltroAeropuerto } from './aeropuerto.repository';
import { ActualizarAeropuertoDto, CrearAeropuertoDto } from './dto/aeropuerto.dto';

@Injectable()
export class AeropuertoService extends ServicioCatalogo<
  FilaAeropuerto,
  CrearAeropuertoDto,
  ActualizarAeropuertoDto,
  FiltroAeropuerto
> {
  protected readonly entidad = 'Airport';

  constructor(
    private readonly aeropuertos: AeropuertoRepository,
    private readonly ciudades: CiudadRepository,
  ) {
    super(aeropuertos);
  }

  protected async insertar(dto: CrearAeropuertoDto, tx: Ejecutor): Promise<string> {
    const ciudadId = await this.ciudadActiva(dto.cityId, tx);
    await this.aeropuertos.insertar({ codigoIata: dto.code, nombre: dto.name, ciudadId }, tx);
    return dto.code;
  }

  protected async modificar(
    fila: FilaAeropuerto,
    dto: ActualizarAeropuertoDto,
    tx: Ejecutor,
  ): Promise<void> {
    const ciudadId = dto.cityId === undefined ? undefined : await this.ciudadActiva(dto.cityId, tx);
    await this.aeropuertos.modificar(fila, { nombre: dto.name, ciudadId }, tx);
  }

  protected async usosQueImpidenDesactivar(fila: FilaAeropuerto, tx: Ejecutor): Promise<string[]> {
    return usos(await this.aeropuertos.contarVuelosActivos(fila, tx), 'active flight');
  }

  protected async motivoQueImpideReactivar(
    fila: FilaAeropuerto,
  ): Promise<[string, string] | undefined> {
    return fila.ciudad.activo
      ? undefined
      : ['cityId', `City ${fila.ciudad.id_publico} is inactive; reactivate it first`];
  }

  private async ciudadActiva(id: string, tx: Ejecutor): Promise<bigint> {
    const ciudad = await this.ciudades.buscar(id, tx);
    if (!ciudad || !ciudad.activo) {
      throw referenciaInvalida('cityId', `City ${id} does not exist or is inactive`);
    }
    return ciudad.id;
  }
}
