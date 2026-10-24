import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { UserRow } from '@/server/db/drizzle/schema';
import type { EmailMessage, EmailPort } from '@/server/ports/communications';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { UserRepository } from './user-repository';
import type { AuthTokenPurpose, AuthTokenRepository } from './token-repository';
import { accountCreatedEmail, passwordResetEmail, verificationEmail } from './emails';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const TOKEN_POLICY = {
  email_verification: { ttlMs: 24 * HOUR_MS, validFor: '24 hours', path: '/verify-email' },
  password_reset: { ttlMs: HOUR_MS, validFor: '1 hour', path: '/reset-password' },
} as const satisfies Record<AuthTokenPurpose, { ttlMs: number; validFor: string; path: string }>;

/** Per user and purpose: stops inbox flooding and bounds SMTP spend from a single target. */
const SEND_THROTTLE = { minIntervalMs: MINUTE_MS, maxPerHour: 5 } as const;

/** Tokens are 32 random bytes in base64url; anything else is rejected before touching the DB. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type TokenRedemption = 'ok' | 'invalid';

export interface AccountServiceDeps {
  db: DrizzleDb;
  users: UserRepository;
  tokens: AuthTokenRepository;
  email: EmailPort;
  companySettings: CompanySettingsRepository;
}

/**
 * Email verification and password recovery.
 *
 * Request-side methods (`sendVerification`, `requestPasswordReset`, ...) never
 * reveal whether an address has an account: they resolve identically either
 * way, and callers run them after the response is sent so latency cannot leak
 * it either. Redeem-side methods consume a token exactly once.
 */
export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  /** Mail a verification link to a newly registered (or still unverified) user. */
  async sendVerification(user: Pick<UserRow, 'id' | 'email' | 'name'>): Promise<void> {
    await this.issueAndSend(user, 'email_verification', verificationEmail);
  }

  /**
   * Tell a user an administrator created their account, including the
   * temporary password. Safe only because such accounts must change that
   * password at first sign-in; the password is never persisted in plaintext.
   */
  async sendAccountCreated(
    user: Pick<UserRow, 'email' | 'name'>,
    temporaryPassword: string,
  ): Promise<void> {
    const context = await this.mailContext();
    await this.deps.email.send(
      accountCreatedEmail({
        to: user.email,
        recipientName: user.name,
        storeName: context.storeName,
        actionUrl: `${context.baseUrl}/login`,
        temporaryPassword,
      }),
    );
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.deps.users.findByEmail(email);
    if (user === null) {
      return;
    }
    if (user.emailVerifiedAt !== null || !isAccountUsable(user)) {
      return;
    }
    await this.issueAndSend(user, 'email_verification', verificationEmail);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.deps.users.findByEmail(email);
    if (user === null || !isAccountUsable(user)) {
      return;
    }
    await this.issueAndSend(user, 'password_reset', passwordResetEmail);
  }

  async verifyEmail(token: string): Promise<TokenRedemption> {
    if (!TOKEN_SHAPE.test(token)) {
      return 'invalid';
    }
    return await this.deps.db.transaction(async (tx) => {
      const userId = await this.deps.tokens.consume(token, 'email_verification', tx);
      if (userId === null) {
        return 'invalid';
      }
      await this.deps.users.markEmailVerified(userId, tx);
      return 'ok';
    });
  }

  /** Caller must have validated `password` against the shared password policy. */
  async resetPassword(token: string, password: string): Promise<TokenRedemption> {
    if (!TOKEN_SHAPE.test(token)) {
      return 'invalid';
    }
    return await this.deps.db.transaction(async (tx) => {
      const userId = await this.deps.tokens.consume(token, 'password_reset', tx);
      if (userId === null) {
        return 'invalid';
      }
      await this.deps.users.setPassword(userId, password, { verifyEmail: true, executor: tx });
      // Receiving the reset mail proved inbox control, so pending verification links are moot.
      await this.deps.tokens.revokeOutstanding(userId, 'email_verification', tx);
      return 'ok';
    });
  }

  private async issueAndSend(
    user: Pick<UserRow, 'id' | 'email' | 'name'>,
    purpose: AuthTokenPurpose,
    render: typeof verificationEmail,
  ): Promise<void> {
    if (await this.isThrottled(user.id, purpose)) {
      return;
    }
    const policy = TOKEN_POLICY[purpose];
    const [token, context] = await Promise.all([
      this.deps.tokens.issue(user.id, purpose, policy.ttlMs),
      this.mailContext(),
    ]);
    const actionUrl = `${context.baseUrl}${policy.path}?token=${encodeURIComponent(token)}`;
    const message: EmailMessage = render({
      to: user.email,
      recipientName: user.name,
      storeName: context.storeName,
      actionUrl,
      validFor: policy.validFor,
    });
    await this.deps.email.send(message);
  }

  private async isThrottled(userId: string, purpose: AuthTokenPurpose): Promise<boolean> {
    const now = Date.now();
    const stats = await this.deps.tokens.issuanceSince(userId, purpose, new Date(now - HOUR_MS));
    if (stats.count >= SEND_THROTTLE.maxPerHour) {
      return true;
    }
    return stats.latestAt !== null && now - stats.latestAt.getTime() < SEND_THROTTLE.minIntervalMs;
  }

  private async mailContext(): Promise<{ baseUrl: string; storeName: string }> {
    const settings = await this.deps.companySettings.ensureSeeded();
    return {
      baseUrl: resolvePublicBaseUrl(settings.publicBaseUrl),
      storeName: settings.tradingName.trim() === '' ? 'our store' : settings.tradingName,
    };
  }
}

function isAccountUsable(user: UserRow): boolean {
  return user.isActive && user.status !== 'suspended';
}

/**
 * Links are built only from configuration, never from the request's Host
 * header, so a forged Host cannot redirect a victim's reset link to an attacker.
 */
export function resolvePublicBaseUrl(configured: string | null): string {
  const candidates = [
    configured,
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.AUTH_URL,
    process.env.NEXTAUTH_URL,
  ];
  const found = candidates.find((value): value is string => (value?.trim() ?? '') !== '');
  if (found !== undefined) {
    return found.trim().replace(/\/+$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('No public base URL configured; set APP_URL to send account emails.');
  }
  return 'http://localhost:3000';
}
