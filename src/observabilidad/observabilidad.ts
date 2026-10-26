import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { readFileSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import { ErrorNegocio } from '../common/errores/error-negocio';
import { configuracionObservabilidad } from '../config/observabilidad';
import { Metricas, servidorMetricas } from './metricas';
import { MetricasCore, NombreJob } from './metricas-core';
import { marcarError, Trazas } from './trazas';

/** La versión de package.json: dist/observabilidad y src/observabilidad quedan a la misma altura. */
function versionDelPaquete(): string {
  try {
    const paquete = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return typeof paquete.version === 'string' ? paquete.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * La observabilidad del core: trazas (OpenTelemetry, W3C Trace Context), métricas (prom-client) y
 * el servidor de /metrics en su propio puerto. Sigue el estándar del gateway
 * (docs/OBSERVABILIDAD.md): el SDK de trazas siempre arranca, aunque no se exporte nada, y los
 * spans son manuales.
 *
 * Esta clase es lo único del core que habla con `Trazas` y `Metricas`: el resto del código pide aquí
 * un span `interno`, uno `cliente` o la corrida de un job.
 */
@Injectable()
export class Observabilidad implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Observabilidad');
  readonly trazas: Trazas;
  readonly metricas: Metricas;
  readonly core: MetricasCore;
  private readonly puertoMetricas: number;
  private servidor: Server | undefined;

  constructor(config: ConfigService) {
    const c = configuracionObservabilidad(config, versionDelPaquete());
    this.puertoMetricas = c.puertoMetricas;
    this.trazas = new Trazas({
      servicio: c.servicio,
      version: c.version,
      entorno: c.entorno,
      endpointOtlp: c.endpointOtlp,
      muestreo: c.muestreo,
      confiarEntrante: c.confiarEntrante,
    });
    this.metricas = new Metricas({ servicio: c.servicio, version: c.version, entorno: c.entorno });
    this.core = new MetricasCore(this.metricas.registro);
  }

  onApplicationBootstrap(): void {
    if (this.puertoMetricas === 0) {
      this.logger.log('Métricas apagadas (METRICS_PORT=0)');
      return;
    }
    const servidor = servidorMetricas(this.metricas);
    // Un puerto ocupado no tumba la API: sin métricas, pero sirviendo
    servidor.on('error', (error: NodeJS.ErrnoException) =>
      this.logger.warn(`No se pudo abrir /metrics en :${this.puertoMetricas} (${error.code})`),
    );
    servidor.listen(this.puertoMetricas, () =>
      this.logger.log(`Métricas en :${this.puertoMetricas}/metrics (puerto aparte, no público)`),
    );
    this.servidor = servidor;
  }

  /** Cierra /metrics y envía lo que quede en la cola de trazas (con tope de tiempo). */
  async onModuleDestroy(): Promise<void> {
    const servidor = this.servidor;
    if (servidor?.listening) {
      await new Promise<void>((listo) => {
        servidor.close(() => listo());
        servidor.closeAllConnections();
      });
    }
    await this.trazas.cerrar();
  }

  /**
   * Un span INTERNAL con nombre fijo para una operación de negocio con duración propia. Queda
   * activo mientras corre `trabajo`: lo que se abra dentro (el pago, la bandeja) cuelga de él. Un
   * error de negocio (4xx esperado) no marca el span; uno inesperado, sí, con `error.type` 500.
   */
  async interno<T>(nombre: string, trabajo: () => Promise<T>): Promise<T> {
    const span = this.trazas.iniciar(nombre, SpanKind.INTERNAL, {});
    return this.trazas.conSpan(span, async () => {
      try {
        return await trabajo();
      } catch (error) {
        if (!(error instanceof ErrorNegocio)) marcarError(span, '500');
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Un span CLIENT para una llamada a otro servicio que no pasa por HTTP del core (la Payment API
   * simulada), con su `http_client_request_duration_seconds`. Termina con el status 200 si
   * `trabajo` termina, o con `error.type` y `status=error` si lanza.
   */
  async cliente<T>(
    upstream: string,
    metodo: string,
    ruta: string,
    trabajo: () => Promise<T>,
  ): Promise<T> {
    const span = this.trazas.iniciar(`${metodo} ${ruta}`, SpanKind.CLIENT, {
      'http.request.method': metodo,
      'http.route': ruta,
      'quinde.upstream': upstream,
    });
    const inicio = process.hrtime.bigint();
    const segundos = () => Number(process.hrtime.bigint() - inicio) / 1e9;
    return this.trazas.conSpan(span, async () => {
      try {
        const resultado = await trabajo();
        span.setAttribute('http.response.status_code', 200);
        this.metricas.registrarCliente(upstream, metodo, 200, segundos());
        return resultado;
      } catch (error) {
        marcarError(span, 'unavailable');
        this.metricas.registrarCliente(upstream, metodo, 'error', segundos());
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Una corrida de un proceso periódico: su PROPIA traza raíz (`job <nombre>`), aunque se llame
   * desde dentro de otra, con los logs de la corrida llevando su traceId. Mide
   * `core_job_run_duration_seconds{job}`.
   */
  async corridaDeJob<T>(job: NombreJob, trabajo: () => Promise<T>): Promise<T> {
    const span = this.trazas.iniciar(`job ${job}`, SpanKind.INTERNAL, {}, ROOT_CONTEXT);
    const fin = this.core.duracionJob.startTimer({ job });
    try {
      return await this.trazas.enContexto(trace.setSpan(ROOT_CONTEXT, span), trabajo);
    } catch (error) {
      marcarError(span, '500');
      throw error;
    } finally {
      fin();
      span.end();
    }
  }
}
