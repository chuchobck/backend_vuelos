import { desactivarUsuariosDePrueba } from './utils/auth';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo, enDias, sufijo } from './utils/catalogo';
import { esperarProblemDetails } from './utils/problem-details';

type Cuerpo = Record<string, unknown>;

/**
 * CRUD de administración del catálogo contra la base real. Las pruebas arman su propia cadena
 * (país → ciudad → aeropuertos → aerolínea, modelo → familia, mapa → vuelo → salida → tarifa)
 * y prueban los bloqueos sobre ella; la semilla solo se lee. No se borra nada: al final todo
 * lo creado queda dado de baja, en orden inverso, y eso prueba la baja de cada entidad.
 *
 * Los tests de este archivo comparten la cadena y corren en orden.
 */
describe('Catálogo de administración', () => {
  let c: AppCatalogo;
  /**
   * La última fila de auditoría antes de las pruebas. Se compara por id y no por hora: el reloj
   * de la máquina de pruebas (WSL) puede saltar respecto del de PostgreSQL.
   */
  let auditoriaInicial = 0n;

  /** Claves de lo que crean las pruebas. */
  const k = {
    pais: '',
    iso3: '',
    ciudad: '',
    aeropuerto1: '',
    aeropuerto2: '',
    aerolinea: '',
    modelo: '',
    familia: '',
    mapa: '',
    vuelo: '',
    salida: '',
    tarifa: '',
    retencion: '',
  };

  beforeAll(async () => {
    c = await crearAppCatalogo();
    const [{ ultima }] = await c.prisma.db.$queryRaw<Array<{ ultima: bigint }>>`
      SELECT coalesce(max(id), 0) AS ultima FROM vuelos.auditoria`;
    auditoriaInicial = ultima;
    k.pais = await codigos.pais(c.prisma);
    k.iso3 = await codigos.paisIso3(c.prisma);
    k.aeropuerto1 = await codigos.aeropuerto(c.prisma);
    do k.aeropuerto2 = await codigos.aeropuerto(c.prisma);
    while (k.aeropuerto2 === k.aeropuerto1);
    k.aerolinea = await codigos.aerolinea(c.prisma);
    k.modelo = await codigos.modelo(c.prisma);
  });

  afterAll(async () => {
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  /** Todas las claves de una lista, recorriendo las páginas con el cursor. */
  async function clavesDeLista(
    ruta: string,
    query: Record<string, string>,
    claveDe: (item: Cuerpo) => string,
  ): Promise<string[]> {
    const claves: string[] = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 100; pagina++) {
      const respuesta = await c
        .admin('get', ruta)
        .query({ ...query, limit: '50', ...(cursor ? { cursor } : {}) })
        .expect(200);
      claves.push(...(respuesta.body.items as Cuerpo[]).map(claveDe));
      cursor = respuesta.body.nextCursor;
      if (!cursor) break;
    }
    return claves;
  }

  async function esperarError(
    respuesta: { status: number; type: string; body: Cuerpo },
    status: number,
    detalle?: string | RegExp,
  ): Promise<void> {
    expect(respuesta.status).toBe(status);
    esperarProblemDetails(respuesta);
    if (detalle !== undefined) expect(respuesta.body.detail).toMatch(detalle);
  }

  describe('seguridad: todas las rutas exigen flights:admin', () => {
    const RUTAS = [
      'countries',
      'cities',
      'airports',
      'airlines',
      'aircraft-models',
      'fare-families',
      'seat-maps',
      'flights',
      'departures',
      'fares',
    ];

    it.each(RUTAS)(
      '/admin/%s: 401 sin token, 403 con cliente, 200 con administrador',
      async (r) => {
        const sinToken = await c.anonimo('get', `${ADMIN}/${r}`);
        await esperarError(sinToken, 401);
        expect(sinToken.headers['www-authenticate']).toBe('Bearer realm="quinde-vuelos-api"');

        const cliente = await c.cliente('get', `${ADMIN}/${r}`);
        await esperarError(cliente, 403, 'Missing required scopes: flights:admin');
        expect(cliente.headers['www-authenticate']).toContain('error="insufficient_scope"');

        const admin = await c.admin('get', `${ADMIN}/${r}`).expect(200);
        expect(Array.isArray(admin.body.items)).toBe(true);
      },
    );

    it('un cliente tampoco puede escribir', async () => {
      await esperarError(await c.cliente('post', `${ADMIN}/countries`, { code: 'QZ' }), 403);
      await esperarError(await c.cliente('delete', `${ADMIN}/airports/UIO`), 403);
    });
  });

  describe('país', () => {
    it('crea, lee y modifica; el código es el id', async () => {
      const creado = await c
        .admin('post', `${ADMIN}/countries`, { code: k.pais, iso3: k.iso3, name: `País ${k.pais}` })
        .expect(201);
      expect(creado.body).toEqual({
        code: k.pais,
        iso3: k.iso3,
        name: `País ${k.pais}`,
        active: true,
      });

      // El nombre del país es único: cada corrida usa uno nuevo (con espacios que se recortan)
      const nombre = `País renombrado ${sufijo()}`;
      await c.admin('patch', `${ADMIN}/countries/${k.pais}`, { name: `  ${nombre} ` }).expect(200);
      const leido = await c.admin('get', `${ADMIN}/countries/${k.pais}`).expect(200);
      expect(leido.body.name).toBe(nombre);
    });

    it('código o alfa-3 repetidos: 409', async () => {
      await esperarError(
        await c.admin('post', `${ADMIN}/countries`, { code: 'EC', iso3: 'ZZZ', name: 'Otro' }),
        409,
        'A country with this code already exists',
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/countries`, {
          code: k.pais === 'QQ' ? 'QR' : 'QQ',
          iso3: 'ECU',
          name: 'X',
        }),
        409,
      );
    });

    it('formato inválido, campo extra o código que no se puede cambiar: 400', async () => {
      await esperarError(
        await c.admin('post', `${ADMIN}/countries`, { code: 'ec', iso3: 'ECU', name: 'x' }),
        400,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/countries`, { code: 'QA', iso3: 'QAT', name: '<b>x</b>' }),
        400,
      );
      await esperarError(
        await c.admin('patch', `${ADMIN}/countries/${k.pais}`, { code: 'ZZ' }),
        400,
      );
      await esperarError(await c.admin('get', `${ADMIN}/countries/ecu`), 400);
    });

    it('un código que no existe: 404', async () => {
      const codigo = await codigos.pais(c.prisma);
      await esperarError(
        await c.admin('get', `${ADMIN}/countries/${codigo}`),
        404,
        `Country ${codigo} was not found`,
      );
    });
  });

  describe('ciudad', () => {
    it('crea en el país, con uuid como id y la zona por defecto', async () => {
      const creada = await c
        .admin('post', `${ADMIN}/cities`, { country: k.pais, name: `Ciudad ${sufijo()}` })
        .expect(201);
      expect(creada.body).toMatchObject({
        country: k.pais,
        timeZone: 'America/Guayaquil',
        active: true,
      });
      expect(creada.body.id).toMatch(/^[0-9a-f-]{36}$/);
      k.ciudad = creada.body.id;

      const lista = await clavesDeLista(
        `${ADMIN}/cities`,
        { country: k.pais },
        (i) => i.id as string,
      );
      expect(lista).toEqual([k.ciudad]);
    });

    it('país inexistente: 422; nombre repetido en el país: 409; zona inválida: 400', async () => {
      await esperarError(
        await c.admin('post', `${ADMIN}/cities`, {
          country: await codigos.pais(c.prisma),
          name: 'X',
        }),
        422,
        /does not exist or is inactive/,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/cities`, { country: 'EC', name: 'Quito' }),
        409,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/cities`, {
          country: k.pais,
          name: 'Y',
          timeZone: 'Marte/Olimpo',
        }),
        400,
      );
    });

    it('uuid mal formado: 400; uuid inexistente: 404', async () => {
      await esperarError(await c.admin('get', `${ADMIN}/cities/no-es-uuid`), 400);
      await esperarError(
        await c.admin('get', `${ADMIN}/cities/00000000-0000-4000-8000-000000000000`),
        404,
      );
    });
  });

  describe('aeropuerto', () => {
    it('crea dos en la ciudad', async () => {
      for (const codigo of [k.aeropuerto1, k.aeropuerto2]) {
        const creado = await c
          .admin('post', `${ADMIN}/airports`, {
            code: codigo,
            name: `Aeropuerto ${codigo}`,
            cityId: k.ciudad,
          })
          .expect(201);
        expect(creado.body).toMatchObject({
          code: codigo,
          cityId: k.ciudad,
          country: k.pais,
          active: true,
        });
      }
    });

    it('ciudad inexistente: 422; código repetido: 409; código en minúsculas: 400', async () => {
      await esperarError(
        await c.admin('post', `${ADMIN}/airports`, {
          code: await codigos.aeropuerto(c.prisma),
          name: 'X',
          cityId: '00000000-0000-4000-8000-000000000000',
        }),
        422,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/airports`, { code: 'UIO', name: 'X', cityId: k.ciudad }),
        409,
        'An airport with this IATA code already exists',
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/airports`, { code: 'uio', name: 'X', cityId: k.ciudad }),
        400,
      );
    });
  });

  describe('aerolínea y modelo de aeronave', () => {
    it('crea una aerolínea con prefijo de boleto y lo quita con null', async () => {
      const prefijo = await codigos.prefijoBoleto(c.prisma);
      const creada = await c
        .admin('post', `${ADMIN}/airlines`, {
          code: k.aerolinea,
          name: 'Aerolínea de prueba',
          ticketPrefix: prefijo,
        })
        .expect(201);
      expect(creada.body).toEqual({
        code: k.aerolinea,
        name: 'Aerolínea de prueba',
        ticketPrefix: prefijo,
        active: true,
      });
      const sinPrefijo = await c
        .admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null })
        .expect(200);
      expect(sinPrefijo.body.ticketPrefix).toBeNull();
    });

    it('aerolínea: código o prefijo repetidos 409, prefijo de 2 dígitos 400', async () => {
      await esperarError(
        await c.admin('post', `${ADMIN}/airlines`, { code: 'AV', name: 'X' }),
        409,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/airlines`, {
          code: await codigos.aerolinea(c.prisma),
          name: 'X',
          ticketPrefix: '134',
        }),
        409,
        'Another airline already uses this ticket prefix',
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/airlines`, { code: 'ZZ', name: 'X', ticketPrefix: '13' }),
        400,
      );
    });

    it('crea un modelo; código repetido 409', async () => {
      await c
        .admin('post', `${ADMIN}/aircraft-models`, { code: k.modelo, name: 'Modelo de prueba' })
        .expect(201);
      await esperarError(
        await c.admin('post', `${ADMIN}/aircraft-models`, { code: '320', name: 'X' }),
        409,
      );
      await esperarError(await c.admin('get', `${ADMIN}/aircraft-models/A320`), 400);
    });
  });

  describe('familia tarifaria', () => {
    it('crea con el porcentaje en texto y refundable derivado', async () => {
      const creada = await c
        .admin('post', `${ADMIN}/fare-families`, {
          airline: k.aerolinea,
          cabinClass: 'ECONOMY',
          code: 'PRUEBA',
          name: 'Prueba',
          changeable: true,
          cancellationPenaltyPercent: '12.5',
        })
        .expect(201);
      expect(creada.body).toMatchObject({
        airline: k.aerolinea,
        cabinClass: 'ECONOMY',
        code: 'PRUEBA',
        cancellationPenaltyPercent: '12.50',
        refundable: true,
        personalItemIncluded: true,
        checkedBagsIncluded: 0,
        maxExtraBags: 3,
      });
      k.familia = creada.body.id;

      const noReembolsable = await c
        .admin('patch', `${ADMIN}/fare-families/${k.familia}`, {
          cancellationPenaltyPercent: '100',
        })
        .expect(200);
      expect(noReembolsable.body).toMatchObject({
        cancellationPenaltyPercent: '100.00',
        refundable: false,
      });
    });

    it('repetida en la misma aerolínea y cabina 409; aerolínea inexistente 422; valores fuera de rango 400', async () => {
      const base = {
        airline: k.aerolinea,
        cabinClass: 'ECONOMY',
        code: 'PRUEBA',
        name: 'X',
        changeable: false,
      };
      await esperarError(await c.admin('post', `${ADMIN}/fare-families`, base), 409);
      await esperarError(
        await c.admin('post', `${ADMIN}/fare-families`, {
          ...base,
          airline: await codigos.aerolinea(c.prisma),
        }),
        422,
      );
      for (const malo of [
        { cabinClass: 'ECONOMICA' },
        { cancellationPenaltyPercent: '100.5' },
        { cancellationPenaltyPercent: 30 },
        { maxExtraBags: 11 },
        { code: 'minusculas' },
      ]) {
        await esperarError(
          await c.admin('post', `${ADMIN}/fare-families`, { ...base, code: 'OTRA', ...malo }),
          400,
        );
      }
    });
  });

  describe('mapa de asientos', () => {
    const fila = (numero: number, cabina: string, letras: string) => ({
      number: numero,
      cabinClass: cabina,
      seats: [...letras].map((letra, i) => ({
        letter: letra,
        position: i === 0 || i === letras.length - 1 ? 'WINDOW' : 'AISLE',
      })),
    });

    it('crea la cabecera con sus filas y asientos; la lista trae el resumen por cabina', async () => {
      const creado = await c
        .admin('post', `${ADMIN}/seat-maps`, {
          airline: k.aerolinea,
          aircraftModel: k.modelo,
          name: `Mapa ${sufijo()}`,
          rows: [fila(1, 'BUSINESS', 'AC'), fila(2, 'ECONOMY', 'ABC'), fila(3, 'ECONOMY', 'ABC')],
        })
        .expect(201);
      expect(creado.body.cabins).toEqual([
        { cabinClass: 'BUSINESS', seats: 2 },
        { cabinClass: 'ECONOMY', seats: 6 },
      ]);
      expect(creado.body.rows).toHaveLength(3);
      k.mapa = creado.body.id;

      const lista = await c
        .admin('get', `${ADMIN}/seat-maps`)
        .query({ airline: k.aerolinea })
        .expect(200);
      expect(lista.body.items[0].rows).toBeUndefined();
      expect(lista.body.items[0].cabins).toEqual(creado.body.cabins);
    });

    it('fila o letra repetidas 400; modelo inexistente 422; la distribución no se cambia 400', async () => {
      const base = { airline: k.aerolinea, aircraftModel: k.modelo, name: `Otro ${sufijo()}` };
      await esperarError(
        await c.admin('post', `${ADMIN}/seat-maps`, {
          ...base,
          rows: [fila(1, 'ECONOMY', 'A'), fila(1, 'ECONOMY', 'B')],
        }),
        400,
        /row 1 is repeated/,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/seat-maps`, { ...base, rows: [fila(1, 'ECONOMY', 'AA')] }),
        400,
        /seat 1A is repeated/,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/seat-maps`, {
          ...base,
          aircraftModel: await codigos.modelo(c.prisma),
          rows: [fila(1, 'ECONOMY', 'A')],
        }),
        422,
      );
      await esperarError(await c.admin('patch', `${ADMIN}/seat-maps/${k.mapa}`, { rows: [] }), 400);
    });
  });

  describe('vuelo', () => {
    it('crea entre los dos aeropuertos; el flightNumber es el id', async () => {
      const creado = await c
        .admin('post', `${ADMIN}/flights`, {
          marketingCarrier: k.aerolinea,
          number: '101',
          origin: k.aeropuerto1,
          destination: k.aeropuerto2,
        })
        .expect(201);
      k.vuelo = `${k.aerolinea}101`;
      expect(creado.body).toEqual({
        flightNumber: k.vuelo,
        marketingCarrier: k.aerolinea,
        operatingCarrier: k.aerolinea,
        origin: k.aeropuerto1,
        destination: k.aeropuerto2,
        active: true,
      });
    });

    it('repetido 409, misma ruta de ida y vuelta 400, aeropuerto inexistente 422, ruta no editable 400', async () => {
      const base = {
        marketingCarrier: k.aerolinea,
        number: '101',
        origin: k.aeropuerto1,
        destination: k.aeropuerto2,
      };
      await esperarError(await c.admin('post', `${ADMIN}/flights`, base), 409);
      await esperarError(
        await c.admin('post', `${ADMIN}/flights`, {
          ...base,
          number: '102',
          destination: k.aeropuerto1,
        }),
        400,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/flights`, {
          ...base,
          number: '103',
          destination: await codigos.aeropuerto(c.prisma),
        }),
        422,
      );
      await esperarError(
        await c.admin('patch', `${ADMIN}/flights/${k.vuelo}`, { origin: 'UIO' }),
        400,
      );
      await esperarError(await c.admin('get', `${ADMIN}/flights/${k.aerolinea}0101`), 400);
    });
  });

  describe('salida programada y sus cupos', () => {
    const horario = { scheduledDeparture: enDias(40, 3), scheduledArrival: enDias(40, 4, 30) };

    it('un mapa de otra aerolínea o un cupo mayor que los asientos: 422', async () => {
      const mapaAv = (await c.admin('get', `${ADMIN}/seat-maps`).query({ airline: 'AV' })).body
        .items[0].id;
      await esperarError(
        await c.admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: mapaAv,
          ...horario,
        }),
        422,
        /belongs to airline AV/,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          ...horario,
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 7 }],
        }),
        422,
        /has 6 seats/,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          ...horario,
          cabins: [{ cabinClass: 'FIRST', totalSeats: 1 }],
        }),
        422,
        /no FIRST cabin/,
      );
    });

    it('horarios inválidos: llegada antes 400, en el pasado 422, sin zona 400', async () => {
      const base = { flightNumber: k.vuelo, seatMapId: k.mapa };
      await esperarError(
        await c.admin('post', `${ADMIN}/departures`, {
          ...base,
          scheduledDeparture: horario.scheduledArrival,
          scheduledArrival: horario.scheduledDeparture,
        }),
        400,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/departures`, {
          ...base,
          scheduledDeparture: enDias(-1, 10),
          scheduledArrival: enDias(-1, 11),
        }),
        422,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/departures`, {
          ...base,
          scheduledDeparture: '2030-01-01T10:00:00',
          scheduledArrival: horario.scheduledArrival,
        }),
        400,
      );
    });

    it('crea la salida con un cupo por cabina y la fecha local de origen', async () => {
      const creada = await c
        .admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          ...horario,
        })
        .expect(201);
      k.salida = creada.body.id;
      // 03:00 UTC son las 22:00 del día anterior en America/Guayaquil (UTC-5)
      const anterior = new Date(horario.scheduledDeparture);
      anterior.setUTCDate(anterior.getUTCDate() - 1);
      expect(creada.body).toMatchObject({
        flightNumber: k.vuelo,
        departureDate: anterior.toISOString().slice(0, 10),
        status: 'SCHEDULED',
        active: true,
        cabins: [
          { cabinClass: 'ECONOMY', totalSeats: 6, availableSeats: 6 },
          { cabinClass: 'BUSINESS', totalSeats: 2, availableSeats: 2 },
        ],
      });
      await esperarError(
        await c.admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          ...horario,
        }),
        409,
        'The flight already has a departure on that local date',
      );
    });

    it('un cupo no baja de lo ya retenido o vendido', async () => {
      await c.prisma.db.$executeRaw`
        UPDATE vuelos.inventario_cabina SET cupos_disponibles = cupos_totales - 3
         WHERE vuelo_programado_id = ${k.salida}::uuid AND clase_cabina = 'ECONOMICA'`;

      await esperarError(
        await c.admin('patch', `${ADMIN}/departures/${k.salida}`, {
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 2 }],
        }),
        409,
        /already has 3 seats held or sold/,
      );
      const ajustada = await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, {
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 5 }],
        })
        .expect(200);
      expect(ajustada.body.cabins[0]).toEqual({
        cabinClass: 'ECONOMY',
        totalSeats: 5,
        availableSeats: 2,
      });

      await c.prisma.db.$executeRaw`
        UPDATE vuelos.inventario_cabina SET cupos_disponibles = cupos_totales
         WHERE vuelo_programado_id = ${k.salida}::uuid`;
    });

    it('estado y horarios estimados; CANCELLED no se fija por PATCH', async () => {
      const demorada = await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, {
          status: 'DELAYED',
          estimatedDeparture: enDias(40, 3, 45),
        })
        .expect(200);
      expect(demorada.body).toMatchObject({ status: 'DELAYED' });
      await esperarError(
        await c.admin('patch', `${ADMIN}/departures/${k.salida}`, {
          estimatedDeparture: enDias(40, 5),
          estimatedArrival: enDias(40, 4),
        }),
        422,
        'The estimated arrival must be after the estimated departure',
      );
      await esperarError(
        await c.admin('patch', `${ADMIN}/departures/${k.salida}`, { status: 'CANCELLED' }),
        400,
      );
      await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, { status: 'SCHEDULED' })
        .expect(200);
    });
  });

  describe('tarifa', () => {
    const precios = [
      { passengerType: 'ADULT', baseFare: '89.10', taxes: '12.20' },
      { passengerType: 'INFANT', baseFare: '0.10', taxes: '0.20' },
    ];

    it('una familia de otra aerolínea o sin precio de adulto: 422 y 400', async () => {
      const familiaAv = (await c.admin('get', `${ADMIN}/fare-families`).query({ airline: 'AV' }))
        .body.items[0].id;
      const base = { departureId: k.salida, currency: 'USD', extraBagPrice: '35', prices: precios };
      await esperarError(
        await c.admin('post', `${ADMIN}/fares`, { ...base, fareFamilyId: familiaAv }),
        422,
        /belongs to airline AV/,
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/fares`, {
          ...base,
          fareFamilyId: k.familia,
          prices: [precios[1]],
        }),
        400,
        'prices: must include the ADULT price',
      );
      await esperarError(
        await c.admin('post', `${ADMIN}/fares`, {
          ...base,
          fareFamilyId: k.familia,
          extraBagPrice: 35.5,
        }),
        400,
      );
    });

    it('crea con el dinero en texto y el total sumado en Decimal', async () => {
      const creada = await c
        .admin('post', `${ADMIN}/fares`, {
          departureId: k.salida,
          fareFamilyId: k.familia,
          currency: 'USD',
          extraBagPrice: '35',
          prices: precios,
        })
        .expect(201);
      k.tarifa = creada.body.id;
      expect(creada.body).toMatchObject({
        flightNumber: k.vuelo,
        fareBrand: 'PRUEBA',
        cabinClass: 'ECONOMY',
        extraBagPrice: '35.00',
        changeFee: '0.00',
        prices: [
          { passengerType: 'ADULT', baseFare: '89.10', taxes: '12.20', total: '101.30' },
          { passengerType: 'INFANT', baseFare: '0.10', taxes: '0.20', total: '0.30' },
        ],
      });

      await esperarError(
        await c.admin('post', `${ADMIN}/fares`, {
          departureId: k.salida,
          fareFamilyId: k.familia,
          currency: 'USD',
          extraBagPrice: '1',
          prices: precios,
        }),
        409,
        'The departure already has a fare for this fare family',
      );
    });

    it('PATCH cambia y agrega precios sin quitar ninguno', async () => {
      const cambiada = await c
        .admin('patch', `${ADMIN}/fares/${k.tarifa}`, {
          changeFee: '25',
          prices: [
            { passengerType: 'ADULT', baseFare: '99.99', taxes: '0.01' },
            { passengerType: 'CHILD', baseFare: '70', taxes: '8.4' },
          ],
        })
        .expect(200);
      expect(cambiada.body.changeFee).toBe('25.00');
      expect(cambiada.body.prices.map((p: Cuerpo) => `${p.passengerType}=${p.total}`)).toEqual([
        'ADULT=100.00',
        'CHILD=78.40',
        'INFANT=0.30',
      ]);
    });
  });

  describe('no se da de baja lo que otras filas activas usan', () => {
    it.each([
      ['país con una ciudad activa', () => `countries/${k.pais}`, /1 active city/],
      ['ciudad con aeropuertos activos', () => `cities/${k.ciudad}`, /2 active airports/],
      ['aeropuerto con un vuelo activo', () => `airports/${k.aeropuerto1}`, /1 active flight/],
      [
        'aerolínea con vuelo, familia y mapa',
        () => `airlines/${k.aerolinea}`,
        /1 active flight, 1 active fare family, 1 active seat map/,
      ],
      ['modelo con un mapa activo', () => `aircraft-models/${k.modelo}`, /1 active seat map/],
      [
        'familia con una tarifa en venta',
        () => `fare-families/${k.familia}`,
        /1 active fare on an upcoming departure/,
      ],
      ['mapa con una salida próxima', () => `seat-maps/${k.mapa}`, /1 upcoming departure/],
      ['vuelo con una salida próxima', () => `flights/${k.vuelo}`, /1 upcoming departure/],
    ])('%s: 409', async (_caso, ruta, detalle) => {
      await esperarError(await c.admin('delete', `${ADMIN}/${ruta()}`), 409, detalle);
    });

    it('la semilla también: UIO tiene vuelos activos', async () => {
      await esperarError(await c.admin('delete', `${ADMIN}/airports/UIO`), 409, /active flights/);
    });

    it('una salida con una retención vigente no se cancela', async () => {
      k.retencion = await crearRetencion(c, k.salida);
      await esperarError(
        await c.admin('delete', `${ADMIN}/departures/${k.salida}`),
        409,
        /cannot be cancelled: it is used by 1 active hold/,
      );
      await c.prisma.transaccionAuditada((tx) =>
        tx.retencion_cabecera.update({
          where: { id: k.retencion },
          data: { estado: 'EXPIRADA', fecha_cierre: new Date() },
        }),
      );
    });
  });

  describe('baja lógica y reactivación (en orden inverso, ya sin dependientes)', () => {
    /**
     * DELETE responde 204 y deja la fila inactiva (sigue existiendo); la lista la oculta salvo
     * con includeInactive; repetir la baja no falla; reactivate la devuelve y al final queda
     * dada de baja. La auditoría registra la baja con el sub del administrador.
     */
    async function cicloDeBaja(opciones: {
      ruta: string;
      clave: string;
      tabla: string;
      lista: Record<string, string>;
      claveDe: (item: Cuerpo) => string;
      cambioAuditado: string;
    }): Promise<void> {
      const { ruta, clave } = opciones;
      await c.admin('delete', `${ADMIN}/${ruta}/${clave}`).expect(204);
      expect((await c.admin('get', `${ADMIN}/${ruta}/${clave}`).expect(200)).body.active).toBe(
        false,
      );

      expect(
        await clavesDeLista(`${ADMIN}/${ruta}`, opciones.lista, opciones.claveDe),
      ).not.toContain(clave);
      expect(
        await clavesDeLista(
          `${ADMIN}/${ruta}`,
          { ...opciones.lista, includeInactive: 'true' },
          opciones.claveDe,
        ),
      ).toContain(clave);

      const [{ cantidad }] = await c.prisma.db.$queryRaw<Array<{ cantidad: number }>>`
        SELECT count(*)::int AS cantidad FROM vuelos.auditoria
         WHERE nombre_tabla = ${opciones.tabla} AND operacion = 'ACTUALIZACION'
           AND id_usuario = ${c.idAdmin} AND id > ${auditoriaInicial}
           AND datos_nuevos::text = ${opciones.cambioAuditado}`;
      expect(cantidad).toBeGreaterThanOrEqual(1);

      await c.admin('delete', `${ADMIN}/${ruta}/${clave}`).expect(204);
      expect(
        (await c.admin('post', `${ADMIN}/${ruta}/${clave}/reactivate`).expect(200)).body.active,
      ).toBe(true);
      await c.admin('delete', `${ADMIN}/${ruta}/${clave}`).expect(204);
    }

    const BAJA = '{"activo": false}';

    it('tarifa', async () => {
      await cicloDeBaja({
        ruta: 'fares',
        clave: k.tarifa,
        tabla: 'tarifa_cabecera',
        lista: { departureId: k.salida },
        claveDe: (i) => i.id as string,
        cambioAuditado: BAJA,
      });
    });

    it('salida: DELETE la cancela y reactivate la vuelve a SCHEDULED', async () => {
      await cicloDeBaja({
        ruta: 'departures',
        clave: k.salida,
        tabla: 'vuelo_programado',
        lista: { flightNumber: k.vuelo },
        claveDe: (i) => i.id as string,
        cambioAuditado: '{"estado": "CANCELADO"}',
      });
      const cancelada = await c.admin('get', `${ADMIN}/departures/${k.salida}`).expect(200);
      expect(cancelada.body.status).toBe('CANCELLED');
      // Una tarifa de una salida cancelada no se reactiva ni se modifica
      await esperarError(
        await c.admin('post', `${ADMIN}/fares/${k.tarifa}/reactivate`),
        409,
        /no longer on sale/,
      );
    });

    it('vuelo', async () => {
      await cicloDeBaja({
        ruta: 'flights',
        clave: k.vuelo,
        tabla: 'vuelo',
        lista: { airline: k.aerolinea },
        claveDe: (i) => i.flightNumber as string,
        cambioAuditado: BAJA,
      });
    });

    it('mapa de asientos', async () => {
      await cicloDeBaja({
        ruta: 'seat-maps',
        clave: k.mapa,
        tabla: 'mapa_asientos_cabecera',
        lista: { airline: k.aerolinea },
        claveDe: (i) => i.id as string,
        cambioAuditado: BAJA,
      });
      // Los asientos físicos siguen en la base: la baja no toca el detalle
      const asientos = await c.prisma.db.asiento.count({
        where: { mapa_asientos_detalle: { mapa_asientos_cabecera: { id_publico: k.mapa } } },
      });
      expect(asientos).toBe(8);
    });

    it('familia tarifaria', async () => {
      await cicloDeBaja({
        ruta: 'fare-families',
        clave: k.familia,
        tabla: 'familia_tarifa',
        lista: { airline: k.aerolinea },
        claveDe: (i) => i.id as string,
        cambioAuditado: BAJA,
      });
    });

    it('modelo de aeronave', async () => {
      await cicloDeBaja({
        ruta: 'aircraft-models',
        clave: k.modelo,
        tabla: 'modelo_aeronave',
        lista: {},
        claveDe: (i) => i.code as string,
        cambioAuditado: BAJA,
      });
    });

    it('aerolínea; con ella inactiva, su familia no se reactiva (422)', async () => {
      await cicloDeBaja({
        ruta: 'airlines',
        clave: k.aerolinea,
        tabla: 'aerolinea',
        lista: {},
        claveDe: (i) => i.code as string,
        cambioAuditado: BAJA,
      });
      const reactivar = await c.admin('post', `${ADMIN}/fare-families/${k.familia}/reactivate`);
      await esperarError(reactivar, 422, /is inactive; reactivate it first/);
      expect(reactivar.body.invalidParams).toEqual([
        { name: 'airline', reason: expect.any(String) },
      ]);
    });

    it('aeropuertos', async () => {
      for (const codigo of [k.aeropuerto1, k.aeropuerto2]) {
        await cicloDeBaja({
          ruta: 'airports',
          clave: codigo,
          tabla: 'aeropuerto',
          lista: { cityId: k.ciudad },
          claveDe: (i) => i.code as string,
          cambioAuditado: BAJA,
        });
      }
    });

    it('ciudad', async () => {
      await cicloDeBaja({
        ruta: 'cities',
        clave: k.ciudad,
        tabla: 'ciudad',
        lista: { country: k.pais },
        claveDe: (i) => i.id as string,
        cambioAuditado: BAJA,
      });
    });

    it('país; con él inactivo, su ciudad no se reactiva (422)', async () => {
      await cicloDeBaja({
        ruta: 'countries',
        clave: k.pais,
        tabla: 'pais',
        lista: {},
        claveDe: (i) => i.code as string,
        cambioAuditado: BAJA,
      });
      await esperarError(
        await c.admin('post', `${ADMIN}/cities/${k.ciudad}/reactivate`),
        422,
        /Country .* is inactive/,
      );
    });

    it('todo lo creado sigue en la base, dado de baja', async () => {
      const [pais, ciudad, aeropuertos, aerolinea, vuelo, salida, tarifa] = await Promise.all([
        c.prisma.db.pais.findUniqueOrThrow({ where: { codigo_iso2: k.pais } }),
        c.prisma.db.ciudad.findUniqueOrThrow({ where: { id_publico: k.ciudad } }),
        c.prisma.db.aeropuerto.findMany({
          where: { codigo_iata: { in: [k.aeropuerto1, k.aeropuerto2] } },
        }),
        c.prisma.db.aerolinea.findUniqueOrThrow({ where: { codigo_iata: k.aerolinea } }),
        c.prisma.db.vuelo.findFirstOrThrow({
          where: {
            numero: '101',
            aerolinea_vuelo_aerolinea_idToaerolinea: { codigo_iata: k.aerolinea },
          },
        }),
        c.prisma.db.vuelo_programado.findUniqueOrThrow({ where: { id: k.salida } }),
        c.prisma.db.tarifa_cabecera.findUniqueOrThrow({ where: { id_publico: k.tarifa } }),
      ]);
      expect([pais.activo, ciudad.activo, aerolinea.activo, vuelo.activo, tarifa.activo]).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(aeropuertos.map((a) => a.activo)).toEqual([false, false]);
      expect(salida.estado).toBe('CANCELADO');
    });
  });
});

/** Una retención vigente sobre la salida, como la creará la fase 6. Queda en la base. */
async function crearRetencion(c: AppCatalogo, salidaId: string): Promise<string> {
  const [{ id }] = await c.prisma.db.$queryRaw<Array<{ id: string }>>`
    WITH o AS (
      INSERT INTO vuelos.oferta_cabecera (aerolinea_id, huella_dispositivo, fecha_expiracion)
      SELECT v.aerolinea_id, 'fp-e2e-catalogo', now() + interval '1 hour'
        FROM vuelos.vuelo_programado vp JOIN vuelos.vuelo v ON v.id = vp.vuelo_id
       WHERE vp.id = ${salidaId}::uuid
      RETURNING id),
    i AS (INSERT INTO vuelos.itinerario_cabecera DEFAULT VALUES RETURNING id),
    d AS (INSERT INTO vuelos.itinerario_detalle (itinerario_id, orden, vuelo_programado_id)
          SELECT i.id, 1, ${salidaId}::uuid FROM i),
    r AS (INSERT INTO vuelos.retencion_cabecera (oferta_id, id_propietario, moneda_id, fecha_expiracion)
          SELECT o.id, 'e2e-catalogo', (SELECT id FROM vuelos.moneda WHERE codigo_iso = 'USD'),
                 now() + interval '15 minutes' FROM o
          RETURNING id),
    rd AS (INSERT INTO vuelos.retencion_detalle
             (retencion_id, itinerario_id, familia_tarifa_id, tarifa_base_congelada, impuestos_congelados)
           SELECT r.id, i.id, (SELECT id FROM vuelos.familia_tarifa LIMIT 1), 10, 1 FROM r, i)
    SELECT id FROM r`;
  return id;
}
