import { describe, expect, it } from 'vitest';
import {
  INSTAGRAM_ACCOUNT_STATUSES,
  instagramAccountUpdateSchema,
  instagramConnectSchema,
  normalizeInstagramUsername,
} from '../src/instagram-schemas';

/** El formulario de conexión de Instagram: cada campo termina en una ruta de
 * URL, en una cabecera HTTP o en la columna `@unique` por la que se enruta. */

const valido = {
  provider: 'graph' as const,
  igAccountId: '17841405793187218',
  pageId: '102290129340398',
  accessToken: 'EAAG-token-de-pagina-largo',
  appSecret: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  verifyToken: 'mi-token-secreto',
  username: '@MiTienda',
};

describe('normalizeInstagramUsername', () => {
  it('quita la arroba y baja a minúsculas', () => {
    expect(normalizeInstagramUsername('@MiTienda')).toBe('mitienda');
  });

  it('acepta el nombre pelado', () => {
    expect(normalizeInstagramUsername('mi.tienda_co')).toBe('mi.tienda_co');
  });

  it('saca el usuario de una URL de perfil pegada', () => {
    expect(normalizeInstagramUsername('https://www.instagram.com/mitienda/?hl=es')).toBe('mitienda');
  });

  it('rechaza un nombre con caracteres que Instagram no permite', () => {
    expect(normalizeInstagramUsername('mi tienda')).toBeNull();
    expect(normalizeInstagramUsername('mi-tienda')).toBeNull();
    expect(normalizeInstagramUsername('tienda/agente')).toBeNull();
  });

  it('rechaza uno de más de 30 caracteres', () => {
    expect(normalizeInstagramUsername('a'.repeat(31))).toBeNull();
    expect(normalizeInstagramUsername('a'.repeat(30))).toBe('a'.repeat(30));
  });

  it('rechaza la cadena vacía', () => {
    expect(normalizeInstagramUsername('   ')).toBeNull();
    expect(normalizeInstagramUsername('@')).toBeNull();
  });
});

describe('instagramConnectSchema', () => {
  it('acepta una conexión completa y normaliza el @usuario', () => {
    const parsed = instagramConnectSchema.parse(valido);
    expect(parsed).toMatchObject({ provider: 'graph', username: 'mitienda', pageId: '102290129340398' });
  });

  it('exige el id de la página en la rama graph', () => {
    // Una conexión `graph` sin página no es una conexión a medias: el token
    // sale de la página y el webhook se suscribe sobre ella.
    const sinPagina: Record<string, unknown> = { ...valido };
    delete sinPagina.pageId;
    expect(instagramConnectSchema.safeParse(sinPagina).success).toBe(false);
  });

  it('rechaza un id de cuenta que no sea solo dígitos', () => {
    // Se interpola tal cual en la ruta de la Graph API: una barra o un `..`
    // reapuntarían el envío a otro endpoint.
    for (const igAccountId of ['178414/messages', '../me', '17841405793187218 ok', 'abcdefgh']) {
      expect(instagramConnectSchema.safeParse({ ...valido, igAccountId }).success).toBe(false);
    }
  });

  it('rechaza secretos con saltos de línea', () => {
    // CR/LF en el valor de una cabecera es inyección de cabeceras.
    expect(
      instagramConnectSchema.safeParse({ ...valido, accessToken: 'token\r\nX-Cosa: mala' }).success,
    ).toBe(false);
    expect(instagramConnectSchema.safeParse({ ...valido, appSecret: 'secreto\nmalo' }).success).toBe(false);
  });

  it('rechaza un token de verificación demasiado corto', () => {
    // Quien lo adivine completa el saludo de Meta contra este endpoint.
    expect(instagramConnectSchema.safeParse({ ...valido, verifyToken: 'abc' }).success).toBe(false);
  });

  it('rechaza un proveedor que no existe', () => {
    expect(instagramConnectSchema.safeParse({ ...valido, provider: 'instagram_login' }).success).toBe(false);
  });
});

describe('instagramAccountUpdateSchema', () => {
  it('acepta los dos estados que puede mover el dueño', () => {
    expect(INSTAGRAM_ACCOUNT_STATUSES).toEqual(['connected', 'disabled']);
    for (const status of INSTAGRAM_ACCOUNT_STATUSES) {
      expect(instagramAccountUpdateSchema.parse({ status })).toEqual({ status });
    }
  });

  it('no deja aparcar una cuenta en `pending` desde el admin', () => {
    // Es el estado en el que se crea una fila y del que se sale verificando.
    expect(instagramAccountUpdateSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });
});
