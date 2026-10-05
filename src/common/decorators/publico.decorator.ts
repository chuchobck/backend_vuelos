import { SetMetadata } from '@nestjs/common';

export const ES_PUBLICO = 'esPublico';

/** Marca una ruta que no exige JWT. El guard global que lo lee entra en la fase 3. */
export const Publico = () => SetMetadata(ES_PUBLICO, true);
