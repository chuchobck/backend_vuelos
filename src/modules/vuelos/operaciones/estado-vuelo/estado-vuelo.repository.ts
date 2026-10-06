import { Injectable } from '@nestjs/common';
import { estado_vuelo } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { EstadoVuelo } from './estado-vuelo.modelo';

interface FilaEstado {
  numero_vuelo: string;
  fecha_salida: Date;
  comercializa: string;
  opera: string;
  aeronave: string;
  estado: estado_vuelo;
  origen: string;
  destino: string;
  terminal_salida: string | null;
  terminal_llegada: string | null;
  salida_programada: Date;
  salida_estimada: Date | null;
  salida_real: Date | null;
  llegada_programada: Date;
  llegada_estimada: Date | null;
  llegada_real: Date | null;
}

/**
 * Lee el estado operativo de una salida programada. Solo lectura: no toca reservas ni
 * pasajeros. No filtra por `activo`: el estado de un vuelo ya cancelado o dado de baja se sigue
 * pudiendo consultar (un pasajero que va a ese vuelo necesita saber que se canceló).
 */
@Injectable()
export class EstadoVueloRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * La salida del vuelo `numero` de la aerolínea comercializadora `aerolinea` cuya fecha local
   * de salida en el origen es `fecha`, o null si no existe. (vuelo, fecha_salida) es único.
   */
  async buscar(aerolinea: string, numero: string, fecha: Date): Promise<EstadoVuelo | null> {
    const [f] = await this.prisma.db.$queryRaw<FilaEstado[]>`
      SELECT ac.codigo_iata || v.numero AS numero_vuelo, vp.fecha_salida,
             ac.codigo_iata AS comercializa, ao.codigo_iata AS opera, m.codigo_iata AS aeronave,
             vp.estado::text AS estado, po.codigo_iata AS origen, pd.codigo_iata AS destino,
             vp.terminal_salida, vp.terminal_llegada, vp.salida_programada, vp.salida_estimada,
             vp.salida_real, vp.llegada_programada, vp.llegada_estimada, vp.llegada_real
        FROM vuelos.vuelo_programado vp
        JOIN vuelos.vuelo v                   ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac              ON ac.id = v.aerolinea_id
        JOIN vuelos.aerolinea ao              ON ao.id = v.aerolinea_operadora_id
        JOIN vuelos.aeropuerto po             ON po.id = v.aeropuerto_origen_id
        JOIN vuelos.aeropuerto pd             ON pd.id = v.aeropuerto_destino_id
        JOIN vuelos.mapa_asientos_cabecera mc ON mc.id = vp.mapa_asientos_id
        JOIN vuelos.modelo_aeronave m         ON m.id = mc.modelo_aeronave_id
       WHERE ac.codigo_iata = ${aerolinea} AND v.numero = ${numero}
         AND vp.fecha_salida = ${fecha}::date`;
    if (!f) return null;
    return {
      numeroVuelo: f.numero_vuelo,
      fecha: f.fecha_salida,
      comercializa: f.comercializa,
      opera: f.opera,
      aeronave: f.aeronave,
      estado: f.estado,
      salida: {
        iata: f.origen,
        terminal: f.terminal_salida,
        programada: f.salida_programada,
        estimada: f.salida_estimada,
        real: f.salida_real,
      },
      llegada: {
        iata: f.destino,
        terminal: f.terminal_llegada,
        programada: f.llegada_programada,
        estimada: f.llegada_estimada,
        real: f.llegada_real,
      },
    };
  }
}
