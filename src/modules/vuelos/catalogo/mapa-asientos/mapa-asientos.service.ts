import { Injectable } from '@nestjs/common';
import { CABINA, POSICION_ASIENTO } from '../../compartido/enums';
import { AerolineaRepository } from '../aerolinea/aerolinea.repository';
import { cuerpoInvalido, referenciaInvalida, usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { ModeloAeronaveRepository } from '../modelo-aeronave/modelo-aeronave.repository';
import {
  ActualizarMapaAsientosDto,
  CrearMapaAsientosDto,
  FilaAsientosDto,
} from './dto/mapa-asientos.dto';
import {
  FilaMapaAsientos,
  FilaNueva,
  FiltroMapaAsientos,
  MapaAsientosRepository,
} from './mapa-asientos.repository';

@Injectable()
export class MapaAsientosService extends ServicioCatalogo<
  FilaMapaAsientos,
  CrearMapaAsientosDto,
  ActualizarMapaAsientosDto,
  FiltroMapaAsientos
> {
  protected readonly entidad = 'Seat map';

  constructor(
    private readonly mapas: MapaAsientosRepository,
    private readonly aerolineas: AerolineaRepository,
    private readonly modelos: ModeloAeronaveRepository,
  ) {
    super(mapas);
  }

  /**
   * Aerolínea y modelo deben estar activos (422). El nombre es único por aerolínea y modelo
   * (409). Las filas y los asientos se crean en la misma transacción que la cabecera.
   */
  protected async insertar(dto: CrearMapaAsientosDto, tx: Ejecutor): Promise<string> {
    const filas = validarDistribucion(dto.rows);
    const aerolinea = await this.aerolineas.buscar(dto.airline, tx);
    if (!aerolinea || !aerolinea.activo) {
      throw referenciaInvalida('airline', `Airline ${dto.airline} does not exist or is inactive`);
    }
    const modelo = await this.modelos.buscar(dto.aircraftModel, tx);
    if (!modelo || !modelo.activo) {
      throw referenciaInvalida(
        'aircraftModel',
        `Aircraft model ${dto.aircraftModel} does not exist or is inactive`,
      );
    }
    return this.mapas.insertar(
      { aerolineaId: aerolinea.id, modeloId: modelo.id, nombre: dto.name, filas },
      tx,
    );
  }

  protected async modificar(
    fila: FilaMapaAsientos,
    dto: ActualizarMapaAsientosDto,
    tx: Ejecutor,
  ): Promise<void> {
    await this.mapas.modificar(fila, { nombre: dto.name }, tx);
  }

  protected async usosQueImpidenDesactivar(
    fila: FilaMapaAsientos,
    tx: Ejecutor,
  ): Promise<string[]> {
    return usos(await this.mapas.contarSalidasProximas(fila, tx), 'upcoming departure');
  }

  protected async motivoQueImpideReactivar(
    fila: FilaMapaAsientos,
  ): Promise<[string, string] | undefined> {
    if (!fila.aerolinea.activo) {
      return ['airline', `Airline ${fila.aerolinea.codigo_iata} is inactive; reactivate it first`];
    }
    if (!fila.modelo_aeronave.activo) {
      return [
        'aircraftModel',
        `Aircraft model ${fila.modelo_aeronave.codigo_iata} is inactive; reactivate it first`,
      ];
    }
    return undefined;
  }
}

/** Sin filas repetidas ni letras repetidas dentro de una fila (400); a valores de la base. */
function validarDistribucion(filas: FilaAsientosDto[]): FilaNueva[] {
  const numeros = new Set<number>();
  return filas.map((fila, i) => {
    if (numeros.has(fila.number)) {
      throw cuerpoInvalido(`rows[${i}].number`, `row ${fila.number} is repeated`);
    }
    numeros.add(fila.number);
    const letras = new Set<string>();
    for (const [j, asiento] of fila.seats.entries()) {
      if (letras.has(asiento.letter)) {
        throw cuerpoInvalido(
          `rows[${i}].seats[${j}].letter`,
          `seat ${fila.number}${asiento.letter} is repeated`,
        );
      }
      letras.add(asiento.letter);
    }
    return {
      numero: fila.number,
      claseCabina: CABINA.aBase(fila.cabinClass),
      espacioExtra: fila.extraLegroom ?? false,
      salidaEmergencia: fila.emergencyExit ?? false,
      asientos: fila.seats.map((a) => ({
        letra: a.letter,
        posicion: POSICION_ASIENTO.aBase(a.position),
      })),
    };
  });
}
