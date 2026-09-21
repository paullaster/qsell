import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { isStaffRole } from '@/server/domains/auth/roles';

declare module 'next-auth' {
  interface User {
    role?: string;
    phone?: string | null;
    customerStoreId?: string | null;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      phone?: string | null;
      customerStoreId?: string | null;
    };
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    role?: string;
    phone?: string | null;
    customerStoreId?: string | null;
  }
}

const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
if (!authSecret) {
  throw new Error('AUTH_SECRET is required. Generate one with: openssl rand -base64 32');
}

const authConfig = {
  secret: authSecret,
  trustHost: true,
  session: { strategy: 'jwt' as const },
  pages: {
    signIn: '/login',
  },
  // Stale cookies from a previous secret only need a quiet clear, not log spam.
  logger: {
    error(error: Error | string) {
      const name = typeof error === 'string' ? error : error?.name;
      if (name === 'JWTSessionError') return;
      console.error('[auth][error]', error);
    },
  },
  providers: [
    Credentials({
      id: 'credentials',
      name: 'Email and Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        const email = String(credentials?.email || '')
          .toLowerCase()
          .trim();
        const password = String(credentials?.password || '');
        if (!email || !password) return null;

        const users = new UserRepository();
        await users.ensureSuperAdminSeed();
        const user = await users.verifyPassword(email, password);
        if (!user) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          phone: user.phone,
          customerStoreId: user.customerStoreId,
        };
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      if (path.startsWith('/admin')) {
        return isStaffRole(auth?.user?.role);
      }
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.phone = user.phone;
        token.customerStoreId = user.customerStoreId;
        token.sub = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub || '';
        session.user.role = (typeof token.role === 'string' ? token.role : null) || 'customer';
        session.user.phone =
          typeof token.phone === 'string' || token.phone === null ? token.phone : null;
        session.user.customerStoreId =
          typeof token.customerStoreId === 'string' || token.customerStoreId === null
            ? token.customerStoreId
            : null;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
