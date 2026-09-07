'use client';

import React, { createContext, useContext, useMemo } from 'react';
import {
  DEFAULT_COMPANY_UI_CONFIG,
  resolveCompanyUiConfig,
  type CompanyUiConfig,
  type CompanyUiConfigRaw,
} from '@/config/company-ui';

const CompanyUiConfigContext = createContext<CompanyUiConfig>(DEFAULT_COMPANY_UI_CONFIG);

export function CompanyUiConfigProvider({
  value,
  children,
}: {
  value?: CompanyUiConfigRaw | CompanyUiConfig | null;
  children: React.ReactNode;
}) {
  const resolved = useMemo(() => resolveCompanyUiConfig(value ?? null), [value]);
  return (
    <CompanyUiConfigContext.Provider value={resolved}>{children}</CompanyUiConfigContext.Provider>
  );
}

export function useCompanyUiConfig(): CompanyUiConfig {
  return useContext(CompanyUiConfigContext);
}
