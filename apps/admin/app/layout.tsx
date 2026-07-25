import './globals.css';

export const metadata = { title: 'Ventia Admin' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CO">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
