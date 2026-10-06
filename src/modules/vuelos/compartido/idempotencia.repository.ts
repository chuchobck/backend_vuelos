import { Injectable } from '@nestjs/common';
import { operacion_idempotente, Prisma } from '../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../prisma/prisma.service';

/** Una Idempotency-Key de un usuario para una operación. */
export interface IdClave {
  idPropietario: string;
  operacion: operacion_idempotente;
  clave: string;
}

/** La clave que se reclama, con la respuesta que se repetirá en un reintento. */
export interface ClaveNueva extends IdClave {
  huella: string;
  codigoHttp: number;
  respuesta: Prisma.InputJsonObject;
  creada: Date;
  vence: Date;
}

export interface ClaveGuardada {
  huella: string;
  codigoHttp: number | null;
  respuesta: Prisma.JsonValue;
  vence: Date;
}

/**
 * clave_idempotencia, la tabla de las Idempotency-Key ya usadas (POST /offers/hold y
 * POST /bookings). Cada operación decide qué guarda como respuesta; aquí solo se lee, se
 * reclama y se borra.
 */
@Injectable()
export class IdempotenciaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async leer({ idPropietario, operacion, clave }: IdClave): Promise<ClaveGuardada | null> {
    const fila = await this.prisma.db.clave_idempotencia.findUnique({
      where: {
        id_propietario_operacion_clave: { id_propietario: idPropietario, operacion, clave },
      },
      select: {
        huella_solicitud: true,
        codigo_http: true,
        respuesta: true,
        fecha_expiracion: true,
      },
    });
    return fila
      ? {
          huella: fila.huella_solicitud,
          codigoHttp: fila.codigo_http,
          respuesta: fila.respuesta,
          vence: fila.fecha_expiracion,
        }
      : null;
  }

  /**
   * Reclama la clave dentro de la transacción del cambio que protege, ya con su respuesta. Si
   * otra petición con la misma clave está en curso, el INSERT espera a que termine: si ella
   * confirma, este no inserta nada y devuelve false (hay que repetir su respuesta); si ella se
   * deshace, este la reclama. Así dos peticiones con la misma clave no hacen el cambio dos veces.
   */
  async reclamar(tx: TransaccionVuelos, clave: ClaveNueva): Promise<boolean> {
    const insertadas = await tx.$executeRaw`
      INSERT INTO vuelos.clave_idempotencia
             (id_propietario, operacion, clave, huella_solicitud, codigo_http, respuesta,
              fecha_creacion, fecha_expiracion)
      VALUES (${clave.idPropietario}, ${clave.operacion}::vuelos.operacion_idempotente,
              ${clave.clave}::uuid, ${clave.huella}, ${clave.codigoHttp}::smallint,
              ${JSON.stringify(clave.respuesta)}::jsonb, ${clave.creada}::timestamptz,
              ${clave.vence}::timestamptz)
      ON CONFLICT ON CONSTRAINT uq_clave_idempotencia DO NOTHING`;
    return insertadas === 1;
  }

  /**
   * Borra (físicamente: clave_idempotencia está en TABLAS_CON_BORRADO_FISICO) las claves ya
   * vencidas; con `clave`, solo esa. Devuelve cuántas borró.
   */
  async borrarVencidas(ahora: Date, clave?: IdClave): Promise<number> {
    const { count } = await this.prisma.db.clave_idempotencia.deleteMany({
      where: {
        fecha_expiracion: { lte: ahora },
        ...(clave
          ? { id_propietario: clave.idPropietario, operacion: clave.operacion, clave: clave.clave }
          : {}),
      },
    });
    return count;
  }
}
