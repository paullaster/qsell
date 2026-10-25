import type { Metadata } from 'next';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { VendorRegisterForm } from '@/components/vendor/VendorRegisterForm';

export const metadata: Metadata = { title: 'Become a vendor' };

export default function VendorRegisterPage() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <VendorRegisterForm />
    </div>
  );
}
