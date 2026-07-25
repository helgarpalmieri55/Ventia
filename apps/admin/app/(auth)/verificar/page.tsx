import { Alert, Card, CardContent, CardHeader, CardTitle } from '@ventia/ui';

export default function VerificarPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verifica tu correo</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-foreground">Revisa tu correo para verificar tu cuenta.</p>
        <Alert variant="info">
          En ambiente de desarrollo no se envían correos reales: el enlace de verificación aparece impreso en la
          consola del servidor de la API.
        </Alert>
      </CardContent>
    </Card>
  );
}
