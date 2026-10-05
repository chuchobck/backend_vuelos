import { applyDecorators, Controller, HttpCode, Type } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiProblema } from '../../../../common/decorators/documentacion.decorator';
import { Scopes } from '../../../../common/decorators/scopes.decorator';

/**
 * Controller del catálogo: sin prefijo (la ruta sale de su .routes.ts), con su etiqueta
 * "Admin · <Entidad>" y solo para `flights:admin`. @Scopes ya documenta el candado, el 401 y
 * el 403; aquí se agrega el 400 de validación, común a todas las rutas.
 */
export function ControllerAdmin(etiqueta: string) {
  return applyDecorators(
    Controller(),
    ApiTags(etiqueta),
    Scopes('flights:admin'),
    ApiProblema(400, 'Parámetro o cuerpo inválido'),
  );
}

/** Respuesta `{ nextCursor, items }`, la forma de las listas paginadas del contrato. */
function ApiPagina(tipo: Type) {
  return applyDecorators(
    ApiExtraModels(tipo),
    ApiOkResponse({
      description: 'Una página. Sin `nextCursor`, no hay más',
      schema: {
        type: 'object',
        required: ['items'],
        properties: {
          nextCursor: { type: 'string', description: 'Pásalo como `cursor` para la siguiente' },
          items: { type: 'array', items: { $ref: getSchemaPath(tipo) } },
        },
      },
    }),
  );
}

const NO_ENCONTRADO = () => ApiProblema(404, 'No existe');
const REFERENCIA = () =>
  ApiProblema(422, 'Apunta a una fila que no existe o está dada de baja, o rompe una regla');

/** Documentación de las seis rutas de cada entidad del catálogo. */
export const DocCatalogo = {
  listar: (entidad: string, tipo: Type) =>
    applyDecorators(
      ApiOperation({ summary: `Listar ${entidad} (sin los dados de baja, salvo includeInactive)` }),
      ApiPagina(tipo),
    ),

  obtener: (entidad: string, tipo: Type) =>
    applyDecorators(
      ApiOperation({ summary: `Ver ${entidad}, también si está dado de baja` }),
      ApiOkResponse({ type: tipo }),
      NO_ENCONTRADO(),
    ),

  crear: (entidad: string, tipo: Type) =>
    applyDecorators(
      ApiOperation({ summary: `Crear ${entidad}` }),
      ApiCreatedResponse({ type: tipo }),
      ApiProblema(409, 'Ya existe con esa clave'),
      REFERENCIA(),
    ),

  actualizar: (entidad: string, tipo: Type) =>
    applyDecorators(
      ApiOperation({ summary: `Modificar ${entidad} (solo los campos enviados)` }),
      ApiOkResponse({ type: tipo }),
      NO_ENCONTRADO(),
      ApiProblema(409, 'Choca con otra fila o con el estado actual'),
      REFERENCIA(),
    ),

  desactivar: (entidad: string) =>
    applyDecorators(
      HttpCode(204),
      ApiOperation({
        summary: `Dar de baja ${entidad} (eliminación lógica)`,
        description: 'No borra la fila: la deja inactiva. Repetirlo no cambia nada.',
      }),
      ApiNoContentResponse({ description: 'Dado de baja' }),
      NO_ENCONTRADO(),
      ApiProblema(409, 'Otras filas activas lo usan'),
    ),

  reactivar: (entidad: string, tipo: Type) =>
    applyDecorators(
      HttpCode(200),
      ApiOperation({ summary: `Reactivar ${entidad} dado de baja` }),
      ApiOkResponse({ type: tipo }),
      NO_ENCONTRADO(),
      ApiProblema(409, 'El estado actual no lo permite'),
      REFERENCIA(),
    ),
};
