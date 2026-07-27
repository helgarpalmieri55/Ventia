import { revalidateTag } from 'next/cache';

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { tag?: string; secret?: string };
  const expected = process.env.REVALIDATE_SECRET ?? 'dev-revalidate-secret';
  if (body.secret !== expected) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  if (!body.tag) {
    return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });
  }
  revalidateTag(body.tag);
  return Response.json({ revalidated: true });
}
