import { Card, CardContent, CardHeader, CardTitle } from '@ventia/ui';

export default function AdminHome() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Ventia Admin</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Panel de administración. Disponible en la fase P1.</p>
      </CardContent>
    </Card>
  );
}
