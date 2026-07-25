import { formatCOP } from '../lib/format';

export function Price({ cents, compareAtCents }: { cents: number; compareAtCents?: number | null }) {
  return (
    <span>
      <span className="font-semibold">{formatCOP(cents)}</span>
      {compareAtCents && compareAtCents > cents ? (
        <span className="ml-2 text-sm line-through opacity-60">{formatCOP(compareAtCents)}</span>
      ) : null}
    </span>
  );
}
