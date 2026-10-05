import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import * as request from 'supertest';
import { TextoLimpio } from '../src/common/sanitizacion/texto-limpio.decorator';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';

/** Un carácter por su punto de código: así los invisibles se ven en el código de la prueba. */
const car = (codigo: number) => String.fromCodePoint(codigo);

/** DTO de prueba: así se usa @TextoLimpio en un DTO real. */
class PasajeroPruebaDto {
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(100)
  nombre: string;

  @TextoLimpio({ multilinea: true })
  @IsOptional()
  @MaxLength(500)
  observaciones?: string;

  @TextoLimpio({ each: true })
  @IsOptional()
  alias?: string[];
}

@Controller('prueba-sanitizacion')
class ControllerDePrueba {
  @Post()
  crear(@Body() cuerpo: PasajeroPruebaDto) {
    return cuerpo;
  }
}

describe('Sanitización de texto', () => {
  let app: INestApplication;
  const enviar = (cuerpo: object) =>
    request(app.getHttpServer()).post('/flights/v1/prueba-sanitizacion').send(cuerpo);

  beforeAll(async () => {
    app = await crearApp([ControllerDePrueba]);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('lo que se limpia sin cambiar el significado', () => {
    it('recorta los espacios de los bordes', async () => {
      const respuesta = await enviar({ nombre: '   Ana María  ' }).expect(201);
      expect(respuesta.body.nombre).toBe('Ana María');
    });

    it('normaliza a NFC: una e y un acento combinado pasan a una sola é', async () => {
      const descompuesto = 'Jose' + car(0x0301);
      expect(descompuesto).toHaveLength(5);

      const respuesta = await enviar({ nombre: descompuesto }).expect(201);

      expect(respuesta.body.nombre).toBe('José');
      expect(respuesta.body.nombre).toHaveLength(4);
    });

    it('deja pasar texto normal con símbolos que no son HTML', async () => {
      for (const nombre of [
        "O'Brien & Sons",
        'a < b',
        'Juan <3',
        'x < script>',
        'Ñandú 100%',
        '李小龍',
      ]) {
        const respuesta = await enviar({ nombre }).expect(201);
        expect(respuesta.body.nombre).toBe(nombre);
      }
    });

    it('un texto de varias líneas se permite si el campo es multilinea', async () => {
      const respuesta = await enviar({ nombre: 'Ana', observaciones: 'línea 1\nlínea 2\tfin' });
      expect(respuesta.status).toBe(201);
      expect(respuesta.body.observaciones).toBe('línea 1\nlínea 2\tfin');
    });

    it('aplica la regla a cada elemento de un arreglo (each)', async () => {
      const respuesta = await enviar({ nombre: 'Ana', alias: ['  uno ', 'dos'] }).expect(201);
      expect(respuesta.body.alias).toEqual(['uno', 'dos']);
    });
  });

  describe('lo que se rechaza con 400 VALIDATION_FAILED', () => {
    it.each([
      ['un NUL', 'Ana' + car(0x0000) + 'Maria'],
      ['un salto de línea en un campo de una línea', 'Ana\nMaría'],
      ['una tabulación en un campo de una línea', 'Ana\tMaría'],
      ['un carácter de control C1', 'Ana' + car(0x0085) + 'Maria'],
      ['una anulación bidireccional (U+202E)', 'Ana' + car(0x202e) + 'odnal'],
      ['un espacio de ancho cero', 'Ana' + car(0x200b) + 'Maria'],
      ['un DEL', 'Ana' + car(0x007f)],
      ['una etiqueta <script>', '<script>alert(1)</script>'],
      ['una etiqueta de cierre', 'Ana</b>'],
      ['una etiqueta con atributos', 'x <img src=x onerror=alert(1)>'],
      ['un comentario HTML', 'Ana <!-- -->'],
    ])('rechaza %s', async (_caso, nombre) => {
      const respuesta = await enviar({ nombre });

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('VALIDATION_FAILED');
      expect(respuesta.body.invalidParams[0].name).toBe('nombre');
    });

    it('rechaza un texto vacío tras recortar', async () => {
      const respuesta = await enviar({ nombre: '    ' });

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
    });

    it('rechaza un valor que no es texto', async () => {
      const respuesta = await enviar({ nombre: 123 });

      expect(respuesta.status).toBe(400);
      expect(respuesta.body.invalidParams).toEqual(
        expect.arrayContaining([{ name: 'nombre', reason: 'nombre must be a string' }]),
      );
    });

    it('un control en la observación multilínea (no un salto) también se rechaza', async () => {
      const respuesta = await enviar({ nombre: 'Ana', observaciones: 'hola' + car(0x0000) });

      expect(respuesta.status).toBe(400);
      expect(respuesta.body.invalidParams[0].name).toBe('observaciones');
    });

    it('rechaza una etiqueta dentro de un arreglo (each)', async () => {
      const respuesta = await enviar({ nombre: 'Ana', alias: ['ok', '<b>mal</b>'] });

      expect(respuesta.status).toBe(400);
      expect(respuesta.body.invalidParams[0].name).toBe('alias');
    });

    it('el mensaje no repite el texto enviado', async () => {
      const respuesta = await enviar({ nombre: '<script>alert(1)</script>' });

      expect(respuesta.text).not.toContain('alert');
    });
  });
});
