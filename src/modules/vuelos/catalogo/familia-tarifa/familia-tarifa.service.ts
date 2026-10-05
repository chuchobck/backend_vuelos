import { Injectable } from '@nestjs/common';
import { CABINA } from '../../compartido/enums';
import { AerolineaRepository } from '../aerolinea/aerolinea.repository';
import { referenciaInvalida, usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { ActualizarFamiliaTarifaDto, CrearFamiliaTarifaDto } from './dto/familia-tarifa.dto';
import {
  FamiliaTarifaRepository,
  FilaFamiliaTarifa,
  FiltroFamiliaTarifa,
  ReglasFamilia,
} from './familia-tarifa.repository';

function aReglas(dto: ActualizarFamiliaTarifaDto): ReglasFamilia {
  return {
    nombre: dto.name,
    esCambiable: dto.changeable,
    porcentajePenalidad: dto.cancellationPenaltyPercent,
    incluyeArticuloPersonal: dto.personalItemIncluded,
    equipajeMano: dto.carryOnBagsIncluded,
    equipajeBodega: dto.checkedBagsIncluded,
    maximoAdicional: dto.maxExtraBags,
  };
}

@Injectable()
export class FamiliaTarifaService extends ServicioCatalogo<
  FilaFamiliaTarifa,
  CrearFamiliaTarifaDto,
  ActualizarFamiliaTarifaDto,
  FiltroFamiliaTarifa
> {
  protected readonly entidad = 'Fare family';

  constructor(
    private readonly familias: FamiliaTarifaRepository,
    private readonly aerolineas: AerolineaRepository,
  ) {
    super(familias);
  }

  /** La aerolínea debe estar activa (422); aerolínea + cabina + código repetidos es 409. */
  protected async insertar(dto: CrearFamiliaTarifaDto, tx: Ejecutor): Promise<string> {
    const aerolinea = await this.aerolineas.buscar(dto.airline, tx);
    if (!aerolinea || !aerolinea.activo) {
      throw referenciaInvalida('airline', `Airline ${dto.airline} does not exist or is inactive`);
    }
    return this.familias.insertar(
      {
        ...aReglas(dto),
        aerolineaId: aerolinea.id,
        claseCabina: CABINA.aBase(dto.cabinClass),
        codigo: dto.code,
        nombre: dto.name,
        esCambiable: dto.changeable,
      },
      tx,
    );
  }

  protected async modificar(
    fila: FilaFamiliaTarifa,
    dto: ActualizarFamiliaTarifaDto,
    tx: Ejecutor,
  ): Promise<void> {
    await this.familias.modificar(fila, aReglas(dto), tx);
  }

  protected async usosQueImpidenDesactivar(
    fila: FilaFamiliaTarifa,
    tx: Ejecutor,
  ): Promise<string[]> {
    return usos(
      await this.familias.contarTarifasEnVenta(fila, tx),
      'active fare on an upcoming departure',
      'active fares on upcoming departures',
    );
  }

  protected async motivoQueImpideReactivar(
    fila: FilaFamiliaTarifa,
  ): Promise<[string, string] | undefined> {
    return fila.aerolinea.activo
      ? undefined
      : ['airline', `Airline ${fila.aerolinea.codigo_iata} is inactive; reactivate it first`];
  }
}
