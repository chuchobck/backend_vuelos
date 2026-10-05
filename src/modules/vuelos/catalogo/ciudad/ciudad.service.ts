import { Injectable } from '@nestjs/common';
import { referenciaInvalida, usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { PaisRepository } from '../pais/pais.repository';
import { CiudadRepository, FilaCiudad, FiltroCiudad } from './ciudad.repository';
import { ActualizarCiudadDto, CrearCiudadDto } from './dto/ciudad.dto';

@Injectable()
export class CiudadService extends ServicioCatalogo<
  FilaCiudad,
  CrearCiudadDto,
  ActualizarCiudadDto,
  FiltroCiudad
> {
  protected readonly entidad = 'City';

  constructor(
    private readonly ciudades: CiudadRepository,
    private readonly paises: PaisRepository,
  ) {
    super(ciudades);
  }

  /** El país debe existir y estar activo (422). Un nombre repetido en el país es 409. */
  protected async insertar(dto: CrearCiudadDto, tx: Ejecutor): Promise<string> {
    const pais = await this.paises.buscar(dto.country, tx);
    if (!pais || !pais.activo) {
      throw referenciaInvalida('country', `Country ${dto.country} does not exist or is inactive`);
    }
    return this.ciudades.insertar(
      { paisId: pais.id, nombre: dto.name, zonaHoraria: dto.timeZone },
      tx,
    );
  }

  protected async modificar(
    fila: FilaCiudad,
    dto: ActualizarCiudadDto,
    tx: Ejecutor,
  ): Promise<void> {
    await this.ciudades.modificar(fila, { nombre: dto.name, zonaHoraria: dto.timeZone }, tx);
  }

  protected async usosQueImpidenDesactivar(fila: FilaCiudad, tx: Ejecutor): Promise<string[]> {
    return usos(await this.ciudades.contarAeropuertosActivos(fila, tx), 'active airport');
  }

  protected async motivoQueImpideReactivar(
    fila: FilaCiudad,
  ): Promise<[string, string] | undefined> {
    return fila.pais.activo
      ? undefined
      : ['country', `Country ${fila.pais.codigo_iso2} is inactive; reactivate it first`];
  }
}
