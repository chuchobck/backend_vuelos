import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Request, Response } from 'express';
import { ejecutarEnContexto, obtenerContexto } from '../contexto/contexto-peticion';
import { contextoDeLaPeticion } from '../contexto/contexto.middleware';
import { ErrorNegocio } from '../errores/error-negocio';
import { CONTENT_TYPE_PROBLEMA } from '../errores/problem-details';
import { traducirExcepcion } from '../errores/traducir-excepcion';

/** Forma mínima de la capa de ruta de Express, que no tiene tipos públicos. */
interface CapaExpress {
  route?: { methods: Record<string, boolean> };
  match(ruta: string): boolean;
}

/**
 * Filtro global: todo error de la API sale como `application/problem+json` con el esquema
 * ProblemDetails del contrato, sea de una excepción de Nest, de una regla de negocio, de una
 * ruta inexistente o de un fallo que nadie previó.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errores');

  constructor(private readonly adaptador: HttpAdapterHost) {}

  catch(excepcion: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw excepcion;

    const peticion = host.switchToHttp().getRequest<Request>();
    const respuesta = host.switchToHttp().getResponse<Response>();
    const ruta = peticion.originalUrl.split('?')[0].slice(0, 200);

    const { problema, cabeceras, esErrorInterno, causa } = traducirExcepcion(excepcion, {
      metodo: peticion.method,
      ruta,
      metodosPermitidos: this.metodosDeLaRuta(ruta),
    });

    const registrar = () => {
      if (esErrorInterno) {
        // El stack se queda en el log; al cliente solo llega el ProblemDetails sin detalle.
        const detalle = causa instanceof Error ? (causa.stack ?? causa.message) : String(causa);
        this.logger.error(`${peticion.method} ${ruta} → ${problema.status}\n${detalle}`);
      } else {
        // Si vino de la base, el error original ayuda a ver qué restricción saltó.
        const origen =
          causa instanceof Error && !(causa instanceof ErrorNegocio) ? ` (${resumir(causa)})` : '';
        this.logger.debug(
          `${peticion.method} ${ruta} → ${problema.status} ${problema.code}${origen}`,
        );
      }
    };
    // Un error del parser del cuerpo llega antes de abrir el contexto asíncrono: el id se toma
    // de la petición para que su línea de log lo lleve igual.
    const contexto = contextoDeLaPeticion(peticion);
    if (contexto && obtenerContexto() === undefined) ejecutarEnContexto(contexto, registrar);
    else registrar();

    if (respuesta.headersSent) {
      respuesta.end();
      return;
    }
    for (const [nombre, valor] of Object.entries(cabeceras)) respuesta.setHeader(nombre, valor);
    respuesta
      .status(problema.status)
      .setHeader('Content-Type', CONTENT_TYPE_PROBLEMA)
      .send(JSON.stringify(problema));
  }

  /** Métodos con los que existe la ruta pedida; vacío si la ruta no existe con ninguno. */
  private metodosDeLaRuta(ruta: string): string[] {
    // Express 4 guarda las rutas registradas en app._router.stack.
    const capas: CapaExpress[] = this.adaptador.httpAdapter.getInstance()._router?.stack ?? [];
    const metodos = new Set<string>();
    for (const capa of capas) {
      if (!capa.route || !capa.match(ruta)) continue;
      for (const [metodo, activo] of Object.entries(capa.route.methods)) {
        if (activo && metodo !== '_all') metodos.add(metodo.toUpperCase());
      }
    }
    return [...metodos];
  }
}

/** Los errores de Prisma traen la invocación completa y saltos de línea; al log, una línea. */
function resumir(error: Error): string {
  return error.message.replace(/\s+/g, ' ').trim().slice(-300);
}
