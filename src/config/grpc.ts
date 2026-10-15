import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcOptions, Transport } from '@nestjs/microservices';
import { join } from 'node:path';

/** Paquete y servicio de contracts/proto/flights/v1/flights.proto. */
export const PAQUETE_GRPC = 'quinde.flights.v1';
export const SERVICIO_GRPC = 'FlightsService';

/** El contrato gRPC; dist/config y src/config quedan a la misma altura de contracts/. */
export const RUTA_PROTO = join(__dirname, '..', '..', 'contracts/proto/flights/v1/flights.proto');

export const PUERTO_GRPC_POR_DEFECTO = 50051;

/**
 * Tope de un mensaje que recibe el servidor: el mismo que el del cuerpo en REST (100 kB).
 * Uno más grande lo rechaza grpc-js con RESOURCE_EXHAUSTED antes de llegar a Nest.
 */
export const LIMITE_MENSAJE_GRPC = 100 * 1024;

/**
 * Cómo @grpc/proto-loader convierte los mensajes. Lo usan el servidor y las pruebas, y es lo
 * que debe usar un cliente en Node (el BFF) para recibir lo mismo:
 * - `keepCase: false`: `total_offers` llega como `totalOffers`, el nombre del JSON del contrato.
 * - `enums: String`: `FLIGHT_STATUS_SCHEDULED` y no 1.
 * - `defaults: true`: un campo sin valor llega con el de proto3 (0, false, ''); los `optional`
 *   sin valor no llegan, como un null de REST.
 * - `oneofs: false`: sin la propiedad virtual de los `optional` (`_terminal`).
 */
export const OPCIONES_CARGA_PROTO = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: false,
};

export interface ConfiguracionGrpc {
  habilitado: boolean;
  puerto: number;
}

/** GRPC_ENABLED y GRPC_PORT, ya validadas por entorno.ts. */
export function configuracionGrpc(config: ConfigService): ConfiguracionGrpc {
  return {
    habilitado: config.get<string>('GRPC_ENABLED') === 'true',
    puerto: config.get<number>('GRPC_PORT') ?? PUERTO_GRPC_POR_DEFECTO,
  };
}

export function opcionesGrpc(puerto: number): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: PAQUETE_GRPC,
      protoPath: RUTA_PROTO,
      url: `0.0.0.0:${puerto}`,
      loader: OPCIONES_CARGA_PROTO,
      maxReceiveMessageLength: LIMITE_MENSAJE_GRPC,
    },
  };
}

/**
 * Conecta y arranca el servidor gRPC interno si GRPC_ENABLED=true; si no, no abre ningún
 * puerto. Lo usan `main.ts` (antes de `listen`) y las pruebas, que pasan su propia
 * configuración. Es una app híbrida sin `inheritAppConfig`: los guards, el filtro y el pipe
 * globales de HTTP no corren en gRPC; cada controlador gRPC declara los suyos.
 */
export async function iniciarGrpc(
  app: INestApplication,
  configuracion = configuracionGrpc(app.get(ConfigService)),
): Promise<boolean> {
  const logger = new Logger('gRPC');
  if (!configuracion.habilitado) {
    logger.log('Apagado (GRPC_ENABLED=false)');
    return false;
  }
  app.connectMicroservice<GrpcOptions>(opcionesGrpc(configuracion.puerto));
  await app.startAllMicroservices();
  logger.log(`Activo en 0.0.0.0:${configuracion.puerto} (${PAQUETE_GRPC}.${SERVICIO_GRPC})`);
  return true;
}
