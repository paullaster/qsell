import type { Metadata } from 'next';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { VendorRegisterForm } from '@/components/vendor/VendorRegisterForm';
import { auth } from '@/auth';

export const metadata: Metadata = { title: 'Become a vendor' };

export default async function VendorRegisterPage() {
  const session = await auth();
  const user = session?.user;
  const currentCustomer = user?.role === 'customer' && !user.isStaff
    ? { name: user.name, email: user.email }
    : null;
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <VendorRegisterForm currentCustomer={currentCustomer} />
    </div>
  );
}
