import { Injectable } from '@nestjs/common';
import { usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { ActualizarModeloAeronaveDto, CrearModeloAeronaveDto } from './dto/modelo-aeronave.dto';
import { FilaModeloAeronave, ModeloAeronaveRepository } from './modelo-aeronave.repository';

@Injectable()
export class ModeloAeronaveService extends ServicioCatalogo<
  FilaModeloAeronave,
  CrearModeloAeronaveDto,
  ActualizarModeloAeronaveDto
> {
  protected readonly entidad = 'Aircraft model';

  constructor(private readonly modelos: ModeloAeronaveRepository) {
    super(modelos);
  }

  protected async insertar(dto: CrearModeloAeronaveDto, tx: Ejecutor): Promise<string> {
    await this.modelos.insertar({ codigoIata: dto.code, nombre: dto.name }, tx);
    return dto.code;
  }

  protected async modificar(
    fila: FilaModeloAeronave,
    dto: ActualizarModeloAeronaveDto,
    tx: Ejecutor,
  ): Promise<void> {
    await this.modelos.modificar(fila, { nombre: dto.name }, tx);
  }

  protected async usosQueImpidenDesactivar(
    fila: FilaModeloAeronave,
    tx: Ejecutor,
  ): Promise<string[]> {
    return usos(await this.modelos.contarMapasActivos(fila, tx), 'active seat map');
  }
}
