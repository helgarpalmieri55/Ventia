import { AccountVerify } from '../../../components/account-verify';
import { tokenFromSearchParams } from '../../../lib/account-form';

export const metadata = { title: 'Confirmar correo' };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <AccountVerify token={tokenFromSearchParams(token)} />;
}
