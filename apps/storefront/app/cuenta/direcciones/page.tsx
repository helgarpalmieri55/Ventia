import { AccountAddresses } from '../../../components/account-addresses';

export const metadata = { title: 'Mis direcciones' };

/** Thin Server Component wrapper, same shape as `/cuenta`'s: everything here
 * needs the session, which only exists client-side (`ventia_shopper` is
 * HttpOnly and read by the API, not by this app's server), so the whole
 * screen is one client island. */
export default function AddressesPage() {
  return <AccountAddresses />;
}
