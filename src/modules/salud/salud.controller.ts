import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Publico } from '../../common/decorators/publico.decorator';
import { SaludRespuestaDto } from './dto/salud-respuesta.dto';
import { SaludService } from './salud.service';

@ApiTags('Salud')
@Controller()
export class SaludController {
  constructor(private readonly servicio: SaludService) {}

  @Publico()
  @Get()
  @ApiOperation({ summary: 'Chequeo de vida: responde 200 solo si la base contesta' })
  @ApiOkResponse({ type: SaludRespuestaDto })
  @ApiServiceUnavailableResponse({ type: SaludRespuestaDto })
  async revisar(): Promise<SaludRespuestaDto> {
    const salud = await this.servicio.revisar();
    if (salud.status === 'DOWN') {
      throw new ServiceUnavailableException(salud);
    }
    return salud;
  }
}
