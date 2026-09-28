import { eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { users, type UserRow } from '@/server/db/drizzle/schema';
import { hash, compare } from 'bcryptjs';
import type { ThemeMode } from '@/config/theme';
import type { AppRole } from './roles';

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
      })
      .returning();
    return row!;
  }

  async verifyPassword(email: string, password: string): Promise<UserRow | null> {
    const user = await this.findByEmail(email);
    if (!user || !user.isActive || user.status === 'suspended') return null;
    const ok = await compare(password, user.passwordHash);
    return ok ? user : null;
  }

  /**
   * Always ensure the deployment super-admin exists from env.
   * Re-asserts role, active flag, name, and password hash from env on every call
   * so credentials stay the source of truth across deployments.
   */
  async ensureSuperAdminSeed(): Promise<UserRow> {
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
      });
    }

    const passwordMatches = await compare(password, existing.passwordHash);
    const needsUpdate =
      existing.role !== 'super_admin' ||
      !existing.isActive ||
      existing.name !== name ||
      existing.canViewSuperAdmin !== true ||
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
        canViewSuperAdmin: true,
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
