import { redirect } from 'next/navigation';
import { CONSOLE_PATH } from '../../../lib/impersonation';
import { getMe } from '../../../lib/session';

/** Sibling to `(app)`'s layout — see that file's doc comment for why
 * `/onboarding` lives in its own route group rather than nested under
 * `(app)`. This layout requires a session but, unlike `(app)`'s, tolerates
 * (indeed expects) `no-tenant`: that's exactly the state a user is in right
 * after sign-up, before the wizard's first step provisions a tenant. A
 * `member` session (tenant already provisioned) is still allowed through —
 * the wizard itself (Task 3) decides what to show/redirect to next for a
 * user who already has a store. */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const session = await getMe();
  if (session.kind === 'anonymous') redirect('/login');
  // Never invite a Ventia operator with a lapsed grant to found a store.
  if (session.kind === 'impersonation-ended') redirect(CONSOLE_PATH);

  return <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-6">{children}</main>;
}
