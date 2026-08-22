import { AccountSignIn } from '../../../components/account-sign-in';
import { tokenFromSearchParams } from '../../../lib/account-form';

export const metadata = { title: 'Entrar' };

/**
 * A Server Component whose only job is to read `?token=` and hand it down.
 *
 * The token could be read client-side with `useSearchParams`, but that forces
 * a `<Suspense>` boundary around the whole screen and gives the shopper a
 * render with no token before the one with it — on a page that redeems the
 * token on mount, that is an extra render of "Entrar" flashing in front of
 * someone who clicked a sign-in link. Reading it here hands the client
 * component the final value on its first render instead.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <AccountSignIn token={tokenFromSearchParams(token)} />;
}
