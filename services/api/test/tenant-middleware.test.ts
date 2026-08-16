import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { TenantMiddleware } from '../src/tenants/tenant.middleware';
import { TenantController } from '../src/tenants/tenant.controller';
import { HealthController } from '../src/health/health.controller';
import { DomainResolver, type ResolvedTenant } from '../src/tenants/domain-resolver';

// Unit-level coverage: exercise TenantMiddleware.use() directly against a
// stub resolver, with no Nest DI / network / containers involved at all.
describe('TenantMiddleware', () => {
  it('catches a rejecting resolver, forwards the error to next(), and does not throw', async () => {
    const err = new Error('boom');
    const stubResolver = { resolve: () => Promise.reject(err) } as unknown as DomainResolver;
    const middleware = new TenantMiddleware(stubResolver);
    const req = { headers: { host: 'demo.ventia.localhost' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await expect(middleware.use(req, res, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('still resolves req.tenant and calls next() with no args on the success path', async () => {
    const tenant: ResolvedTenant = { tenantId: 't1', slug: 'demo', name: 'Demo', status: 'live', domain: 'demo.ventia.localhost' };
    const stubResolver = { resolve: () => Promise.resolve(tenant) } as unknown as DomainResolver;
    const middleware = new TenantMiddleware(stubResolver);
    const req = { headers: { host: 'demo.ventia.localhost' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await middleware.use(req, res, next);

    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('prefers x-tenant-domain over a different Host header', async () => {
    const tenant: ResolvedTenant = { tenantId: 't1', slug: 'demo', name: 'Demo', status: 'live', domain: 'demo.ventia.localhost' };
    const resolve = vi.fn().mockResolvedValue(tenant);
    const stubResolver = { resolve } as unknown as DomainResolver;
    const middleware = new TenantMiddleware(stubResolver);
    const req = {
      headers: { host: 'localhost:4000', 'x-tenant-domain': 'demo.ventia.localhost' },
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await middleware.use(req, res, next);

    expect(resolve).toHaveBeenCalledWith('demo.ventia.localhost');
    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalledWith();
  });

  it('falls back to Host when x-tenant-domain is absent', async () => {
    const tenant: ResolvedTenant = { tenantId: 't1', slug: 'demo', name: 'Demo', status: 'live', domain: 'demo.ventia.localhost' };
    const resolve = vi.fn().mockResolvedValue(tenant);
    const stubResolver = { resolve } as unknown as DomainResolver;
    const middleware = new TenantMiddleware(stubResolver);
    const req = { headers: { host: 'demo.ventia.localhost' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await middleware.use(req, res, next);

    expect(resolve).toHaveBeenCalledWith('demo.ventia.localhost');
    expect(req.tenant).toEqual(tenant);
  });

  it('falls back to Host when x-tenant-domain is an empty string', async () => {
    const tenant: ResolvedTenant = { tenantId: 't1', slug: 'demo', name: 'Demo', status: 'live', domain: 'demo.ventia.localhost' };
    const resolve = vi.fn().mockResolvedValue(tenant);
    const stubResolver = { resolve } as unknown as DomainResolver;
    const middleware = new TenantMiddleware(stubResolver);
    const req = {
      headers: { host: 'demo.ventia.localhost', 'x-tenant-domain': '' },
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await middleware.use(req, res, next);

    expect(resolve).toHaveBeenCalledWith('demo.ventia.localhost');
    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalledWith();
  });

  it('uses the first value when x-tenant-domain arrives as an array', async () => {
    const tenant: ResolvedTenant = { tenantId: 't1', slug: 'demo', name: 'Demo', status: 'live', domain: 'demo.ventia.localhost' };
    const resolve = vi.fn().mockResolvedValue(tenant);
    const stubResolver = { resolve } as unknown as DomainResolver;
    const middleware = new TenantMiddleware(stubResolver);
    const req = {
      headers: { host: 'localhost:4000', 'x-tenant-domain': ['demo.ventia.localhost', 'other.ventia.localhost'] },
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as unknown as NextFunction;

    await middleware.use(req, res, next);

    expect(resolve).toHaveBeenCalledWith('demo.ventia.localhost');
  });
});

// Integration-level coverage: a real Nest/Express pipeline, with the resolver
// wired to reject, proves the failure only affects the one request (500) and
// the process/app keeps serving subsequent requests (200) rather than crashing.
describe('tenant middleware failure does not crash the app', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('/v1/tenant 500s when the resolver rejects; /v1/health still 200s afterwards', async () => {
    @Module({
      controllers: [HealthController, TenantController],
      providers: [
        { provide: DomainResolver, useValue: { resolve: () => Promise.reject(new Error('boom')) } },
        TenantMiddleware,
      ],
    })
    class FailingResolverModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(TenantMiddleware).exclude('v1/health').forRoutes('*');
      }
    }

    app = await NestFactory.create(FailingResolverModule, { logger: false });
    await app.init();

    const tenantRes = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('Host', 'demo.ventia.localhost');
    expect(tenantRes.status).toBe(500);

    // The process (and this in-process app) must still be alive and serving.
    const healthRes = await request(app.getHttpServer()).get('/v1/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body).toEqual({ status: 'ok' });
  });
});
