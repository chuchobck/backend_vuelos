import {
  Client,
  credentials,
  GrpcObject,
  loadPackageDefinition,
  Metadata,
  ServiceClientConstructor,
  ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { AddressInfo, connect, createServer } from 'node:net';
import {
  OPCIONES_CARGA_PROTO,
  PAQUETE_GRPC,
  RUTA_PROTO,
  SERVICIO_GRPC,
} from '../../src/config/grpc';

export type RpcVuelos = 'SearchFlights' | 'GetSeatMap' | 'GetFlightStatus';

/** El resultado de una llamada: la respuesta o el error, y la metadata inicial (cabeceras). */
export interface ResultadoGrpc<T = Record<string, unknown>> {
  respuesta?: T;
  /** Su `metadata` es la de cierre: problem-code, x-request-id... */
  error?: ServiceError;
  inicial?: Metadata;
}

type Devolver = (error: ServiceError | null, respuesta?: unknown) => void;
type MetodoUnario = (
  mensaje: object,
  metadata: Metadata,
  opciones: { deadline: number },
  devolver: Devolver,
) => { on(evento: 'metadata', escucha: (metadata: Metadata) => void): void };

/**
 * Un cliente real de @grpc/grpc-js para FlightsService, cargado del mismo proto y con las
 * mismas opciones que el servidor (lo que haría el BFF).
 */
export class ClienteGrpc {
  private readonly cliente: Client & Record<RpcVuelos, MetodoUnario>;

  constructor(puerto: number) {
    const paquete = loadPackageDefinition(loadSync(RUTA_PROTO, OPCIONES_CARGA_PROTO));
    const Servicio = PAQUETE_GRPC.split('.').reduce<GrpcObject>(
      (nodo, nombre) => nodo[nombre] as GrpcObject,
      paquete,
    )[SERVICIO_GRPC] as ServiceClientConstructor;
    this.cliente = new Servicio(
      `127.0.0.1:${puerto}`,
      credentials.createInsecure(),
    ) as unknown as ClienteGrpc['cliente'];
  }

  /** Llama a una RPC con la metadata dada; nunca rechaza: el error viene en el resultado. */
  llamar<T = Record<string, unknown>>(
    rpc: RpcVuelos,
    mensaje: object,
    cabeceras: Record<string, string | string[]> = {},
  ): Promise<ResultadoGrpc<T>> {
    const metadata = new Metadata();
    for (const [clave, valores] of Object.entries(cabeceras)) {
      for (const valor of [valores].flat()) metadata.add(clave, valor);
    }
    return new Promise((resolver) => {
      let inicial: Metadata | undefined;
      const llamada = this.cliente[rpc](
        mensaje,
        metadata,
        { deadline: Date.now() + 10_000 },
        (error, respuesta) =>
          resolver({ respuesta: respuesta as T, error: error ?? undefined, inicial }),
      );
      llamada.on('metadata', (recibida) => (inicial = recibida));
    });
  }

  cerrar(): void {
    this.cliente.close();
  }
}

/** Un valor de texto de la metadata, o undefined si no viene. */
export function valorDe(metadata: Metadata | undefined, clave: string): string | undefined {
  const [valor] = metadata?.get(clave) ?? [];
  return valor === undefined ? undefined : String(valor);
}

/** El ProblemDetails de la metadata problem-details-bin de un error. */
export function problemaDe(error: ServiceError | undefined): Record<string, unknown> {
  const [valor] = error?.metadata.get('problem-details-bin') ?? [];
  if (!Buffer.isBuffer(valor)) throw new Error('El error no trae problem-details-bin');
  return JSON.parse(valor.toString('utf8')) as Record<string, unknown>;
}

/** Un puerto TCP libre en este momento: lo elige el sistema y se suelta enseguida. */
export function puertoLibre(): Promise<number> {
  return new Promise((resolver, rechazar) => {
    const servidor = createServer();
    servidor.once('error', rechazar);
    servidor.listen(0, '0.0.0.0', () => {
      const { port } = servidor.address() as AddressInfo;
      servidor.close(() => resolver(port));
    });
  });
}

/** Si algo acepta conexiones TCP en ese puerto de 127.0.0.1. */
export function aceptaConexiones(puerto: number): Promise<boolean> {
  return new Promise((resolver) => {
    const socket = connect(puerto, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolver(true);
    });
    socket.once('error', () => resolver(false));
  });
}
