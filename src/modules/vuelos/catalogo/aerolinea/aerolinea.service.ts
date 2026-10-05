import { Injectable } from '@nestjs/common';
import { usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { AerolineaRepository, FilaAerolinea } from './aerolinea.repository';
import { ActualizarAerolineaDto, CrearAerolineaDto } from './dto/aerolinea.dto';

@Injectable()
export class AerolineaService extends ServicioCatalogo<
  FilaAerolinea,
  CrearAerolineaDto,
  ActualizarAerolineaDto
> {
  protected readonly entidad = 'Airline';

  constructor(private readonly aerolineas: AerolineaRepository) {
    super(aerolineas);
  }

  /** Un código o un prefijo de boleto repetido lo rechaza la base (409). */
  protected async insertar(dto: CrearAerolineaDto, tx: Ejecutor): Promise<string> {
    await this.aerolineas.insertar(
      { codigoIata: dto.code, nombre: dto.name, prefijoBoleto: dto.ticketPrefix },
      tx,
    );
    return dto.code;
  }

  protected async modificar(
    fila: FilaAerolinea,
    dto: ActualizarAerolineaDto,
    tx: Ejecutor,
  ): Promise<void> {
    await this.aerolineas.modificar(
      fila,
      { nombre: dto.name, prefijoBoleto: dto.ticketPrefix },
      tx,
    );
  }

  protected async usosQueImpidenDesactivar(fila: FilaAerolinea, tx: Ejecutor): Promise<string[]> {
    const { vuelos, familias, mapas } = await this.aerolineas.contarUsosActivos(fila, tx);
    return [
      ...usos(vuelos, 'active flight'),
      ...usos(familias, 'active fare family', 'active fare families'),
      ...usos(mapas, 'active seat map'),
    ];
  }
}
