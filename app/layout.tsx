import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OmniCommerce — Hardware & Electronics',
  description: 'Kenya-focused omnichannel commerce and payment gateway console',
};

export default function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-black text-zinc-300 font-sans antialiased">
        {children}
        {modal}
      </body>
    </html>
  );
}
