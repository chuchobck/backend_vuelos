import { plainToInstance } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, Min, validateSync } from 'class-validator';

export const ENTORNOS = ['development', 'production', 'test'] as const;
export type Entorno = (typeof ENTORNOS)[number];

/**
 * Variables de entorno que la API necesita para arrancar. Ninguna tiene valor por
 * defecto: si falta una o tiene un formato inválido, la API no levanta.
 */
export class VariablesEntorno {
  // class-validator evalúa de abajo hacia arriba: lo obligatorio va pegado a la propiedad.
  @Matches(/^postgres(ql)?:\/\/\S+$/, {
    message: 'DATABASE_URL debe ser una URL de PostgreSQL (postgresql://...)',
  })
  @IsString({ message: 'DATABASE_URL es obligatoria' })
  DATABASE_URL: string;

  @Min(1, { message: 'PORT debe estar entre 1 y 65535' })
  @Max(65535, { message: 'PORT debe estar entre 1 y 65535' })
  @IsInt({ message: 'PORT es obligatorio y debe ser un número entero' })
  PORT: number;

  @IsIn(ENTORNOS, { message: `NODE_ENV es obligatorio y debe ser uno de: ${ENTORNOS.join(', ')}` })
  NODE_ENV: Entorno;
}

/** Se pasa a ConfigModule.forRoot({ validate }); corre una sola vez, al arrancar. */
export function validarEntorno(config: Record<string, unknown>): VariablesEntorno {
  const variables = plainToInstance(VariablesEntorno, config, { enableImplicitConversion: true });
  const errores = validateSync(variables, { stopAtFirstError: true });

  if (errores.length > 0) {
    const detalle = errores
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n');
    throw new Error(`Variables de entorno inválidas o faltantes:\n${detalle}`);
  }
  return variables;
}
