'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from '@ventia/ui';
import { AuthError, authErrorMessage, signUpEmail } from '../../../lib/auth';

export default function RegistroPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signUpEmail(name, email, password);
      // The onboarding wizard (Task 3) picks up from here: a freshly
      // signed-up user has no tenant yet, so the (app) layout's getMe()
      // check will redirect '/' → '/onboarding' on the next request.
      router.push('/');
      router.refresh();
    } catch (e) {
      setError(e instanceof AuthError ? authErrorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crea tu tienda</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <FormField label="Nombre" htmlFor="name">
            <Input
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>
          <FormField label="Correo" htmlFor="email">
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </FormField>
          <FormField label="Contraseña" htmlFor="password">
            <Input
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormField>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creando cuenta…' : 'Crear cuenta'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            ¿Ya tienes cuenta?{' '}
            <a className="text-primary underline" href="/login">
              Inicia sesión
            </a>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
