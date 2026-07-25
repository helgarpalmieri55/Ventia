import { Card, CardContent, CardHeader, CardTitle } from '@ventia/ui';

/** Placeholder: the onboarding wizard itself (store info → branding →
 * products → payments → launch checklist) is Task 3's scope. This page
 * exists so Task 2's redirect target (`(app)`'s no-tenant → /onboarding)
 * has somewhere real to land and the route group builds/typechecks. */
export default function OnboardingPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configura tu tienda</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          El asistente de configuración de tu tienda estará disponible aquí.
        </p>
      </CardContent>
    </Card>
  );
}
