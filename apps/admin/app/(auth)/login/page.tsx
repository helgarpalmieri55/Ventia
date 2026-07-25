'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from '@ventia/ui';
import { AuthError, authErrorMessage, signInEmail, fieldForAuthCode } from '../../../lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await signInEmail(email, password);
      router.push('/');
      router.refresh();
    } catch (e) {
      if (e instanceof AuthError) {
        const message = authErrorMessage(e);
        const field = fieldForAuthCode(e.code);
        if (field) {
          setFieldErrors({ [field]: message });
        } else {
          setError(message);
        }
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inicia sesión</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <FormField label="Correo" htmlFor="email" error={fieldErrors.email}>
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </FormField>
          <FormField label="Contraseña" htmlFor="password" error={fieldErrors.password}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormField>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Ingresando…' : 'Ingresar'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            ¿No tienes cuenta?{' '}
            <a className="text-primary underline" href="/registro">
              Regístrate
            </a>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
