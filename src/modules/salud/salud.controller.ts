import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SinLimiteDePeticiones } from '../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../common/decorators/publico.decorator';
import { CONTENT_TYPE_PROBLEMA, ProblemDetails } from '../../common/errores/problem-details';
import { ETIQUETAS } from '../../config/swagger';
import { SaludRespuestaDto } from './dto/salud-respuesta.dto';
import { SaludService } from './salud.service';

@ApiTags(ETIQUETAS.salud)
@ApiExtraModels(ProblemDetails)
@Controller()
export class SaludController {
  constructor(private readonly servicio: SaludService) {}

  @Publico()
  // El sondeo periódico de Render viene siempre de la misma IP: un 429 aquí daría el servicio por caído
  @SinLimiteDePeticiones()
  @Get()
  @ApiOperation({ summary: 'Chequeo de vida: responde 200 solo si la base contesta' })
  @ApiOkResponse({ type: SaludRespuestaDto })
  @ApiServiceUnavailableResponse({
    description: 'La base no responde',
    content: { [CONTENT_TYPE_PROBLEMA]: { schema: { $ref: getSchemaPath(ProblemDetails) } } },
  })
  async revisar(): Promise<SaludRespuestaDto> {
    const salud = await this.servicio.revisar();
    if (salud.status === 'DOWN') {
      throw new ServiceUnavailableException('The database is not responding');
    }
    return salud;
  }
}
