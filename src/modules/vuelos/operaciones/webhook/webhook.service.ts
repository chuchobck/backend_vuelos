import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { Reloj } from '../../../../common/reloj';
import { PrismaService } from '../../../../prisma/prisma.service';
import { cuerpoInvalido, noExiste } from '../../compartido/errores';
import { CifradoSecreto } from './cifrado-secreto';
import { motivoDestinoInvalido } from './destino-permitido';
import { SolicitudWebhookDto } from './dto/webhook.dto';
import { enmascarar } from './webhook.mapper';
import { EVENTOS_WEBHOOK, EventoWebhook, MAXIMO_SUSCRIPCIONES_ACTIVAS } from './webhook.modelo';
import { WebhookRepository } from './webhook.repository';

export interface SuscripcionVista {
  id: string;
  url: string;
  eventos: EventoWebhook[];
  secretoEnmascarado: string;
}

/**
 * Suscripciones a webhooks del usuario del token (GET, POST y DELETE /webhooks). Todo es del
 * dueño: una suscripción ajena es 404. Alta y baja van en la transacción auditada (la auditoría
 * guarda el secreto enmascarado).
 */
@Injectable()
export class WebhookService {
  private readonly produccion: boolean;

  constructor(
    private readonly repositorio: WebhookRepository,
    private readonly cifrado: CifradoSecreto,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.produccion = config.get<string>('NODE_ENV') === 'production';
  }

  /**
   * Registra la suscripción. 400 si la URL no es un destino válido (https en producción, y que
   * no resuelva a una red interna); 409 si el usuario ya tiene 10 activas o ya tiene esa URL.
   */
  async crear(solicitud: SolicitudWebhookDto, idPropietario: string): Promise<SuscripcionVista> {
    const motivo = await motivoDestinoInvalido(solicitud.url, { produccion: this.produccion });
    // La URL no se repite en el error: puede llevar un token en la consulta
    if (motivo !== null) throw cuerpoInvalido('url', motivo);

    const id = await this.prisma.transaccionAuditada(async (tx) => {
      if (
        (await this.repositorio.contarActivasBloqueando(tx, idPropietario)) >=
        MAXIMO_SUSCRIPCIONES_ACTIVAS
      ) {
        throw new ErrorNegocio(
          409,
          CODIGO_SIN_EQUIVALENTE,
          `At most ${MAXIMO_SUSCRIPCIONES_ACTIVAS} active webhooks per user; delete one first`,
        );
      }
      return this.repositorio.crear(tx, {
        idPropietario,
        url: solicitud.url,
        secretoCifrado: this.cifrado.cifrar(solicitud.secret),
        eventos: solicitud.events,
        creada: this.reloj.ahora(),
      });
    });
    return {
      id,
      url: solicitud.url,
      eventos: [...solicitud.events].sort(porOrdenDelContrato),
      secretoEnmascarado: enmascarar(solicitud.secret),
    };
  }

  async listar(idPropietario: string): Promise<SuscripcionVista[]> {
    const suscripciones = await this.repositorio.activasDe(idPropietario);
    return suscripciones.map((s) => ({
      id: s.id,
      url: s.url,
      eventos: s.eventos,
      secretoEnmascarado: this.enmascarado(s.secretoCifrado),
    }));
  }

  /** Baja lógica: 404 si no existe, no está activa o es de otro usuario. */
  async eliminar(id: string, idPropietario: string): Promise<void> {
    const existia = await this.prisma.transaccionAuditada((tx) =>
      this.repositorio.desactivar(tx, id, idPropietario),
    );
    if (!existia) throw noExiste(`Webhook ${id} was not found`);
  }

  /** El secreto enmascarado; si no se puede descifrar (la clave cambió), solo `****`. */
  private enmascarado(secretoCifrado: string): string {
    try {
      return enmascarar(this.cifrado.descifrar(secretoCifrado));
    } catch {
      return '****';
    }
  }
}

const porOrdenDelContrato = (a: EventoWebhook, b: EventoWebhook) =>
  EVENTOS_WEBHOOK.indexOf(a) - EVENTOS_WEBHOOK.indexOf(b);
