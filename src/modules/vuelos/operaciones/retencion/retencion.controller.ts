import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  CABECERA_IDEMPOTENCIA,
  ClaveIdempotencia,
} from '../../../../common/decorators/clave-idempotencia.decorator';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../../common/decorators/limite-peticiones.decorator';
import { Scopes } from '../../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../../config/swagger';
import { EstadoRetencionDto, RetencionCreadaDto } from './dto/respuesta-retencion.dto';
import { aEstadoRetencion } from './retencion.mapper';
import { SolicitudRetencionDto } from './dto/solicitud-retencion.dto';
import { REGLAS_RETENCION, RetencionService } from './retencion.service';

/**
 * Límite propio de POST /offers/hold, aparte del global (100 por minuto e IP): cada hold toma
 * cupo real. 30 por minuto e IP alcanza para reintentos y varios pasajeros detrás de una misma
 * salida a internet, y frena a quien quiera vaciar un vuelo reteniéndolo.
 */
export const LIMITE_RETENCION = { limite: 30, ventanaSegundos: 60 };

/** Cabecera que marca una respuesta repetida por Idempotency-Key (no la pide el contrato). */
export const CABECERA_REPETIDA = 'Idempotent-Replayed';

@ApiTags(ETIQUETAS.retencion)
@Controller()
export class RetencionController {
  constructor(private readonly servicio: RetencionService) {}

  @Scopes('flights:hold')
  @LimiteEstricto(LIMITE_RETENCION.limite, LIMITE_RETENCION.ventanaSegundos)
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Bloquear inventario',
    description:
      'Toma el cupo de los pasajeros con asiento (los infantes viajan en brazos) en la cabina ' +
      'elegida de cada segmento y congela el precio de hoy para todos los pasajeros. Hace falta ' +
      'una selección por cada itinerario de la oferta. El hold vence a los ' +
      `${REGLAS_RETENCION.vigenciaPorDefectoMinutos} minutos (HOLD_TTL_MINUTES) y entonces el cupo ` +
      'vuelve. La misma Idempotency-Key con el mismo cuerpo devuelve la misma respuesta (201, ' +
      `con ${CABECERA_REPETIDA}: true) durante ${REGLAS_RETENCION.vigenciaClaveHoras} horas.`,
  })
  @ApiHeader({
    name: CABECERA_IDEMPOTENCIA,
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: 'Una por intento lógico de hold; se reusa solo al reintentar el mismo cuerpo',
  })
  @ApiCreatedResponse({ type: RetencionCreadaDto, description: 'Inventario retenido' })
  @ApiProblema(400, 'Cuerpo inválido, itinerario repetido o Idempotency-Key ausente o no uuid')
  @ApiProblema(
    409,
    'OFFER_NO_LONGER_AVAILABLE: la oferta no existe o venció, la tarifa ya no se vende o no ' +
      'queda cupo para todos los pasajeros',
  )
  @ApiProblema(
    422,
    'El itinerario no es de la oferta, faltan itinerarios, la familia no existe para la ' +
      'aerolínea, o la Idempotency-Key ya se usó con otro cuerpo',
  )
  @ApiProblema(429, `Más de ${LIMITE_RETENCION.limite} holds por IP en un minuto (con Retry-After)`)
  async crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @ClaveIdempotencia() clave: string,
    @Body() solicitud: SolicitudRetencionDto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<RetencionCreadaDto> {
    const { cuerpo, repetida } = await this.servicio.crear(solicitud, usuario.id, clave);
    if (repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return cuerpo;
  }

  @Scopes('flights:read')
  @Get(':holdId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Consultar estado de un hold',
    description:
      'El dueño consulta el suyo; un administrador, cualquiera. Un hold de otro usuario responde ' +
      '404, como uno que no existe. Si ya venció, responde EXPIRED (y el cupo ya volvió).',
  })
  @ApiParam({ name: 'holdId', format: 'uuid', description: 'holdId de POST /offers/hold' })
  @ApiOkResponse({ type: EstadoRetencionDto, description: 'HELD, RELEASED, EXPIRED o CONSUMED' })
  @ApiProblema(400, 'holdId no es un uuid')
  @ApiProblema(404, 'El hold no existe o es de otro usuario')
  async consultar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('holdId', UuidPipe) holdId: string,
  ): Promise<EstadoRetencionDto> {
    const { retencion, ahora } = await this.servicio.consultar(holdId, usuario);
    return aEstadoRetencion(retencion, ahora);
  }

  @Scopes('flights:hold')
  @Delete(':holdId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Liberar hold anticipadamente',
    description:
      'Devuelve el cupo y deja el hold RELEASED. Liberar uno ya liberado o vencido no cambia nada ' +
      '(204). Solo lo libera su dueño.',
  })
  @ApiParam({ name: 'holdId', format: 'uuid', description: 'holdId de POST /offers/hold' })
  @ApiNoContentResponse({ description: 'Liberado exitosamente' })
  @ApiProblema(400, 'holdId no es un uuid')
  @ApiProblema(404, 'El hold no existe o es de otro usuario')
  @ApiProblema(409, 'El hold ya se usó en una reserva (fuera del contrato: se cancela la reserva)')
  async liberar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('holdId', UuidPipe) holdId: string,
  ): Promise<void> {
    await this.servicio.liberar(holdId, usuario);
  }
}
