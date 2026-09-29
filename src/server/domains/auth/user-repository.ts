import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { users, type UserRow } from '@/server/db/drizzle/schema';
import { hash, compare } from 'bcryptjs';
import type { ThemeMode } from '@/config/theme';
import type { AppRole } from './roles';
import type { DbExecutor } from './token-repository';

export type { AppRole };

function superAdminEnv() {
  const email = (
    process.env.SUPER_ADMIN_EMAIL ||
    process.env.ADMIN_EMAIL ||
    'superadmin@omnicommerce.ke'
  )
    .toLowerCase()
    .trim();
  const password =
    process.env.SUPER_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'ChangeMeSuperAdmin123!';
  const name = process.env.SUPER_ADMIN_NAME || process.env.ADMIN_NAME || 'Super Admin';
  return { email, password, name };
}

/**
 * The seed's inputs are env vars, fixed for the life of the process, so one
 * successful run per process is enough. Without this, every sign-in paid for
 * an extra bcrypt comparison (twice: loginAction and the Credentials provider).
 */
let superAdminSeed: Promise<UserRow> | null = null;

export class UserRepository {
  constructor(private readonly db = drizzleDb) {}

  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Persist the account's colour-scheme choice so it follows the user to new devices. */
  async setThemeMode(userId: string, mode: ThemeMode): Promise<void> {
    await this.db
      .update(users)
      .set({ themeMode: mode, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async create(input: {
    email: string;
    password: string;
    name: string;
    phone?: string | null;
    role?: AppRole;
    customerStoreId?: string | null;
    canViewSuperAdmin?: boolean;
    /** Self-service sign-ups start unverified; provisioned accounts are trusted. */
    emailVerified?: boolean;
  }): Promise<UserRow> {
    const passwordHash = await hash(input.password, 12);
    const [row] = await this.db
      .insert(users)
      .values({
        email: input.email.toLowerCase().trim(),
        passwordHash,
        name: input.name.trim(),
        phone: input.phone ?? null,
        role: input.role ?? 'customer',
        customerStoreId: input.customerStoreId ?? null,
        canViewSuperAdmin: input.canViewSuperAdmin ?? false,
        emailVerifiedAt: input.emailVerified === true ? new Date() : null,
      })
      .returning();
    return row!;
  }

  /** Idempotent: keeps the original verification time if already verified. */
  async markEmailVerified(userId: string, executor: DbExecutor = this.db): Promise<void> {
    const now = new Date();
    await executor
      .update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  }

  /**
   * Replace the password hash. Completing a mailed reset also proves inbox
   * control, so callers on that path pass `verifyEmail`.
   */
  async setPassword(
    userId: string,
    password: string,
    options: { verifyEmail?: boolean; executor?: DbExecutor } = {},
  ): Promise<boolean> {
    const passwordHash = await hash(password, 12);
    const now = new Date();
    const executor = options.executor ?? this.db;
    const rows = await executor
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: false,
        updatedAt: now,
        ...(options.verifyEmail === true
          ? { emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }
          : {}),
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  async verifyPassword(email: string, password: string): Promise<UserRow | null> {
    const user = await this.findByEmail(email);
    if (!user || !user.isActive || user.status === 'suspended') return null;
    const ok = await compare(password, user.passwordHash);
    return ok ? user : null;
  }

  /**
   * Ensure the deployment super-admin exists from env, re-asserting role, active
   * flag, name, and password hash so env stays the source of truth across
   * deployments. Runs once per process; a failed run is retried on next call.
   */
  async ensureSuperAdminSeed(): Promise<UserRow> {
    superAdminSeed ??= this.seedSuperAdmin().catch((error: unknown) => {
      superAdminSeed = null;
      throw error;
    });
    return await superAdminSeed;
  }

  private async seedSuperAdmin(): Promise<UserRow> {
    const { email, password, name } = superAdminEnv();
    if (!email || !password) {
      throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set');
    }

    const existing = await this.findByEmail(email);

    if (!existing) {
      return this.create({
        email,
        password,
        name,
        phone: '0700000000',
        role: 'super_admin',
        canViewSuperAdmin: true,
        emailVerified: true,
      });
    }

    const passwordMatches = await compare(password, existing.passwordHash);
    const needsUpdate =
      existing.role !== 'super_admin' ||
      !existing.isActive ||
      existing.name !== name ||
      existing.canViewSuperAdmin !== true ||
      existing.emailVerifiedAt === null ||
      existing.status !== 'active' ||
      existing.mustChangePassword ||
      !passwordMatches;

    if (!needsUpdate) return existing;

    const passwordHash = passwordMatches ? existing.passwordHash : await hash(password, 12);

    const [row] = await this.db
      .update(users)
      .set({
        role: 'super_admin',
        name,
        passwordHash,
        isActive: true,
        status: 'active',
        // Env is the password's source of truth, so a forced change would just be undone.
        mustChangePassword: false,
        canViewSuperAdmin: true,
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return row!;
  }

  /** @deprecated use ensureSuperAdminSeed */
  async ensureAdminSeed(): Promise<UserRow> {
    return this.ensureSuperAdminSeed();
  }
}
