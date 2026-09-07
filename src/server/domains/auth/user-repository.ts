import { eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { users, type UserRow } from '@/server/db/drizzle/schema';
import { hash, compare } from 'bcryptjs';

export type AppRole = 'admin' | 'manager' | 'customer';

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

  async create(input: {
    email: string;
    password: string;
    name: string;
    phone?: string | null;
    role?: AppRole;
    customerStoreId?: string | null;
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
      })
      .returning();
    return row!;
  }

  async verifyPassword(email: string, password: string): Promise<UserRow | null> {
    const user = await this.findByEmail(email);
    if (!user || !user.isActive) return null;
    const ok = await compare(password, user.passwordHash);
    return ok ? user : null;
  }

  async ensureAdminSeed(): Promise<UserRow> {
    const email = (process.env.ADMIN_EMAIL || 'admin@omnicommerce.ke').toLowerCase();
    const existing = await this.findByEmail(email);
    if (existing) return existing;
    const password = process.env.ADMIN_PASSWORD || 'ChangeMeAdmin123!';
    return this.create({
      email,
      password,
      name: process.env.ADMIN_NAME || 'Admin',
      phone: '0700000000',
      role: 'admin',
    });
  }
}
