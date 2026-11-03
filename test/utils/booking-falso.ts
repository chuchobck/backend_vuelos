import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/** Una respuesta que el Booking falso devuelve. Sin `cuerpo`, el de éxito. */
export interface RespuestaBooking {
  status: number;
  cuerpo?: object | string;
  cabeceras?: Record<string, string>;
  /** Cuánto tarda en contestar (para el plazo). */
  demoraMs?: number;
}

/** Lo que llegó al Booking falso. */
export interface StockRecibido {
  metodo: string | undefined;
  ruta: string | undefined;
  contentType: string | undefined;
  autorizacion: string | undefined;
  correlacion: string | undefined;
  traceparent: string | undefined;
  /** El cuerpo ya leído como JSON. */
  registro: {
    service_id: string;
    item_id: string;
    date: string;
    time_slot: string;
    available_units: number;
  };
}

/**
 * Un Booking de mentira (POST /api/v2/inventory/stock) en un puerto libre, que se puede bajar y
 * volver a levantar en el mismo puerto. Responde `{"success":true}` salvo que la prueba encole
 * otra cosa con `responder`. `alRecibir` corre antes de contestar (para provocar un cambio de
 * cupo mientras un envío está en vuelo). NO es el Booking real: ese no se llama desde las pruebas.
 */
export class BookingFalso {
  readonly recibidas: StockRecibido[] = [];
  puerto = 0;
  alRecibir: ((r: StockRecibido) => Promise<void>) | undefined;
  private cola: RespuestaBooking[] = [];
  private porDefecto: RespuestaBooking = { status: 200, cuerpo: { success: true } };
  private servidor: Server;
  private readonly temporizadores = new Set<NodeJS.Timeout>();

  private constructor() {
    this.servidor = createServer((p, r) => void this.recibir(p, r));
  }

  static async crear(): Promise<BookingFalso> {
    const falso = new BookingFalso();
    await falso.iniciar();
    return falso;
  }

  get url(): string {
    return `http://127.0.0.1:${this.puerto}/api/v2/inventory/stock`;
  }

  /** Las próximas respuestas, una por llamada; cuando se acaban, la de por defecto. */
  responder(...respuestas: RespuestaBooking[]): void {
    this.cola.push(...respuestas);
  }

  /** Lo que contesta cuando la cola está vacía (por ejemplo siempre 503). */
  siempre(respuesta: RespuestaBooking): void {
    this.porDefecto = respuesta;
  }

  reiniciar(): void {
    this.recibidas.length = 0;
    this.cola = [];
    this.porDefecto = { status: 200, cuerpo: { success: true } };
    this.alRecibir = undefined;
  }

  /** Lo recibido de los vuelos de un prefijo de item_id (`AV777-`). */
  de(prefijo: string): StockRecibido[] {
    return this.recibidas.filter((r) => r.registro.item_id.startsWith(prefijo));
  }

  async iniciar(): Promise<void> {
    await new Promise<void>((listo) => this.servidor.listen(this.puerto, '127.0.0.1', listo));
    this.puerto = (this.servidor.address() as AddressInfo).port;
  }

  /** Lo baja: las llamadas siguientes dan ECONNREFUSED. */
  async caer(): Promise<void> {
    for (const t of this.temporizadores) clearTimeout(t);
    this.temporizadores.clear();
    this.servidor.closeAllConnections();
    await new Promise<void>((listo) => this.servidor.close(() => listo()));
  }

  /** Lo vuelve a levantar en el mismo puerto. */
  async levantar(): Promise<void> {
    this.servidor = createServer((p, r) => void this.recibir(p, r));
    await this.iniciar();
  }

  private async recibir(peticion: IncomingMessage, respuesta: ServerResponse): Promise<void> {
    const trozos: Buffer[] = [];
    for await (const trozo of peticion) trozos.push(trozo as Buffer);
    const recibido: StockRecibido = {
      metodo: peticion.method,
      ruta: peticion.url,
      contentType: peticion.headers['content-type'],
      autorizacion: peticion.headers.authorization,
      correlacion: peticion.headers['x-correlation-id'] as string | undefined,
      traceparent: peticion.headers.traceparent as string | undefined,
      registro: JSON.parse(Buffer.concat(trozos).toString('utf8')),
    };
    this.recibidas.push(recibido);
    await this.alRecibir?.(recibido);
    const { status, cuerpo, cabeceras, demoraMs } = this.cola.shift() ?? this.porDefecto;
    const contestar = () => {
      respuesta.writeHead(status, { 'Content-Type': 'application/json', ...cabeceras });
      respuesta.end(
        typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo ?? { success: true }),
      );
    };
    if (demoraMs) {
      const t = setTimeout(contestar, demoraMs);
      this.temporizadores.add(t);
    } else {
      contestar();
    }
  }
}
