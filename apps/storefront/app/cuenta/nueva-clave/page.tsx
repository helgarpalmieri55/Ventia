import { AccountNewPassword } from '../../../components/account-new-password';
import { tokenFromSearchParams } from '../../../lib/account-form';

export const metadata = { title: 'Nueva contraseña' };

export default async function NewPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <AccountNewPassword token={tokenFromSearchParams(token)} />;
}
