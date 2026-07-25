import Link from 'next/link';

/** Next's App Router special file — rendered whenever `notFound()` is called
 * anywhere in the tree (or an unmatched route is requested). No tenant
 * resolution here: this file can't reliably know which tenant a given 404
 * belongs to (an unresolved-tenant 404 is exactly one of the cases that lands
 * here), so the copy stays generic rather than trying to personalize it. */
export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-3xl font-semibold">Página no encontrada</h1>
      <p className="text-muted-foreground">La página que buscas no existe o fue movida.</p>
      <Link href="/" className="underline underline-offset-4">
        Volver al inicio
      </Link>
    </main>
  );
}
