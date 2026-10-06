import { Injectable } from '@nestjs/common';
import { estado_vuelo } from '../../../../generated/prisma/client';
import { noExiste } from '../../compartido/errores';
import { FilaDistribucion, OfertaRepository } from './oferta.repository';

/** Estados en los que el segmento se sigue vendiendo (los mismos que en la búsqueda). */
const ESTADOS_VENDIBLES: estado_vuelo[] = ['PROGRAMADO', 'DEMORADO'];

export interface MapaDeSegmento {
  salidaId: string;
  filas: FilaDistribucion[];
  ocupados: Set<bigint>;
  cabinasVendidas: Set<string>;
}

/**
 * GET /offers/{offerId}/seatmap. Las retenciones toman cupo de cabina, no asientos: un
 * asiento solo deja de estar disponible cuando una reserva lo asigna (reserva_detalle_asiento)
 * o cuando su cabina no se vende en esta salida.
 */
@Injectable()
export class OfertaService {
  constructor(private readonly repositorio: OfertaRepository) {}

  async mapaDeAsientos(ofertaId: string, segmentoId: string): Promise<MapaDeSegmento> {
    const vence = await this.repositorio.vencimiento(ofertaId);
    if (vence === null || vence <= new Date()) {
      throw noExiste(`Offer ${ofertaId} was not found or has expired`);
    }
    const segmento = await this.repositorio.segmento(ofertaId, segmentoId);
    if (!segmento) throw noExiste(`Segment ${segmentoId} is not part of offer ${ofertaId}`);
    if (!ESTADOS_VENDIBLES.includes(segmento.estado) || segmento.salida <= new Date()) {
      throw noExiste(`Segment ${segmentoId} is no longer available`);
    }

    const [filas, ocupados, cabinasVendidas] = await Promise.all([
      this.repositorio.distribucion(segmento.mapaId),
      this.repositorio.asientosOcupados(segmento.salidaId),
      this.repositorio.cabinasVendidas(segmento.salidaId),
    ]);
    return { salidaId: segmento.salidaId, filas, ocupados, cabinasVendidas };
  }
}
