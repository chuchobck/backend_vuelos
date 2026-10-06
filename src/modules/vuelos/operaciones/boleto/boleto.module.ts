import { Module } from '@nestjs/common';
import { GeneradorCodigos } from '../../compartido/generador-codigos';
import { BoletoRepository } from './boleto.repository';
import { BoletoService } from './boleto.service';

/**
 * Boletos y cupones (boleto_cabecera, boleto_detalle). Los crea y emite la reserva; sus rutas
 * (/bookings/{bookingId}/tickets) cuelgan de las de reserva. boleto_detalle no tiene controller.
 * GeneradorCodigos (PNR y número de boleto) se exporta para que reserva use la misma instancia.
 */
@Module({
  providers: [BoletoService, BoletoRepository, GeneradorCodigos],
  exports: [BoletoService, GeneradorCodigos],
})
export class BoletoModule {}
