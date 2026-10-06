import { Injectable } from '@nestjs/common';
import {
  clase_cabina,
  estado_vuelo,
  Prisma,
  tipo_pasajero,
} from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { OfertaArmada, SalidaVendible } from './busqueda.modelo';

/** Estados en los que una salida se vende: ni cancelada, ni embarcando, ni ya en el aire. */
const ESTADOS_VENDIBLES: estado_vuelo[] = ['PROGRAMADO', 'DEMORADO'];

/** Una fila de precio: la tarifa de una familia en una salida, para un tipo de pasajero. */
export interface FilaTarifaVendible {
  salida_id: string;
  familia_id: string;
  codigo: string;
  clase_cabina: clase_cabina;
  es_cambiable: boolean;
  porcentaje_penalidad_cancelacion: Prisma.Decimal;
  incluye_articulo_personal: boolean;
  equipaje_mano_incluido: number;
  equipaje_bodega_incluido: number;
  moneda: string;
  precio_equipaje_adicional: Prisma.Decimal;
  cupos_disponibles: number;
  tipo_pasajero: tipo_pasajero;
  tarifa_base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
}

interface FilaSalida {
  id: string;
  numero_vuelo: string;
  aerolinea_id: bigint;
  comercializa: string;
  nombre_comercializa: string;
  opera: string;
  origen: string;
  destino: string;
  fecha_salida: Date;
  salida_programada: Date;
  llegada_programada: Date;
  terminal_salida: string | null;
  terminal_llegada: string | null;
  estado: estado_vuelo;
  modelo: string;
}

/**
 * Consultas de la búsqueda. Son SQL parametrizado (plantillas etiquetadas, nunca texto
 * concatenado): con `findMany` e `include`, Prisma haría una consulta por cada relación.
 * Las tablas van calificadas con `vuelos.` porque el adaptador no fija el search_path en
 * SQL crudo.
 *
 * Solo se lee lo vendible: vuelo, aerolíneas y aeropuertos activos, la salida PROGRAMADO o
 * DEMORADO y todavía en el futuro, y tarifa, familia y moneda activas.
 */
@Injectable()
export class BusquedaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Las salidas vendibles que pueden formar parte de un tramo: las que salen de `origen` en
   * la fecha local pedida (directas o primera pierna de una escala) y las que llegan a
   * `destino` ese día o el siguiente (segunda pierna). El service arma los itinerarios.
   */
  async salidasDelTramo(origen: string, destino: string, fecha: Date): Promise<SalidaVendible[]> {
    const filas = await this.prisma.db.$queryRaw<FilaSalida[]>`
      SELECT vp.id, ac.codigo_iata || v.numero AS numero_vuelo, ac.id AS aerolinea_id,
             ac.codigo_iata AS comercializa, ac.nombre AS nombre_comercializa,
             ao.codigo_iata AS opera, po.codigo_iata AS origen, pd.codigo_iata AS destino,
             vp.fecha_salida, vp.salida_programada, vp.llegada_programada,
             vp.terminal_salida, vp.terminal_llegada, vp.estado::text AS estado,
             m.codigo_iata AS modelo
        FROM vuelos.vuelo_programado vp
        JOIN vuelos.vuelo v            ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac       ON ac.id = v.aerolinea_id
        JOIN vuelos.aerolinea ao       ON ao.id = v.aerolinea_operadora_id
        JOIN vuelos.aeropuerto po      ON po.id = v.aeropuerto_origen_id
        JOIN vuelos.aeropuerto pd      ON pd.id = v.aeropuerto_destino_id
        JOIN vuelos.mapa_asientos_cabecera mc ON mc.id = vp.mapa_asientos_id
        JOIN vuelos.modelo_aeronave m  ON m.id = mc.modelo_aeronave_id
       WHERE v.activo AND ac.activo AND ao.activo AND po.activo AND pd.activo
         AND vp.estado::text = ANY(${ESTADOS_VENDIBLES})
         AND vp.salida_programada > now()
         AND vp.fecha_salida BETWEEN ${fecha}::date AND ${fecha}::date + 1
         AND ((po.codigo_iata = ${origen} AND vp.fecha_salida = ${fecha}::date)
              OR pd.codigo_iata = ${destino})
       ORDER BY vp.salida_programada, vp.id`;

    return filas.map((f) => ({
      id: f.id,
      numeroVuelo: f.numero_vuelo,
      aerolineaId: f.aerolinea_id,
      comercializa: f.comercializa,
      nombreComercializa: f.nombre_comercializa,
      opera: f.opera,
      origen: f.origen,
      destino: f.destino,
      fechaSalida: f.fecha_salida,
      salida: f.salida_programada,
      llegada: f.llegada_programada,
      terminalSalida: f.terminal_salida,
      terminalLlegada: f.terminal_llegada,
      estado: f.estado,
      modelo: f.modelo,
    }));
  }

  /**
   * Precios vendibles de esas salidas: tarifa activa de una familia activa, en una moneda
   * activa, cuya cabina tiene en la salida al menos `asientos` cupos disponibles, para los
   * tipos de pasajero pedidos. Una fila por salida, familia y tipo de pasajero.
   */
  tarifasVendibles(
    salidas: readonly string[],
    asientos: number,
    tipos: readonly tipo_pasajero[],
  ): Promise<FilaTarifaVendible[]> {
    if (salidas.length === 0) return Promise.resolve([]);
    return this.prisma.db.$queryRaw<FilaTarifaVendible[]>`
      SELECT t.vuelo_programado_id AS salida_id, f.id_publico AS familia_id, f.codigo,
             f.clase_cabina::text AS clase_cabina, f.es_cambiable,
             f.porcentaje_penalidad_cancelacion, f.incluye_articulo_personal,
             f.equipaje_mano_incluido, f.equipaje_bodega_incluido,
             mo.codigo_iso AS moneda, t.precio_equipaje_adicional, ic.cupos_disponibles,
             td.tipo_pasajero::text AS tipo_pasajero, td.tarifa_base, td.impuestos
        FROM vuelos.tarifa_cabecera t
        JOIN vuelos.familia_tarifa f    ON f.id = t.familia_tarifa_id
        JOIN vuelos.moneda mo           ON mo.id = t.moneda_id
        JOIN vuelos.inventario_cabina ic ON ic.vuelo_programado_id = t.vuelo_programado_id
                                        AND ic.clase_cabina = f.clase_cabina
        JOIN vuelos.tarifa_detalle td   ON td.tarifa_id = t.id
       WHERE t.vuelo_programado_id = ANY(${salidas}::uuid[])
         AND t.activo AND f.activo AND mo.activo
         AND ic.cupos_disponibles >= ${asientos}
         AND td.tipo_pasajero::text = ANY(${tipos})`;
  }

  /**
   * Guarda las ofertas que se devuelven: cabecera (aerolínea, huella del dispositivo y
   * vencimiento), sus itinerarios en orden y los segmentos de cada itinerario. Un itinerario
   * que aparece en varias ofertas de la misma búsqueda se guarda una vez. Los ids ya vienen
   * generados, así que todo va en cuatro INSERT de varias filas dentro de una transacción.
   * No toca cupos ni ninguna otra tabla.
   *
   * Creación y vencimiento salen del mismo reloj (el de la aplicación) y no de now() de la
   * base: si los dos relojes difieren, la vigencia guardada seguiría siendo exacta.
   */
  async guardarOfertas(
    ofertas: OfertaArmada[],
    huella: string,
    creada: Date,
    vence: Date,
  ): Promise<void> {
    if (ofertas.length === 0) return;
    const itinerarios = new Map(
      ofertas.flatMap((o) => o.itinerarios).map((itinerario) => [itinerario.id, itinerario]),
    );

    await this.prisma.transaccionAuditada(async (tx) => {
      await tx.itinerario_cabecera.createMany({
        data: [...itinerarios.keys()].map((id) => ({ id, fecha_creacion: creada })),
      });
      await tx.itinerario_detalle.createMany({
        data: [...itinerarios.values()].flatMap((itinerario) =>
          itinerario.segmentos.map((segmento, i) => ({
            itinerario_id: itinerario.id,
            orden: i + 1,
            vuelo_programado_id: segmento.id,
          })),
        ),
      });
      await tx.oferta_cabecera.createMany({
        data: ofertas.map((oferta) => ({
          id: oferta.id,
          aerolinea_id: oferta.itinerarios[0].segmentos[0].aerolineaId,
          huella_dispositivo: huella,
          fecha_creacion: creada,
          fecha_expiracion: vence,
        })),
      });
      await tx.oferta_detalle.createMany({
        data: ofertas.flatMap((oferta) =>
          oferta.itinerarios.map((itinerario, i) => ({
            oferta_id: oferta.id,
            itinerario_id: itinerario.id,
            orden: i + 1,
          })),
        ),
      });
    });
  }

  /**
   * Borra (físicamente: son tablas temporales, ver TABLAS_CON_BORRADO_FISICO) las ofertas
   * vencidas que ninguna retención usa y los itinerarios que ya nadie referencia: ni una
   * oferta, ni una retención, ni una reserva, ni un cambio de fecha. Los detalles caen en
   * cascada. `creadosAntesDe` protege a los itinerarios de una búsqueda en curso.
   */
  async purgarVencidas(creadosAntesDe: Date): Promise<{ ofertas: number; itinerarios: number }> {
    const ofertas = await this.prisma.db.oferta_cabecera.deleteMany({
      where: { fecha_expiracion: { lt: new Date() }, retencion_cabecera: { none: {} } },
    });
    const itinerarios = await this.prisma.db.itinerario_cabecera.deleteMany({
      where: {
        fecha_creacion: { lt: creadosAntesDe },
        oferta_detalle: { none: {} },
        retencion_detalle: { none: {} },
        reserva_detalle_itinerario: { none: {} },
        cambio_detalle: { none: {} },
      },
    });
    return { ofertas: ofertas.count, itinerarios: itinerarios.count };
  }
}
