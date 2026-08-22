import { describe, expect, it } from 'vitest';
import {
  BLANK_INSTAGRAM_FORM,
  buildInstagramConnectPayload,
  instagramCallbackUrl,
  instagramStatusLabel,
  type InstagramFormFields,
} from '../lib/instagram-api';

const lleno: InstagramFormFields = {
  provider: 'graph',
  username: '@MiTienda',
  igAccountId: '17841405793187218',
  pageId: '102290129340398',
  accessToken: 'EAAG-token-de-pagina',
  appSecret: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  verifyToken: 'mi-token-secreto',
};

describe('buildInstagramConnectPayload', () => {
  it('manda todos los campos de la rama graph', () => {
    expect(buildInstagramConnectPayload(lleno)).toEqual({
      provider: 'graph',
      igAccountId: '17841405793187218',
      pageId: '102290129340398',
      accessToken: 'EAAG-token-de-pagina',
      appSecret: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      verifyToken: 'mi-token-secreto',
      username: '@MiTienda',
    });
  });

  it('manda el @usuario tal y como se escribió', () => {
    // Quien normaliza es el servidor (`instagramUsernameSchema`). Adelantarse
    // aquí sería una segunda verdad sobre el mismo campo.
    expect(buildInstagramConnectPayload(lleno).username).toBe('@MiTienda');
  });

  it('el formulario en blanco no lleva ningún secreto', () => {
    const payload = buildInstagramConnectPayload(BLANK_INSTAGRAM_FORM);
    expect(payload.accessToken).toBe('');
    expect(payload.appSecret).toBe('');
    expect(payload.verifyToken).toBe('');
  });
});

describe('instagramCallbackUrl', () => {
  it('lleva el parámetro `account`, sin el cual la verificación falla siempre', () => {
    // Meta no dice qué cuenta está verificando en el saludo GET, así que el
    // controlador la busca por este parámetro y responde 403 cuando falta.
    expect(instagramCallbackUrl('https://api.ventia.co/webhooks/instagram', 'graph', '17841405793187218')).toBe(
      'https://api.ventia.co/webhooks/instagram/graph?account=17841405793187218',
    );
  });

  it('quita las barras sobrantes de la base', () => {
    expect(instagramCallbackUrl('https://api.ventia.co/webhooks/instagram///', 'graph', '123')).toBe(
      'https://api.ventia.co/webhooks/instagram/graph?account=123',
    );
  });

  it('escapa el id de la cuenta', () => {
    expect(instagramCallbackUrl('https://api.ventia.co/webhooks/instagram', 'graph', 'a b&c')).toBe(
      'https://api.ventia.co/webhooks/instagram/graph?account=a%20b%26c',
    );
  });

  it('devuelve null sin id de cuenta o sin base', () => {
    // Media URL de callback es peor que ninguna: parece copiable.
    expect(instagramCallbackUrl('https://api.ventia.co/webhooks/instagram', 'graph', '   ')).toBeNull();
    expect(instagramCallbackUrl('   ', 'graph', '17841405793187218')).toBeNull();
  });
});

describe('instagramStatusLabel', () => {
  it('traduce los estados conocidos', () => {
    expect(instagramStatusLabel('connected')).toBe('Conectada');
    expect(instagramStatusLabel('disabled')).toBe('Desactivada');
    expect(instagramStatusLabel('pending')).toBe('Pendiente de verificar');
  });

  it('devuelve el valor crudo si no lo reconoce', () => {
    // Un estado desconocido es exactamente lo que un comerciante citaría en un
    // ticket de soporte; cambiarlo por una palabra genérica se lo quitaría.
    expect(instagramStatusLabel('revoked')).toBe('revoked');
  });
});
