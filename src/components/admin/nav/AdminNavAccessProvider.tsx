'use client';

import { createContext, useContext } from 'react';
import type { AdminNavAccess } from '@/config/admin-nav';

const AdminNavAccessContext = createContext<AdminNavAccess | null>(null);

export function AdminNavAccessProvider({
  access,
  children,
}: {
  access: AdminNavAccess;
  children: React.ReactNode;
}) {
  return <AdminNavAccessContext.Provider value={access}>{children}</AdminNavAccessContext.Provider>;
}

/** Null outside the admin shell, which the nav treats as "may see nothing". */
export function useAdminNavAccess(): AdminNavAccess | null {
  return useContext(AdminNavAccessContext);
}
