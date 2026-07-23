import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'secret',
      PLATFORM_ROOT_DOMAIN: 'ventia.localhost',
    });
    expect(env.PLATFORM_ROOT_DOMAIN).toBe('ventia.localhost');
    expect(env.API_PORT).toBe(4000); // default
  });

  it('throws on missing DATABASE_URL', () => {
    expect(() => loadEnv({ AUTH_SECRET: 'x' })).toThrow(/DATABASE_URL/);
  });
});
