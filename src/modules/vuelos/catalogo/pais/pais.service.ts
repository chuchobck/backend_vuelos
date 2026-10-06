import { Injectable } from '@nestjs/common';
import { usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { ActualizarPaisDto, CrearPaisDto } from './dto/pais.dto';
import { FilaPais, PaisRepository } from './pais.repository';

@Injectable()
export class PaisService extends ServicioCatalogo<FilaPais, CrearPaisDto, ActualizarPaisDto> {
  protected readonly entidad = 'Country';

  constructor(private readonly paises: PaisRepository) {
    super(paises);
  }

  /** Un código repetido lo rechaza la base (uq_pais_*) y el filtro lo responde como 409. */
  protected async insertar(dto: CrearPaisDto, tx: Ejecutor): Promise<string> {
    await this.paises.insertar(
      { codigoIso2: dto.code, codigoIso3: dto.iso3, nombre: dto.name },
      tx,
    );
    return dto.code;
  }

  protected async modificar(fila: FilaPais, dto: ActualizarPaisDto, tx: Ejecutor): Promise<void> {
    await this.paises.modificar(fila, { nombre: dto.name }, tx);
  }

  protected async usosQueImpidenDesactivar(fila: FilaPais, tx: Ejecutor): Promise<string[]> {
    return usos(await this.paises.contarCiudadesActivas(fila, tx), 'active city', 'active cities');
  }
}
