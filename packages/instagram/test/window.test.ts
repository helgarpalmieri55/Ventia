import { describe, expect, it } from 'vitest';
import { MESSAGING_WINDOW_MS, isWithinMessagingWindow, normalizeTimestampMs } from '../src/window';

/** La ventana de 24 horas de Instagram: ver el comentario de `window.ts` para
 * por qué no la esquivamos con etiquetas de mensaje. */

const NOW = 1_756_000_000_000;

describe('isWithinMessagingWindow', () => {
  it('está abierta para un mensaje recién llegado', () => {
    expect(isWithinMessagingWindow(NOW - 2_000, NOW)).toBe(true);
  });

  it('sigue abierta un segundo antes de las 24 horas', () => {
    expect(isWithinMessagingWindow(NOW - MESSAGING_WINDOW_MS + 1_000, NOW)).toBe(true);
  });

  it('está cerrada justo al cumplirse las 24 horas', () => {
    expect(isWithinMessagingWindow(NOW - MESSAGING_WINDOW_MS, NOW)).toBe(false);
  });

  it('está cerrada para una entrega represada de dos días', () => {
    expect(isWithinMessagingWindow(NOW - 2 * MESSAGING_WINDOW_MS, NOW)).toBe(false);
  });

  it('trata una marca de tiempo en el futuro como abierta', () => {
    // El desfase de reloj con Meta es de segundos; tratarlo como "fuera"
    // dejaría muda a la tienda por un reloj adelantado.
    expect(isWithinMessagingWindow(NOW + 30_000, NOW)).toBe(true);
  });

  it('está cerrada para un valor no usable', () => {
    expect(isWithinMessagingWindow(NaN, NOW)).toBe(false);
  });

  it('son 24 horas exactas', () => {
    expect(MESSAGING_WINDOW_MS).toBe(86_400_000);
  });
});

describe('normalizeTimestampMs', () => {
  it('deja los milisegundos como están', () => {
    expect(normalizeTimestampMs(1_756_000_000_000)).toBe(1_756_000_000_000);
  });

  it('sube los segundos a milisegundos', () => {
    expect(normalizeTimestampMs(1_756_000_000)).toBe(1_756_000_000_000);
  });

  it('acepta el valor como cadena', () => {
    expect(normalizeTimestampMs('1756000000000')).toBe(1_756_000_000_000);
  });

  it('devuelve NaN para lo que no es una marca de tiempo', () => {
    expect(normalizeTimestampMs(undefined)).toBeNaN();
    expect(normalizeTimestampMs('mañana')).toBeNaN();
    expect(normalizeTimestampMs(0)).toBeNaN();
    expect(normalizeTimestampMs(-1)).toBeNaN();
  });
});
