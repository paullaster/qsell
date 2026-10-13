export class FinanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues: { code?: string; message: string; line?: number }[] = [],
  ) {
    super(message);
  }
}

/** Who is doing it and from where; set by the server entry point, never by the browser. */
export interface FinanceContext {
  companyId: string;
  actor: { type: 'user' | 'system' | 'job' | 'integration'; id: string | null };
  origin: {
    surface: string;
    action: string;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    sessionId?: string | null;
    permissionUsed?: string | null;
  };
}
