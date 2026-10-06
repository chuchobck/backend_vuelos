import { Body, Controller, Header, HttpCode, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
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
import { ETIQUETAS } from '../../../../config/swagger';
import { CABECERA_REPETIDA } from '../retencion/retencion.controller';
import { DetalleReservaDto } from './dto/respuesta-reserva.dto';
import { SolicitudReservaDto } from './dto/solicitud-reserva.dto';
import { aDetalleReserva } from './reserva.mapper';
import { REGLAS_RESERVA, ReservaService } from './reserva.service';

/**
 * Límite propio de POST /bookings, aparte del global (100 por minuto e IP): cada reserva
 * consume un hold, bloquea el inventario de sus cabinas mientras elige asientos y emite boletos.
 * 10 por minuto e IP alcanza para reintentos y para varias personas detrás de una misma
 * salida a internet; un cliente normal reserva una vez por hold.
 */
export const LIMITE_RESERVA = { limite: 10, ventanaSegundos: 60 };

@ApiTags(ETIQUETAS.reservas)
@Controller()
export class ReservaController {
  constructor(private readonly servicio: ReservaService) {}

  @Scopes('flights:book')
  @LimiteEstricto(LIMITE_RESERVA.limite, LIMITE_RESERVA.ventanaSegundos)
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Crear reserva y gestionar emisión de ticket',
    description:
      'El dueño sale del JWT (el mismo del hold); el cuerpo no lo trae. Consume el hold, registra ' +
      'los pasajeros (los mismos tipos y cantidades del hold), asigna asientos (el elegido o el ' +
      'primero libre de la cabina) y juzga paymentReference con la Payment API (simulada: PAY-OK-… ' +
      'aprobado, PAY-PEND-… pendiente, PAY-REJ-… rechazado). Aprobado: 201 con los boletos emitidos. ' +
      'Pendiente: 202 en PENDING_PAYMENT; un proceso emite los boletos cuando el pago se aprueba. ' +
      'Rechazado: 422 y no queda reserva (el hold sigue). La misma Idempotency-Key con el mismo ' +
      `cuerpo devuelve la misma reserva (con ${CABECERA_REPETIDA}: true) durante ` +
      `${REGLAS_RESERVA.vigenciaClaveHoras} horas.`,
  })
  @ApiHeader({
    name: CABECERA_IDEMPOTENCIA,
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: 'Una por intento lógico de reserva; se reusa solo al reintentar el mismo cuerpo',
  })
  @ApiCreatedResponse({ type: DetalleReservaDto, description: 'Reserva creada y boletos emitidos' })
  @ApiAcceptedResponse({
    type: DetalleReservaDto,
    description: 'Reserva creada; el pago sigue pendiente y la emisión continúa después',
  })
  @ApiProblema(400, 'Cuerpo inválido (pasajeros, documento, contacto) o Idempotency-Key ausente')
  @ApiProblema(
    409,
    'El hold ya se usó en otra reserva, la referencia de pago ya se usó, el asiento está ' +
      'ocupado (SEAT_TAKEN) o el vuelo ya salió',
  )
  @ApiProblema(410, 'El hold venció o se liberó')
  @ApiProblema(
    422,
    'El hold no existe o es de otro usuario, los pasajeros no son los del hold, la edad no es la ' +
      'del tipo, el asiento es de otra cabina, el pago no es válido o no se autorizó, o la ' +
      'Idempotency-Key ya se usó con otro cuerpo',
  )
  @ApiProblema(
    429,
    `Más de ${LIMITE_RESERVA.limite} reservas por IP en un minuto (con Retry-After)`,
  )
  async crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @ClaveIdempotencia() clave: string,
    @Body() solicitud: SolicitudReservaDto,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<DetalleReservaDto> {
    const { reserva, codigoHttp, repetida } = await this.servicio.crear(
      solicitud,
      usuario.id,
      clave,
    );
    respuesta.status(codigoHttp);
    if (repetida) respuesta.setHeader(CABECERA_REPETIDA, 'true');
    return aDetalleReserva(reserva);
  }
}
