import { Card, CardContent, CardHeader, CardTitle } from '@ventia/ui';
import { ChecklistPanel } from '../../_components/checklist-panel';

/** Owner-only nav item (see lib/nav.ts's OWNER_ONLY_ITEMS): reuses the same
 * `ChecklistPanel` the onboarding wizard's last step renders (task-3 brief:
 * "same checklist component reused"), so a merchant who already finished the
 * wizard — or a staff session hitting this URL directly — sees the exact
 * same checklist/launch/live-status behavior here as inside the wizard. */
export default function LanzamientoPage() {
  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Lanzamiento</CardTitle>
      </CardHeader>
      <CardContent>
        <ChecklistPanel />
      </CardContent>
    </Card>
  );
}
