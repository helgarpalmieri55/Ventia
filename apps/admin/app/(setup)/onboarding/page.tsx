import { getMe } from '../../../lib/session';
import { OnboardingWizard } from './_components/wizard';

/** Server entry point: `SetupLayout` (this route's layout) already handles
 * the `anonymous` case (redirect to /login) and tolerates `no-tenant`. This
 * page only needs to tell the client wizard which of those two remaining
 * states (`no-tenant` vs `member`) the visitor is in — the wizard itself
 * decides which step to resume from `GET /v1/admin/onboarding`. */
export default async function OnboardingPage() {
  const session = await getMe();
  return <OnboardingWizard hasTenant={session.kind === 'member'} />;
}
