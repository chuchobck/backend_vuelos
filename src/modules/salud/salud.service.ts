import { Injectable, Logger } from '@nestjs/common';
import { SaludRespuestaDto } from './dto/salud-respuesta.dto';
import { resumirError } from '../../prisma/prisma.service';
import { SaludRepository } from './salud.repository';

@Injectable()
export class SaludService {
  private readonly logger = new Logger(SaludService.name);

  constructor(private readonly repositorio: SaludRepository) {}

  async revisar(): Promise<SaludRespuestaDto> {
    let baseDisponible = true;
    try {
      await this.repositorio.consultarBase();
    } catch (error) {
      baseDisponible = false;
      this.logger.error(`La base no responde: ${resumirError(error)}`);
    }

    const estado = baseDisponible ? 'UP' : 'DOWN';
    return { status: estado, database: estado, timestamp: new Date().toISOString() };
  }
}
