import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const StorefrontTenantId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().storefrontTenantId as string;
});
