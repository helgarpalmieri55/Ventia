import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

import { revalidateTag } from 'next/cache';
import { POST } from '../app/api/revalidate/route';

describe('POST /api/revalidate', () => {
  it('revalidates the tag when the secret matches', async () => {
    process.env.REVALIDATE_SECRET = 'test-secret';
    const req = new Request('http://localhost/api/revalidate', {
      method: 'POST',
      body: JSON.stringify({ tag: 'products:t1', secret: 'test-secret' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith('products:t1');
  });

  it('401s on a wrong secret', async () => {
    process.env.REVALIDATE_SECRET = 'test-secret';
    const req = new Request('http://localhost/api/revalidate', {
      method: 'POST',
      body: JSON.stringify({ tag: 'products:t1', secret: 'wrong' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('400s on a missing tag', async () => {
    process.env.REVALIDATE_SECRET = 'test-secret';
    const req = new Request('http://localhost/api/revalidate', {
      method: 'POST',
      body: JSON.stringify({ secret: 'test-secret' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
