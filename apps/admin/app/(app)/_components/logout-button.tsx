'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@ventia/ui';
import { signOut } from '../../../lib/auth';

/** `_components`: a Next.js "private folder" (underscore-prefixed), so this
 * directory is never treated as a route segment. */
export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await signOut();
    } catch {
      // Best-effort: even if the sign-out call itself fails (network, API
      // down), still send the user to /login — a stale session cookie there
      // just fails the next /v1/admin/me check and redirects right back.
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleClick} disabled={pending}>
      {pending ? 'Saliendo…' : 'Cerrar sesión'}
    </Button>
  );
}
