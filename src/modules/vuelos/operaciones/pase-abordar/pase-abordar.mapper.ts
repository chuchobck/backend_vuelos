import { TIPO_CODIGO_BARRAS } from '../../compartido/enums';
import { ListaPasesDto, PaseAbordarDto } from './dto/pase-abordar.dto';
import { PaseAbordar } from './pase-abordar.modelo';

export function aPaseAbordar(pase: PaseAbordar): PaseAbordarDto {
  return {
    passengerId: pase.codigoPasajero,
    segmentId: pase.salidaId,
    seat: pase.asiento,
    boardingGroup: pase.grupo,
    boardingPosition: pase.posicion,
    barcode: pase.codigoBarras,
    barcodeType: TIPO_CODIGO_BARRAS.aContrato(pase.tipoCodigoBarras),
  };
}

export function aListaPases(reservaId: string, pases: PaseAbordar[]): ListaPasesDto {
  return { bookingId: reservaId, boardingPasses: pases.map(aPaseAbordar) };
}
