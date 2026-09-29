import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import type {} from 'next-auth/jwt';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { isStaffRole } from '@/server/domains/auth/roles';

declare module 'next-auth' {
  interface User {
    role?: string;
    phone?: string | null;
    customerStoreId?: string | null;
    mustChangePassword?: boolean;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      phone?: string | null;
      customerStoreId?: string | null;
      /** Set for admin-issued passwords; the user must choose their own before doing anything else. */
      mustChangePassword: boolean;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: string;
    phone?: string | null;
    customerStoreId?: string | null;
    mustChangePassword?: boolean;
    /** Epoch ms when role/status were last confirmed against the database. */
    verifiedAt?: number;
  }
}

/** `signIn()` rethrows this with its `code`, so callers can tell "unverified" from "wrong password". */
export const EMAIL_NOT_VERIFIED_CODE = 'email_not_verified';

/** Only thrown after the password matched, so it never reveals whether an address exists. */
class EmailNotVerified extends CredentialsSignin {
  override code = EMAIL_NOT_VERIFIED_CODE;
}

const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
if (!authSecret) {
  throw new Error('AUTH_SECRET is required. Generate one with: openssl rand -base64 32');
}

/**
 * How stale a staff session's role may get. JWTs live for 30 days, so without
 * this a demoted or suspended admin would keep admin access until expiry.
 */
const STAFF_REVALIDATE_MS = 60_000;

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
        // The single place credentials are checked — every sign-in path goes through here.
        if (user.emailVerifiedAt === null) throw new EmailNotVerified();

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          phone: user.phone,
          customerStoreId: user.customerStoreId,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      if (path.startsWith('/admin')) {
        if (!isStaffRole(auth?.user.role)) return false;
        if (auth?.user.mustChangePassword === true) {
          const target = new URL('/change-password', request.nextUrl);
          target.searchParams.set('callbackUrl', `${path}${request.nextUrl.search}`);
          return Response.redirect(target);
        }
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.phone = user.phone;
        token.customerStoreId = user.customerStoreId;
        token.mustChangePassword = user.mustChangePassword === true;
        token.sub = user.id;
        token.verifiedAt = Date.now();
        return token;
      }
      // Only staff sessions carry privileges worth re-checking; shopper sessions skip
      // the lookup so storefront traffic never pays for it.
      if (!isStaffRole(token.role) || Date.now() - (token.verifiedAt ?? 0) < STAFF_REVALIDATE_MS) {
        return token;
      }
      const current =
        token.sub !== undefined && token.sub !== ''
          ? await new UserRepository().findById(token.sub)
          : null;
      if (!current || !current.isActive || current.status === 'suspended') {
        return null; // Ends the session.
      }
      token.role = current.role;
      token.mustChangePassword = current.mustChangePassword;
      token.verifiedAt = Date.now();
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
        session.user.mustChangePassword = token.mustChangePassword === true;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
