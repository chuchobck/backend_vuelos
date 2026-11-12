import { Injectable } from '@nestjs/common';
import { estado_vuelo } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AeropuertoDeSalidas, SalidaEnPantalla } from './tablero-salidas.modelo';

interface FilaSalida {
  id: string;
  numero_vuelo: string;
  aerolinea: string;
  destino: string;
  ciudad_destino: string;
  salida_programada: Date;
  salida_estimada: Date | null;
  estado: estado_vuelo;
  terminal_salida: string | null;
  puerta_salida: string | null;
}

/** Desde dónde sigue una página: la hora programada y el id de la última fila de la anterior. */
export interface DespuesDe {
  programada: Date;
  id: string;
}

const SIN_CURSOR: DespuesDe = {
  programada: new Date(0),
  id: '00000000-0000-0000-0000-000000000000',
};

/**
 * Lee las salidas de un aeropuerto para la pantalla pública. Solo lectura y solo tablas de
 * vuelos: no toca reservas, cupos ni pasajeros.
 */
@Injectable()
export class TableroSalidasRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** El aeropuerto activo con ese código y la zona horaria de su ciudad, o null. */
  async aeropuerto(iata: string): Promise<AeropuertoDeSalidas | null> {
    const [f] = await this.prisma.db.$queryRaw<
      Array<{ codigo_iata: string; nombre: string; ciudad: string; zona_horaria: string }>
    >`
      SELECT a.codigo_iata, a.nombre, c.nombre AS ciudad, c.zona_horaria
        FROM vuelos.aeropuerto a
        JOIN vuelos.ciudad c ON c.id = a.ciudad_id
       WHERE a.codigo_iata = ${iata} AND a.activo`;
    if (!f) return null;
    return { iata: f.codigo_iata, nombre: f.nombre, ciudad: f.ciudad, zonaHoraria: f.zona_horaria };
  }

  /**
   * Las salidas del aeropuerto cuya fecha local de salida es `fecha` (vuelo_programado.fecha_salida
   * ya es la fecha en el origen), por hora programada e id: un orden estable para el cursor.
   * Incluye las canceladas: una pantalla las muestra. Hasta `limite` filas después de `despuesDe`.
   */
  async salidas(
    iata: string,
    fecha: Date,
    limite: number,
    despuesDe?: DespuesDe,
  ): Promise<SalidaEnPantalla[]> {
    const desde = despuesDe ?? SIN_CURSOR;
    const filas = await this.prisma.db.$queryRaw<FilaSalida[]>`
      SELECT vp.id, ac.codigo_iata || v.numero AS numero_vuelo, ac.nombre AS aerolinea,
             pd.codigo_iata AS destino, cd.nombre AS ciudad_destino, vp.salida_programada,
             vp.salida_estimada, vp.estado::text AS estado, vp.terminal_salida, vp.puerta_salida
        FROM vuelos.vuelo_programado vp
        JOIN vuelos.vuelo v       ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac  ON ac.id = v.aerolinea_id
        JOIN vuelos.aeropuerto po ON po.id = v.aeropuerto_origen_id
        JOIN vuelos.aeropuerto pd ON pd.id = v.aeropuerto_destino_id
        JOIN vuelos.ciudad cd     ON cd.id = pd.ciudad_id
       WHERE po.codigo_iata = ${iata} AND vp.fecha_salida = ${fecha}::date
         AND (${despuesDe === undefined}::boolean
              OR (vp.salida_programada, vp.id) > (${desde.programada}::timestamptz, ${desde.id}::uuid))
       ORDER BY vp.salida_programada, vp.id
       LIMIT ${limite}`;
    return filas.map((f) => ({
      id: f.id,
      numeroVuelo: f.numero_vuelo,
      aerolinea: f.aerolinea,
      destino: f.destino,
      ciudadDestino: f.ciudad_destino,
      programada: f.salida_programada,
      estimada: f.salida_estimada,
      estado: f.estado,
      terminal: f.terminal_salida,
      puerta: f.puerta_salida,
    }));
  }
}
