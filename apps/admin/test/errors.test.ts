import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/errors';

describe('errorMessage', () => {
  it('maps PLAN_LIMIT_EXCEEDED to the upgrade prompt in es-CO', () => {
    const error = new ApiError(402, 'PLAN_LIMIT_EXCEEDED');
    expect(errorMessage(error)).toBe(
      'Alcanzaste el límite de tu plan. Mejora tu plan para continuar.',
    );
  });

  it('maps VALIDATION_FAILED to a generic field-review message', () => {
    const error = new ApiError(400, 'VALIDATION_FAILED');
    expect(errorMessage(error)).toBe('Revisa los campos marcados.');
  });

  it('maps FORBIDDEN_ROLE, TENANT_SUSPENDED, SLUG_TAKEN and INVITE_INVALID', () => {
    expect(errorMessage(new ApiError(403, 'FORBIDDEN_ROLE'))).toBe(
      'No tienes permisos para esta acción.',
    );
    expect(errorMessage(new ApiError(403, 'TENANT_SUSPENDED'))).toBe(
      'Tu tienda está suspendida. Contacta soporte.',
    );
    expect(errorMessage(new ApiError(409, 'SLUG_TAKEN'))).toMatch(/URL/);
    expect(errorMessage(new ApiError(410, 'INVITE_INVALID'))).toMatch(/invitación/);
  });

  it('falls back to the generic message for an unknown code', () => {
    const error = new ApiError(500, 'SOMETHING_NEW_FROM_THE_API');
    expect(errorMessage(error)).toBe('Ocurrió un error inesperado. Intenta de nuevo.');
  });

  it('falls back to the network message for NETWORK', () => {
    const error = new ApiError(0, 'NETWORK');
    expect(errorMessage(error)).toBe(
      'No pudimos conectar con el servidor. Verifica tu conexión.',
    );
  });
});

describe('fieldErrors', () => {
  it('extracts a field -> message map from a zod .flatten() shaped details object', () => {
    const error = new ApiError(400, 'VALIDATION_FAILED', {
      formErrors: [],
      fieldErrors: {
        name: ['Requerido'],
        price: ['Debe ser mayor a 0', 'Debe ser un número'],
      },
    });

    expect(fieldErrors(error)).toEqual({
      name: 'Requerido',
      price: 'Debe ser mayor a 0',
    });
  });

  it('returns an empty object when details has no fieldErrors', () => {
    expect(fieldErrors(new ApiError(500, 'UNKNOWN'))).toEqual({});
    expect(fieldErrors(new ApiError(500, 'UNKNOWN', { formErrors: ['nope'] }))).toEqual({});
    expect(fieldErrors(new ApiError(500, 'UNKNOWN', null))).toEqual({});
  });
});
