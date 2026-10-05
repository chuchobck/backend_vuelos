import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Dueño de la conexión a PostgreSQL. Solo los repositories lo inyectan y usan `db`.
 *
 * Prisma 7 se conecta con el adaptador de `pg`, que no lee el `?schema=` de la URL:
 * el esquema se toma de la URL y se pasa aparte (por defecto, `vuelos`).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly db: PrismaClient;

  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('DATABASE_URL');
    const adaptador = new PrismaPg({ connectionString: url }, { schema: esquemaDeUrl(url) });
    this.db = new PrismaClient({ adapter: adaptador });
  }

  async onModuleInit(): Promise<void> {
    await this.db.$connect();
    this.logger.log('Conectado a PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}

function esquemaDeUrl(url: string): string {
  return new URL(url).searchParams.get('schema') ?? 'vuelos';
}
