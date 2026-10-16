import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/** Una respuesta que el notifier falso devuelve: status, cabeceras y, si se quiere, demora. */
export interface RespuestaFalsa {
  status: number;
  cabeceras?: Record<string, string>;
  demoraMs?: number;
}

/** Lo que llegó al notifier falso. */
export interface PublicacionRecibida {
  /** El cuerpo tal cual llegó (para comparar byte a byte). */
  cuerpo: string;
  autorizacion: string | undefined;
  contentType: string | undefined;
  ruta: string | undefined;
}

/** Un servidor HTTP local en un puerto libre, que se puede bajar y volver a levantar. */
abstract class ServidorFalso {
  private servidor: Server;
  private readonly pendientes = new Set<NodeJS.Timeout>();
  puerto = 0;

  constructor() {
    this.servidor = createServer((p, r) => this.recibir(p, r));
  }

  get url(): string {
    return `http://127.0.0.1:${this.puerto}`;
  }

  async iniciar(): Promise<void> {
    await new Promise<void>((listo) => this.servidor.listen(this.puerto, '127.0.0.1', listo));
    this.puerto = (this.servidor.address() as AddressInfo).port;
  }

  /** Deja de escuchar y corta las conexiones: conexión rechazada. */
  async caer(): Promise<void> {
    for (const p of this.pendientes) clearTimeout(p);
    this.pendientes.clear();
    if (!this.servidor.listening) return;
    await new Promise<void>((listo) => {
      this.servidor.close(() => listo());
      this.servidor.closeAllConnections();
    });
  }

  async levantar(): Promise<void> {
    if (this.servidor.listening) return;
    this.servidor = createServer((p, r) => this.recibir(p, r));
    await this.iniciar();
  }

  protected responderLuego(ms: number, responder: () => void, respuesta: ServerResponse) {
    const p = setTimeout(() => {
      this.pendientes.delete(p);
      if (!respuesta.destroyed) responder();
    }, ms);
    this.pendientes.add(p);
  }

  private recibir(peticion: IncomingMessage, respuesta: ServerResponse): void {
    let cuerpo = '';
    peticion.setEncoding('utf8');
    peticion.on('data', (trozo: string) => (cuerpo += trozo));
    peticion.on('end', () => this.atender(peticion, cuerpo, respuesta));
  }

  protected abstract atender(
    peticion: IncomingMessage,
    cuerpo: string,
    respuesta: ServerResponse,
  ): void;
}

/**
 * POST /internal/v1/events de mentira: guarda lo que recibe y contesta lo que la prueba decida
 * (por defecto 202, y 200 si el eventId ya había llegado, como el notifier real).
 */
export class NotifierFalso extends ServidorFalso {
  recibidas: PublicacionRecibida[] = [];
  /** La próxima respuesta de cada publicación; sin nada en la cola, `porDefecto`. */
  private cola: RespuestaFalsa[] = [];
  porDefecto: ((recibida: PublicacionRecibida) => RespuestaFalsa) | undefined;

  static async crear(): Promise<NotifierFalso> {
    const notifier = new NotifierFalso();
    await notifier.iniciar();
    return notifier;
  }

  /** Las próximas respuestas, en orden. */
  responder(...respuestas: RespuestaFalsa[]): void {
    this.cola.push(...respuestas);
  }

  reiniciar(): void {
    this.recibidas = [];
    this.cola = [];
    this.porDefecto = undefined;
  }

  /** Cuántas veces llegó cada eventId. */
  vecesPorEvento(): Map<string, number> {
    const veces = new Map<string, number>();
    for (const r of this.recibidas) {
      const id = (JSON.parse(r.cuerpo) as { eventId: string }).eventId;
      veces.set(id, (veces.get(id) ?? 0) + 1);
    }
    return veces;
  }

  de(eventId: string): PublicacionRecibida[] {
    return this.recibidas.filter((r) => r.cuerpo.includes(`"${eventId}"`));
  }

  protected atender(peticion: IncomingMessage, cuerpo: string, respuesta: ServerResponse): void {
    const recibida: PublicacionRecibida = {
      cuerpo,
      autorizacion: peticion.headers.authorization,
      contentType: peticion.headers['content-type'],
      ruta: peticion.url,
    };
    const yaEstaba = this.recibidas.some((r) => r.cuerpo === cuerpo);
    this.recibidas.push(recibida);
    const plan = this.cola.shift() ??
      this.porDefecto?.(recibida) ?? { status: yaEstaba ? 200 : 202 };
    const responder = () =>
      respuesta
        .writeHead(plan.status, { 'content-type': 'application/json', ...plan.cabeceras })
        .end('{}');
    if (plan.demoraMs) this.responderLuego(plan.demoraMs, responder, respuesta);
    else responder();
  }
}

/** POST /oauth2/token de mentira: entrega tok-1, tok-2... y cuenta los pedidos. */
export class IdentityTokenFalso extends ServidorFalso {
  pedidos: Array<{ autorizacion: string | undefined; cuerpo: string }> = [];
  /** expires_in de los tokens que entrega. */
  vigenciaSegundos = 900;
  /** Si se define, el status con que falla (500, 401...). */
  fallaCon: number | undefined;

  static async crear(): Promise<IdentityTokenFalso> {
    const identity = new IdentityTokenFalso();
    await identity.iniciar();
    return identity;
  }

  get urlToken(): string {
    return `${this.url}/oauth2/token`;
  }

  /** Los tokens entregados hasta ahora. */
  get entregados(): string[] {
    return this.pedidos.map((_, i) => `tok-${i + 1}-falso-de-prueba`);
  }

  reiniciar(): void {
    this.pedidos = [];
    this.vigenciaSegundos = 900;
    this.fallaCon = undefined;
  }

  protected atender(peticion: IncomingMessage, cuerpo: string, respuesta: ServerResponse): void {
    if (this.fallaCon !== undefined) {
      respuesta.writeHead(this.fallaCon, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    this.pedidos.push({ autorizacion: peticion.headers.authorization, cuerpo });
    respuesta.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        access_token: `tok-${this.pedidos.length}-falso-de-prueba`,
        token_type: 'Bearer',
        expires_in: this.vigenciaSegundos,
        scope: 'events:publish',
      }),
    );
  }
}
