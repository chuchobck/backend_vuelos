# Sanitización de texto de los DTO

Todo texto libre que entra por el cuerpo de una petición (nombres, documentos, motivos, URL de
webhooks) pasa por `@TextoLimpio()`. Los DTO reales lo adoptan en la fase de cada entidad.

## Qué hace

| Paso                | Qué pasa                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recortar            | Quita los espacios de los bordes (también un salto de línea al principio o al final). No cambia lo que el texto dice.                                                                                                           |
| Normalizar a NFC    | `e` + acento combinado pasa a `é`. Así dos textos iguales a la vista se guardan y se comparan igual.                                                                                                                            |
| Exigir texto        | Un número, un objeto o un arreglo se rechaza (`must be a string`).                                                                                                                                                              |
| Rechazar controles  | Caracteres de control (NUL, saltos de línea y tabulaciones dentro del texto, DEL, C1) y caracteres invisibles de formato (ancho cero, marcas bidireccionales como U+202E, separadores de línea y de párrafo, BOM). Responde 400. |
| Rechazar HTML       | Un `<` seguido de letra, `/`, `!` o `?` (`<b>`, `</p>`, `<!--`, `<?`). `a < b` y `Juan <3` pasan. Responde 400.                                                                                                                 |

Lo único que se limpia en silencio es lo que no cambia el significado. Quitar una etiqueta o un
carácter de control cambiaría lo que el cliente quiso decir, así que se rechaza con
`400 VALIDATION_FAILED` y el campo en `invalidParams`. El mensaje no repite el texto enviado.

## Cómo se usa

```ts
import { IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { TextoLimpio } from '../../common/sanitizacion/texto-limpio.decorator';

export class PasajeroDto {
  // Una línea: rechaza saltos de línea y tabulaciones dentro del texto
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  // Varias líneas: permite \n, \r y \t, pero sigue rechazando los demás controles y el HTML
  @TextoLimpio({ multilinea: true })
  @IsOptional()
  @MaxLength(500)
  remarks?: string;

  // Arreglo de textos: la misma regla para cada elemento
  @TextoLimpio({ each: true })
  @IsOptional()
  aliases?: string[];
}
```

- `@TextoLimpio()` va primero y las demás reglas (`@IsNotEmpty`, `@MaxLength`, `@Matches`)
  después: ya ven el texto recortado y normalizado, así `"   "` cuenta como vacío.
- Funciona porque el `ValidationPipe` global usa `transform: true`: primero transforma el DTO y
  luego valida.
- Las piezas se pueden usar sueltas: `@RecortarYNormalizar()`, `@SinCaracteresDeControl()` y
  `@SinEtiquetasHtml()`.
- Un campo que no es texto libre (un `uuid`, una fecha, un código IATA, un enum) no lleva
  `@TextoLimpio`: ya lo restringe su propio formato.

La prueba `test/sanitizacion.e2e-spec.ts` tiene un DTO de prueba y los casos aceptados y
rechazados.
