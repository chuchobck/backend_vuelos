import { Injectable } from '@nestjs/common';
import { tipo_pasajero } from '../../../../generated/prisma/client';
import { CABINA, TIPO_PASAJERO } from '../../compartido/enums';
import { conflicto, cuerpoInvalido, referenciaInvalida } from '../base/errores-catalogo';
import { Ejecutor } from '../base/repositorio-catalogo';
import { ServicioCatalogo } from '../base/servicio-catalogo';
import { FamiliaTarifaRepository } from '../familia-tarifa/familia-tarifa.repository';
import {
  ESTADOS_DESPEGADO,
  FilaVueloProgramado,
  numeroVueloDeSalida,
  VueloProgramadoRepository,
} from '../vuelo-programado/vuelo-programado.repository';
import { ActualizarTarifaDto, CrearTarifaDto, PrecioPasajeroDto } from './dto/tarifa.dto';
import { FilaTarifa, FiltroTarifa, PrecioNuevo, TarifaRepository } from './tarifa.repository';

/** Una salida en la que todavía se vende: ni cancelada, ni despegada, ni en el pasado. */
function sigueAlaVenta(salida: { estado: FilaVueloProgramado['estado']; salida_programada: Date }) {
  return (
    salida.estado !== 'CANCELADO' &&
    !ESTADOS_DESPEGADO.includes(salida.estado) &&
    salida.salida_programada > new Date()
  );
}

/**
 * Tarifas en venta (tarifa_cabecera) y sus precios por tipo de pasajero (tarifa_detalle, sin
 * controller). La baja deja de venderla y no la bloquea nada: las retenciones ya tomadas
 * guardan su precio congelado (retencion_detalle) y no dependen de esta fila.
 */
@Injectable()
export class TarifaService extends ServicioCatalogo<
  FilaTarifa,
  CrearTarifaDto,
  ActualizarTarifaDto,
  FiltroTarifa
> {
  protected readonly entidad = 'Fare';

  constructor(
    private readonly tarifas: TarifaRepository,
    private readonly salidas: VueloProgramadoRepository,
    private readonly familias: FamiliaTarifaRepository,
  ) {
    super(tarifas);
  }

  /**
   * - La salida sigue a la venta (422).
   * - La familia está activa, es de la aerolínea que comercializa el vuelo y su cabina tiene
   *   cupo en esa salida (422).
   * - La moneda existe y está activa (422). Una segunda tarifa de la misma familia en la
   *   misma salida es 409.
   */
  protected async insertar(dto: CrearTarifaDto, tx: Ejecutor): Promise<string> {
    const precios = validarPrecios(dto.prices, true);
    const salida = await this.salidas.buscar(dto.departureId, tx);
    if (!salida || !sigueAlaVenta(salida)) {
      throw referenciaInvalida(
        'departureId',
        `Departure ${dto.departureId} does not exist or is no longer on sale`,
      );
    }
    const familia = await this.familias.buscar(dto.fareFamilyId, tx);
    if (!familia || !familia.activo) {
      throw referenciaInvalida(
        'fareFamilyId',
        `Fare family ${dto.fareFamilyId} does not exist or is inactive`,
      );
    }
    const comercializa = salida.vuelo.aerolinea_vuelo_aerolinea_idToaerolinea.codigo_iata;
    if (familia.aerolinea.codigo_iata !== comercializa) {
      throw referenciaInvalida(
        'fareFamilyId',
        `The fare family belongs to airline ${familia.aerolinea.codigo_iata}, but flight ` +
          `${numeroVueloDeSalida(salida)} is marketed by ${comercializa}`,
      );
    }
    if (!salida.inventario_cabina.some((c) => c.clase_cabina === familia.clase_cabina)) {
      throw referenciaInvalida(
        'fareFamilyId',
        `The departure has no ${CABINA.aContrato(familia.clase_cabina)} cabin`,
      );
    }
    const moneda = await this.tarifas.buscarMoneda(dto.currency, tx);
    if (!moneda || !moneda.activo) {
      throw referenciaInvalida(
        'currency',
        `Currency ${dto.currency} does not exist or is inactive`,
      );
    }

    return this.tarifas.insertar(
      {
        salidaId: salida.id,
        familiaId: familia.id,
        monedaId: moneda.id,
        precioEquipaje: dto.extraBagPrice,
        cargoCambio: dto.changeFee,
        precios,
      },
      tx,
    );
  }

  /** Los precios de una salida que ya despegó o se canceló no cambian (409). */
  protected async modificar(
    fila: FilaTarifa,
    dto: ActualizarTarifaDto,
    tx: Ejecutor,
  ): Promise<void> {
    if (!sigueAlaVenta(fila.vuelo_programado)) {
      throw conflicto(`Fare ${fila.id_publico} belongs to a departure that is no longer on sale`);
    }
    await this.tarifas.modificar(
      fila,
      {
        precioEquipaje: dto.extraBagPrice,
        cargoCambio: dto.changeFee,
        precios: dto.prices && validarPrecios(dto.prices, false),
      },
      tx,
    );
  }

  protected async usosQueImpidenDesactivar(): Promise<string[]> {
    return [];
  }

  protected async motivoQueImpideReactivar(
    fila: FilaTarifa,
  ): Promise<[string, string] | undefined> {
    if (!sigueAlaVenta(fila.vuelo_programado)) {
      throw conflicto(`Fare ${fila.id_publico} belongs to a departure that is no longer on sale`);
    }
    return fila.familia_tarifa.activo
      ? undefined
      : [
          'fareFamilyId',
          `Fare family ${fila.familia_tarifa.id_publico} is inactive; reactivate it first`,
        ];
  }
}

/** Sin tipos de pasajero repetidos (400) y, al crear, con el precio de adulto. */
function validarPrecios(precios: PrecioPasajeroDto[], exigirAdulto: boolean): PrecioNuevo[] {
  const vistos = new Set<tipo_pasajero>();
  const nuevos = precios.map((precio, i) => {
    const tipo = TIPO_PASAJERO.aBase(precio.passengerType);
    if (vistos.has(tipo)) {
      throw cuerpoInvalido(`prices[${i}].passengerType`, `${precio.passengerType} is repeated`);
    }
    vistos.add(tipo);
    return { tipoPasajero: tipo, tarifaBase: precio.baseFare, impuestos: precio.taxes };
  });
  if (exigirAdulto && !vistos.has('ADULTO')) {
    throw cuerpoInvalido('prices', 'must include the ADULT price');
  }
  return nuevos;
}
