import { Injectable } from '@nestjs/common';
import { clase_cabina } from '../../../../generated/prisma/client';
import { CABINA, ESTADO_VUELO } from '../../compartido/enums';
import { conflicto, cuerpoInvalido, referenciaInvalida, usos } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { asientosPorCabina } from '../mapa-asientos/mapa-asientos.mapper';
import { MapaAsientosRepository } from '../mapa-asientos/mapa-asientos.repository';
import { VueloRepository } from '../vuelo/vuelo.repository';
import {
  ActualizarVueloProgramadoDto,
  CrearVueloProgramadoDto,
  CupoCabinaDto,
} from './dto/vuelo-programado.dto';
import {
  CambiosSalida,
  CupoNuevo,
  ESTADOS_DESPEGADO,
  FilaVueloProgramado,
  FiltroVueloProgramado,
  numeroVueloDeSalida,
  VueloProgramadoRepository,
} from './vuelo-programado.repository';

/**
 * Fecha local de un instante en una zona horaria IANA, a medianoche UTC como un `date` de la
 * base. Es vuelo_programado.fecha_salida: la fecha en el aeropuerto de origen.
 */
export function fechaLocal(instante: Date, zonaHoraria: string): Date {
  const texto = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instante);
  return new Date(`${texto}T00:00:00.000Z`);
}

/** undefined: no cambia; null: se borra; texto: el instante. */
function instanteONulo(valor: string | null | undefined): Date | null | undefined {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  return new Date(valor);
}

/**
 * Salidas programadas y sus cupos por cabina (inventario_cabina, que no tiene controller).
 *
 * Reglas que el esquema no hace cumplir por sí solo y se aplican aquí:
 * - El mapa de asientos es de la aerolínea que opera el vuelo.
 * - Cada cabina con cupo existe en el mapa y su cupo no supera los asientos físicos.
 * - La fecha local de salida se calcula con la zona horaria de la ciudad de origen.
 * - Un cupo nunca baja de lo ya retenido o vendido (UPDATE condicionado en el repository).
 * - Cancelar (la baja) exige que no haya despegado ni tenga retenciones o reservas vigentes.
 */
@Injectable()
export class VueloProgramadoService extends ServicioCatalogo<
  FilaVueloProgramado,
  CrearVueloProgramadoDto,
  ActualizarVueloProgramadoDto,
  FiltroVueloProgramado
> {
  protected readonly entidad = 'Departure';
  protected readonly verboBaja = 'cancelled';

  constructor(
    private readonly salidas: VueloProgramadoRepository,
    private readonly vuelos: VueloRepository,
    private readonly mapas: MapaAsientosRepository,
  ) {
    super(salidas);
  }

  protected async insertar(dto: CrearVueloProgramadoDto, tx: Ejecutor): Promise<string> {
    const salida = new Date(dto.scheduledDeparture);
    const llegada = new Date(dto.scheduledArrival);
    validarHorario(salida, llegada);
    if (salida <= new Date()) {
      throw referenciaInvalida('scheduledDeparture', 'The departure must be in the future');
    }

    const vuelo = await this.vuelos.buscar(dto.flightNumber, tx);
    if (!vuelo || !vuelo.activo) {
      throw referenciaInvalida(
        'flightNumber',
        `Flight ${dto.flightNumber} does not exist or is inactive`,
      );
    }
    const mapa = await this.mapas.buscar(dto.seatMapId, tx);
    if (!mapa || !mapa.activo) {
      throw referenciaInvalida(
        'seatMapId',
        `Seat map ${dto.seatMapId} does not exist or is inactive`,
      );
    }
    if (mapa.aerolinea.codigo_iata !== vuelo.opera.codigo_iata) {
      throw referenciaInvalida(
        'seatMapId',
        `The seat map belongs to airline ${mapa.aerolinea.codigo_iata}, but flight ` +
          `${dto.flightNumber} is operated by ${vuelo.opera.codigo_iata}`,
      );
    }

    const fisicos = asientosPorCabina(mapa);
    const cupos = dto.cabins
      ? validarCupos(dto.cabins, fisicos)
      : [...fisicos].map(([claseCabina, total]) => ({ claseCabina, total }));

    return this.salidas.insertar(
      {
        vueloId: vuelo.id,
        mapaId: mapa.id,
        fechaSalida: fechaLocal(salida, vuelo.origen.ciudad.zona_horaria),
        salidaProgramada: salida,
        llegadaProgramada: llegada,
        terminalSalida: dto.departureTerminal,
        terminalLlegada: dto.arrivalTerminal,
        cupos,
      },
      tx,
    );
  }

  protected async modificar(
    fila: FilaVueloProgramado,
    dto: ActualizarVueloProgramadoDto,
    tx: Ejecutor,
  ): Promise<void> {
    const id = fila.id;
    if (fila.estado === 'CANCELADO') {
      throw conflicto(`Departure ${id} is cancelled; reactivate it first`);
    }
    const despego = ESTADOS_DESPEGADO.includes(fila.estado);
    const cambiaHorario =
      dto.scheduledDeparture !== undefined || dto.scheduledArrival !== undefined;
    if (despego && (cambiaHorario || dto.cabins !== undefined)) {
      throw conflicto(
        `Departure ${id} has already departed: its schedule and seat quotas can no longer change`,
      );
    }

    const cambios: CambiosSalida = {
      salidaEstimada: instanteONulo(dto.estimatedDeparture),
      llegadaEstimada: instanteONulo(dto.estimatedArrival),
      salidaReal: instanteONulo(dto.actualDeparture),
      llegadaReal: instanteONulo(dto.actualArrival),
      terminalSalida: dto.departureTerminal,
      terminalLlegada: dto.arrivalTerminal,
      estado: dto.status === undefined ? undefined : ESTADO_VUELO.aBase(dto.status),
    };

    if (cambiaHorario) {
      const salida = dto.scheduledDeparture
        ? new Date(dto.scheduledDeparture)
        : fila.salida_programada;
      const llegada = dto.scheduledArrival
        ? new Date(dto.scheduledArrival)
        : fila.llegada_programada;
      validarHorario(salida, llegada);
      if (dto.scheduledDeparture && salida <= new Date()) {
        throw referenciaInvalida('scheduledDeparture', 'The departure must be in the future');
      }
      cambios.salidaProgramada = salida;
      cambios.llegadaProgramada = llegada;
      cambios.fechaSalida = fechaLocal(
        salida,
        fila.vuelo.aeropuerto_vuelo_aeropuerto_origen_idToaeropuerto.ciudad.zona_horaria,
      );
    }

    await this.salidas.modificar(fila, cambios, tx);
    if (dto.cabins) await this.cambiarCupos(fila, dto.cabins, tx);
  }

  /**
   * Las cabinas que ya tienen cupo se ajustan sin perder lo retenido o vendido; las que no,
   * se agregan. Las que no vienen en la petición no cambian (un cupo no se borra: se pone en 0).
   */
  private async cambiarCupos(
    fila: FilaVueloProgramado,
    cabinas: CupoCabinaDto[],
    tx: Ejecutor,
  ): Promise<void> {
    const mapa = await this.mapas.buscar(fila.mapa_asientos_cabecera.id_publico, tx);
    const cupos = validarCupos(cabinas, asientosPorCabina(mapa));
    const existentes = new Map(fila.inventario_cabina.map((c) => [c.clase_cabina, c]));

    for (const cupo of cupos) {
      const actual = existentes.get(cupo.claseCabina);
      if (!actual) {
        await this.salidas.agregarCupo(fila.id, cupo, tx);
      } else if (!(await this.salidas.ajustarCupo(fila.id, cupo.claseCabina, cupo.total, tx))) {
        const comprometidos = actual.cupos_totales - actual.cupos_disponibles;
        throw conflicto(
          `Cabin ${CABINA.aContrato(cupo.claseCabina)} already has ${comprometidos} seats held ` +
            `or sold; its quota cannot be lower than that`,
        );
      }
    }
  }

  /** La baja de una salida es cancelarla: no si ya despegó o si alguien la tiene retenida o comprada. */
  protected async usosQueImpidenDesactivar(
    fila: FilaVueloProgramado,
    tx: Ejecutor,
  ): Promise<string[]> {
    if (ESTADOS_DESPEGADO.includes(fila.estado) || fila.salida_real !== null) {
      throw conflicto(`Departure ${fila.id} has already departed and cannot be cancelled`);
    }
    const { retenciones, reservas } = await this.salidas.contarCompromisos(fila, tx);
    return [...usos(retenciones, 'active hold'), ...usos(reservas, 'active booking')];
  }

  protected async motivoQueImpideReactivar(
    fila: FilaVueloProgramado,
  ): Promise<[string, string] | undefined> {
    if (fila.salida_programada <= new Date()) {
      throw conflicto(`Departure ${fila.id} was scheduled in the past and cannot be reactivated`);
    }
    if (!fila.vuelo.activo) {
      return [
        'flightNumber',
        `Flight ${numeroVueloDeSalida(fila)} is inactive; reactivate it first`,
      ];
    }
    if (!fila.mapa_asientos_cabecera.activo) {
      return [
        'seatMapId',
        `Seat map ${fila.mapa_asientos_cabecera.id_publico} is inactive; reactivate it first`,
      ];
    }
    return undefined;
  }
}

function validarHorario(salida: Date, llegada: Date): void {
  if (llegada <= salida) {
    throw cuerpoInvalido('scheduledArrival', 'must be after scheduledDeparture');
  }
}

/** Sin cabinas repetidas (400); cada una existe en el mapa y no supera sus asientos (422). */
function validarCupos(cabinas: CupoCabinaDto[], fisicos: Map<clase_cabina, number>): CupoNuevo[] {
  const vistas = new Set<clase_cabina>();
  return cabinas.map((cabina, i) => {
    const claseCabina = CABINA.aBase(cabina.cabinClass);
    if (vistas.has(claseCabina)) {
      throw cuerpoInvalido(`cabins[${i}].cabinClass`, `${cabina.cabinClass} is repeated`);
    }
    vistas.add(claseCabina);
    const asientos = fisicos.get(claseCabina);
    if (asientos === undefined) {
      throw referenciaInvalida(
        `cabins[${i}].cabinClass`,
        `The seat map has no ${cabina.cabinClass} cabin`,
      );
    }
    if (cabina.totalSeats > asientos) {
      throw referenciaInvalida(
        `cabins[${i}].totalSeats`,
        `The ${cabina.cabinClass} cabin has ${asientos} seats; the quota cannot exceed them`,
      );
    }
    return { claseCabina, total: cabina.totalSeats };
  });
}
