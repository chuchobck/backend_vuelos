import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { CodigoError, CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { Prisma, tipo_pasajero } from '../../../../generated/prisma/client';
import { CABINA, ORDEN_CABINAS } from '../../compartido/enums';
import { cuerpoInvalido } from '../../compartido/errores';
import { asientosOcupados, ConteoPasajeros, validarPasajeros } from '../../compartido/pasajeros';
import { RetencionCreadaDto } from './dto/respuesta-retencion.dto';
import { SolicitudRetencionDto } from './dto/solicitud-retencion.dto';
import { aRetencionCreada, aRetencionRepetida } from './retencion.mapper';
import {
  ClaveGuardada,
  CupoDeCabina,
  FamiliaDeOferta,
  FilaPrecioActual,
  OfertaParaRetener,
  RetencionNueva,
  RetencionRepository,
} from './retencion.repository';

/** Reglas del hold. */
export const REGLAS_RETENCION = {
  /** Vigencia de un hold si HOLD_TTL_MINUTES no dice otra cosa. */
  vigenciaPorDefectoMinutos: 15,
  /**
   * Cuánto se recuerda una Idempotency-Key de POST /offers/hold. Cubre de sobra los reintentos
   * de un cliente (y la vida del hold); pasado ese plazo, la misma clave vale como nueva.
   */
  vigenciaClaveHoras: 24,
  /** Retenciones vencidas que se liberan, como mucho, antes de competir por un cupo. */
  vencidasPorPeticion: 50,
};

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const CERO = new Prisma.Decimal(0);

/** Lo que responde POST /offers/hold: el cuerpo del 201 y si es la repetición de uno anterior. */
export interface ResultadoCreacion {
  cuerpo: RetencionCreadaDto;
  repetida: boolean;
}

/** Una selección del cuerpo ya resuelta contra la oferta y el catálogo. */
interface SeleccionResuelta {
  itinerarioId: string;
  salidas: string[];
  familia: FamiliaDeOferta;
}

/** 409 OFFER_NO_LONGER_AVAILABLE, el único código del contrato para "ya no se puede retener". */
const noDisponible = (detalle: string) =>
  new ErrorNegocio(409, CodigoError.OFFER_NO_LONGER_AVAILABLE, detalle);

/** 422: el cuerpo es válido, pero no corresponde a la oferta. */
const noCorresponde = (campo: string, detalle: string) =>
  new ErrorNegocio(422, CODIGO_SIN_EQUIVALENTE, detalle, {
    invalidParams: [{ name: campo, reason: detalle }],
  });

/**
 * Retenciones (hold): toman cupo con el precio de hoy congelado por HOLD_TTL_MINUTES.
 *
 * POST /offers/hold es idempotente por usuario y clave: la misma clave con el mismo cuerpo
 * devuelve la misma respuesta (201, el mismo holdId) sin crear otra retención; con otro cuerpo,
 * 422. La primera respuesta se guarda en clave_idempotencia, en la misma transacción que crea
 * la retención.
 */
@Injectable()
export class RetencionService {
  private readonly logger = new Logger(RetencionService.name);
  private readonly vigenciaMinutos: number;

  constructor(
    private readonly repositorio: RetencionRepository,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.vigenciaMinutos =
      config.get<number>('HOLD_TTL_MINUTES') ?? REGLAS_RETENCION.vigenciaPorDefectoMinutos;
  }

  async crear(
    solicitud: SolicitudRetencionDto,
    idPropietario: string,
    clave: string,
  ): Promise<ResultadoCreacion> {
    const ahora = this.reloj.ahora();
    const huella = huellaDe(solicitud);
    const idClave = { idPropietario, operacion: 'CREAR_RETENCION' as const, clave };

    const previa = await this.repositorio.leerClave(idPropietario, 'CREAR_RETENCION', clave);
    if (previa && previa.vence > ahora) return repetir(previa, huella);
    if (previa) await this.repositorio.borrarClavesVencidas(ahora, idClave);

    const pasajeros = validarPasajeros(solicitud.passengersBreakdown, 'passengersBreakdown');
    const oferta = await this.repositorio.oferta(solicitud.offerId);
    if (!oferta || oferta.vence <= ahora) {
      throw noDisponible(`Offer ${solicitud.offerId} was not found or has expired`);
    }
    const selecciones = await this.resolver(solicitud, oferta);
    const precios = await this.repositorio.preciosActuales(
      selecciones.flatMap((s) => s.salidas),
      selecciones.map((s) => s.familia.id),
      pasajeros.map((p) => p.tipo),
      ahora,
    );
    const { monedaId, lineas } = congelar(selecciones, precios, pasajeros);
    const cupos = cuposDe(selecciones, asientosOcupados(pasajeros));

    // Antes de competir por el cupo, se devuelve el de las retenciones ya vencidas de esas
    // salidas que el proceso periódico todavía no liberó.
    await this.vencerEnSalidas(
      cupos.map((c) => c.salidaId),
      ahora,
    );

    const id = randomUUID();
    const vence = new Date(ahora.getTime() + this.vigenciaMinutos * MINUTO);
    const cuerpo = aRetencionCreada({
      id,
      vence,
      vigenciaMinutos: this.vigenciaMinutos,
      precio: {
        moneda: lineas[0].moneda,
        base: sumar(lineas.map((l) => l.base)),
        impuestos: sumar(lineas.map((l) => l.impuestos)),
        total: sumar(lineas.map((l) => l.base.plus(l.impuestos))),
      },
    });
    const conteo = (tipo: tipo_pasajero) => pasajeros.find((p) => p.tipo === tipo)?.cantidad ?? 0;
    const retencion: RetencionNueva = {
      id,
      ofertaId: solicitud.offerId,
      idPropietario,
      monedaId,
      adultos: conteo('ADULTO'),
      jovenes: conteo('JOVEN'),
      ninos: conteo('NINO'),
      infantes: conteo('INFANTE'),
      creada: ahora,
      vence,
      lineas,
      cupos,
    };

    const rechazo = await this.repositorio.crear(retencion, {
      ...idClave,
      huella,
      codigoHttp: 201,
      respuesta: { ...cuerpo, lockedPrice: { ...cuerpo.lockedPrice } },
      creada: ahora,
      vence: new Date(ahora.getTime() + REGLAS_RETENCION.vigenciaClaveHoras * HORA),
    });
    if (rechazo === null) return { cuerpo, repetida: false };

    switch (rechazo) {
      case 'clave-en-uso': {
        // Otra petición con la misma clave terminó primero: se responde lo mismo que a ella.
        const ganadora = await this.repositorio.leerClave(idPropietario, 'CREAR_RETENCION', clave);
        if (!ganadora) throw claveEnCurso();
        return repetir(ganadora, huella);
      }
      case 'oferta-vencida':
        throw noDisponible(`Offer ${solicitud.offerId} was not found or has expired`);
      case 'sin-cupo':
        throw noDisponible('There are not enough seats left for all passengers on every segment');
    }
  }

  /**
   * Cada selección apunta a un itinerario distinto de la oferta (400 si se repite, 422 si no
   * es de la oferta), la oferta queda cubierta entera (422) y cabinClass + fareBrand es una
   * familia de la aerolínea de la oferta (422 si no existe; 409 si está dada de baja).
   */
  private async resolver(
    solicitud: SolicitudRetencionDto,
    oferta: OfertaParaRetener,
  ): Promise<SeleccionResuelta[]> {
    const vistos = new Set<string>();
    solicitud.itinerarySelections.forEach((s, i) => {
      if (vistos.has(s.itineraryId)) {
        throw cuerpoInvalido(`itinerarySelections[${i}].itineraryId`, 'is repeated');
      }
      vistos.add(s.itineraryId);
      if (!oferta.itinerarios.some((it) => it.id === s.itineraryId)) {
        throw noCorresponde(
          `itinerarySelections[${i}].itineraryId`,
          `Itinerary ${s.itineraryId} is not part of offer ${solicitud.offerId}`,
        );
      }
    });
    if (vistos.size !== oferta.itinerarios.length) {
      throw noCorresponde(
        'itinerarySelections',
        `Offer ${solicitud.offerId} has ${oferta.itinerarios.length} itineraries; select one ` +
          'pricing option for each of them',
      );
    }

    const pedidas = solicitud.itinerarySelections.map((s) => ({
      cabina: CABINA.aBase(s.cabinClass),
      codigo: s.fareBrand,
    }));
    const familias = await this.repositorio.familias(oferta.aerolineaId, pedidas);

    // En el orden de la oferta, no en el del cuerpo: así el precio y las líneas no dependen de él.
    return oferta.itinerarios.map((itinerario) => {
      const i = solicitud.itinerarySelections.findIndex((s) => s.itineraryId === itinerario.id);
      const { cabina, codigo } = pedidas[i];
      const familia = familias.find((f) => f.cabina === cabina && f.codigo === codigo);
      const opcion = `${CABINA.aContrato(cabina)} ${codigo}`;
      if (!familia) {
        throw noCorresponde(
          `itinerarySelections[${i}].fareBrand`,
          `${opcion} is not a fare brand of the offer's airline`,
        );
      }
      if (!familia.activo) throw noDisponible(`${opcion} is no longer sold`);
      return { itinerarioId: itinerario.id, salidas: itinerario.salidas, familia };
    });
  }

  /** Libera (sin fallar la petición) las retenciones vencidas que tienen cupo en esas salidas. */
  private async vencerEnSalidas(salidas: string[], ahora: Date): Promise<void> {
    try {
      for (let i = 0; i < REGLAS_RETENCION.vencidasPorPeticion; i++) {
        if ((await this.repositorio.vencerSiguiente(ahora, salidas)) === null) return;
      }
    } catch (error) {
      this.logger.warn(`No se pudieron vencer las retenciones: ${(error as Error).name}`);
    }
  }
}

/**
 * SHA-256 (hexadecimal) del cuerpo ya validado y con los valores por defecto puestos, con las
 * claves en un orden fijo: `{}` y `{"adults": 1}` en passengersBreakdown son la misma petición.
 */
function huellaDe(solicitud: SolicitudRetencionDto): string {
  const p = solicitud.passengersBreakdown;
  const canonica = {
    offerId: solicitud.offerId.toLowerCase(),
    itinerarySelections: solicitud.itinerarySelections.map((s) => ({
      itineraryId: s.itineraryId.toLowerCase(),
      cabinClass: s.cabinClass,
      fareBrand: s.fareBrand,
    })),
    passengersBreakdown: {
      adults: p.adults ?? 1,
      youths: p.youths ?? 0,
      children: p.children ?? 0,
      infants: p.infants ?? 0,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonica)).digest('hex');
}

/** La respuesta guardada con la clave, si el cuerpo es el mismo; si no, 422. */
function repetir(previa: ClaveGuardada, huella: string): ResultadoCreacion {
  if (previa.huella !== huella) {
    throw new ErrorNegocio(
      422,
      CODIGO_SIN_EQUIVALENTE,
      'This Idempotency-Key was already used with a different request body',
      { invalidParams: [{ name: 'Idempotency-Key', reason: 'already used with another body' }] },
    );
  }
  if (previa.codigoHttp !== 201 || previa.respuesta === null) throw claveEnCurso();
  const guardada = previa.respuesta as unknown as RetencionCreadaDto;
  return { cuerpo: aRetencionRepetida(guardada), repetida: true };
}

/** No debería pasar: la clave se guarda con su respuesta en la misma transacción. */
const claveEnCurso = () =>
  new ErrorNegocio(
    409,
    CODIGO_SIN_EQUIVALENTE,
    'A request with this Idempotency-Key is in progress',
    {
      cabeceras: { 'Retry-After': '1' },
    },
  );

/**
 * El precio de hoy de cada itinerario para todos los pasajeros: la suma, por segmento y por
 * tipo de pasajero, de la tarifa vigente por la cantidad pedida (la misma cuenta que la
 * búsqueda). Si a un segmento le falta la tarifa de un tipo, o la salida ya no se vende, 409.
 * Todo el hold va en una moneda.
 */
function congelar(
  selecciones: SeleccionResuelta[],
  precios: FilaPrecioActual[],
  pasajeros: ConteoPasajeros,
) {
  const lineas = selecciones.map((seleccion) => {
    let base = CERO;
    let impuestos = CERO;
    let moneda: { id: bigint; codigo: string } | undefined;
    for (const salida of seleccion.salidas) {
      for (const { tipo, cantidad } of pasajeros) {
        const fila = precios.find(
          (p) =>
            p.salida_id === salida &&
            p.familia_id === seleccion.familia.id &&
            p.tipo_pasajero === tipo,
        );
        if (!fila) {
          throw noDisponible(
            `${CABINA.aContrato(seleccion.familia.cabina)} ${seleccion.familia.codigo} is no ` +
              `longer sold on every segment of itinerary ${seleccion.itinerarioId}`,
          );
        }
        if (moneda && moneda.id !== fila.moneda_id) throw monedasDistintas();
        moneda = { id: fila.moneda_id, codigo: fila.moneda };
        base = base.plus(fila.tarifa_base.times(cantidad));
        impuestos = impuestos.plus(fila.impuestos.times(cantidad));
      }
    }
    return {
      itinerarioId: seleccion.itinerarioId,
      familiaId: seleccion.familia.id,
      base,
      impuestos,
      monedaId: moneda!.id,
      moneda: moneda!.codigo,
    };
  });
  if (lineas.some((l) => l.monedaId !== lineas[0].monedaId)) throw monedasDistintas();
  return { monedaId: lineas[0].monedaId, lineas };
}

const monedasDistintas = () =>
  noDisponible('The selected fares are no longer priced in a single currency');

/**
 * El cupo que toma el hold: los pasajeros con asiento en la cabina de la familia elegida, en
 * cada salida de cada itinerario, agrupado por salida y cabina y en el orden de bloqueo.
 */
function cuposDe(selecciones: SeleccionResuelta[], asientos: number): CupoDeCabina[] {
  const porFila = new Map<string, CupoDeCabina>();
  for (const { salidas, familia } of selecciones) {
    for (const salidaId of salidas) {
      const llave = `${salidaId}|${familia.cabina}`;
      const cupo = porFila.get(llave) ?? { salidaId, cabina: familia.cabina, cantidad: 0 };
      cupo.cantidad += asientos;
      porFila.set(llave, cupo);
    }
  }
  return [...porFila.values()].sort(
    (a, b) =>
      a.salidaId.localeCompare(b.salidaId) ||
      ORDEN_CABINAS.indexOf(a.cabina) - ORDEN_CABINAS.indexOf(b.cabina),
  );
}

const sumar = (montos: Prisma.Decimal[]) => montos.reduce((a, b) => a.plus(b), CERO);
