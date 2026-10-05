import { Body, Controller, Get, INestApplication, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, ValidateNested } from 'class-validator';
import * as request from 'supertest';
import {
  CodigoIataAerolineaPipe,
  CodigoIataAeropuertoPipe,
} from '../src/common/pipes/codigo-iata.pipe';
import { FechaPipe } from '../src/common/pipes/fecha.pipe';
import { UuidPipe } from '../src/common/pipes/uuid.pipe';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';
import { Publico } from '../src/common/decorators/publico.decorator';

class PasajeroPrueba {
  @IsString()
  nombre: string;

  @IsInt()
  @Min(0)
  @Max(120)
  edad: number;
}

class CuerpoPrueba {
  @IsString()
  origen: string;

  @ValidateNested({ each: true })
  @Type(() => PasajeroPrueba)
  pasajeros: PasajeroPrueba[];
}

// Las pruebas de transversales no prueban la autenticación
@Publico()
@Controller('prueba-validacion')
class ControllerDePrueba {
  @Post()
  crear(@Body() cuerpo: CuerpoPrueba) {
    return cuerpo;
  }

  @Get('uuid/:id')
  uuid(@Param('id', UuidPipe) id: string) {
    return { id };
  }

  @Get('fecha')
  fecha(@Query('date', FechaPipe) fecha: Date) {
    return { iso: fecha.toISOString() };
  }

  @Get('aeropuerto/:codigo')
  aeropuerto(@Param('codigo', CodigoIataAeropuertoPipe) codigo: string) {
    return { codigo };
  }

  @Get('aerolinea/:codigo')
  aerolinea(@Param('codigo', CodigoIataAerolineaPipe) codigo: string) {
    return { codigo };
  }
}

describe('Validación', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp([ControllerDePrueba]);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('ValidationPipe global', () => {
    it('acepta un cuerpo válido', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-validacion')
        .send({ origen: 'UIO', pasajeros: [{ nombre: 'Ana', edad: 30 }] });

      expect(respuesta.status).toBe(201);
    });

    it('un cuerpo inválido responde 400 VALIDATION_FAILED con el detalle de cada campo', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-validacion')
        .send({ origen: 5, pasajeros: [{ nombre: 'Ana', edad: 300 }] });

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('VALIDATION_FAILED');
      expect(respuesta.body.invalidParams).toEqual(
        expect.arrayContaining([
          { name: 'origen', reason: 'origen must be a string' },
          { name: 'pasajeros[0].edad', reason: 'edad must not be greater than 120' },
        ]),
      );
      expect(respuesta.body.detail).toContain('origen: origen must be a string');
      expect(respuesta.body.detail).toContain('pasajeros[0].edad');
    });

    it('un campo que el DTO no declara responde 400 VALIDATION_FAILED', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-validacion')
        .send({ origen: 'UIO', pasajeros: [], esAdministrador: true });

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('VALIDATION_FAILED');
      expect(respuesta.body.invalidParams).toEqual([
        { name: 'esAdministrador', reason: 'property esAdministrador should not exist' },
      ]);
    });

    it('un cuerpo vacío responde 400 y nombra los campos que faltan', async () => {
      const respuesta = await http().post('/flights/v1/prueba-validacion').send({});

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain('origen');
    });
  });

  describe('UuidPipe', () => {
    it('deja pasar un UUID', async () => {
      const id = '6dc5198e-dbbc-4949-82ac-f6589eaccb75';
      const respuesta = await http().get(`/flights/v1/prueba-validacion/uuid/${id}`).expect(200);
      expect(respuesta.body).toEqual({ id });
    });

    it('un UUID mal formado responde 400 como ProblemDetails', async () => {
      const respuesta = await http().get('/flights/v1/prueba-validacion/uuid/no-es-un-uuid');

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'id: must be a UUID',
        invalidParams: [{ name: 'id', reason: 'must be a UUID' }],
      });
    });
  });

  describe('FechaPipe', () => {
    it('entrega la fecha a medianoche UTC', async () => {
      const respuesta = await http()
        .get('/flights/v1/prueba-validacion/fecha?date=2026-12-01')
        .expect(200);
      expect(respuesta.body).toEqual({ iso: '2026-12-01T00:00:00.000Z' });
    });

    it('acepta el 29 de febrero de un año bisiesto', async () => {
      await http().get('/flights/v1/prueba-validacion/fecha?date=2028-02-29').expect(200);
    });

    it.each([
      '2026-02-30',
      '2027-02-29',
      '2026-13-01',
      '2026-1-5',
      '01-12-2026',
      '2026-12-01T00:00:00Z',
      '',
    ])('rechaza %p', async (fecha) => {
      const respuesta = await http().get(`/flights/v1/prueba-validacion/fecha?date=${fecha}`);

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
    });

    it('rechaza un date ausente', async () => {
      const respuesta = await http().get('/flights/v1/prueba-validacion/fecha');
      expect(respuesta.status).toBe(400);
    });
  });

  describe('códigos IATA', () => {
    it('aeropuerto: 3 letras mayúsculas', async () => {
      await http().get('/flights/v1/prueba-validacion/aeropuerto/UIO').expect(200);
      for (const malo of ['uio', 'UI', 'UIOO', 'U1O']) {
        const respuesta = await http().get(`/flights/v1/prueba-validacion/aeropuerto/${malo}`);
        expect(respuesta.status).toBe(400);
        esperarProblemDetails(respuesta);
      }
    });

    it('aerolínea: 2 caracteres mayúsculas o dígitos', async () => {
      await http().get('/flights/v1/prueba-validacion/aerolinea/LA').expect(200);
      await http().get('/flights/v1/prueba-validacion/aerolinea/4O').expect(200);
      for (const malo of ['la', 'L', 'LAN', 'L-']) {
        const respuesta = await http().get(`/flights/v1/prueba-validacion/aerolinea/${malo}`);
        expect(respuesta.status).toBe(400);
        esperarProblemDetails(respuesta);
      }
    });
  });
});
