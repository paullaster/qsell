import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import type {} from 'next-auth/jwt';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { findPortalAccess } from '@/server/domains/vendors/portal-access';

declare module 'next-auth' {
  interface User {
    role?: string;
    isStaff?: boolean;
    phone?: string | null;
    customerStoreId?: string | null;
    mustChangePassword?: boolean;
    vendorId?: string | null;
    vendorRole?: string | null;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      /** Primary role is a back-office role (roles.is_staff); gates /admin. */
      isStaff: boolean;
      phone?: string | null;
      customerStoreId?: string | null;
      /** Set for admin-issued passwords; the user must choose their own before doing anything else. */
      mustChangePassword: boolean;
      /** Set only for a vendor portal user: the vendor business they act for and their portal role. */
      vendorId?: string | null;
      vendorRole?: string | null;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: string;
    isStaff?: boolean;
    phone?: string | null;
    customerStoreId?: string | null;
    mustChangePassword?: boolean;
    /** Epoch ms when role/status were last confirmed against the database. */
    verifiedAt?: number;
    vendorId?: string | null;
    vendorRole?: string | null;
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

/** Portal pages anyone may open: signing up. Everything else under /vendor needs a vendor session. */
const PUBLIC_VENDOR_PATHS = new Set(['/vendor/register']);

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

        // A vendor login is only valid while it belongs to a vendor business.
        const portal = user.role === 'vendor' ? await findPortalAccess(user.id) : null;
        if (user.role === 'vendor' && portal === null) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          isStaff: await users.isStaffRoleKey(user.role),
          phone: user.phone,
          customerStoreId: user.customerStoreId,
          mustChangePassword: user.mustChangePassword,
          vendorId: portal?.vendorId ?? null,
          vendorRole: portal?.portalRole ?? null,
        };
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      if (path.startsWith('/admin')) {
        if (auth?.user.isStaff !== true) return false;
        if (auth?.user.mustChangePassword === true) {
          const target = new URL('/change-password', request.nextUrl);
          target.searchParams.set('callbackUrl', `${path}${request.nextUrl.search}`);
          return Response.redirect(target);
        }
      }
      if (path.startsWith('/vendor') && !PUBLIC_VENDOR_PATHS.has(path)) {
        // Staff never use the portal and vendors never use the back office.
        if (auth?.user.isStaff === true) return Response.redirect(new URL('/admin', request.nextUrl));
        return auth?.user.role === 'vendor' && typeof auth.user.vendorId === 'string' && auth.user.vendorId !== '';
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.isStaff = user.isStaff === true;
        token.phone = user.phone;
        token.customerStoreId = user.customerStoreId;
        token.mustChangePassword = user.mustChangePassword === true;
        token.sub = user.id;
        token.vendorId = user.vendorId ?? null;
        token.vendorRole = user.vendorRole ?? null;
        token.verifiedAt = Date.now();
        return token;
      }
      // Only non-shopper sessions carry privileges worth re-checking; shopper sessions skip
      // the lookup so storefront traffic never pays for it. Tokens issued before the staff
      // flag existed (isStaff undefined) refresh immediately.
      if (
        token.role === 'customer' ||
        (token.isStaff !== undefined && Date.now() - (token.verifiedAt ?? 0) < STAFF_REVALIDATE_MS)
      ) {
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
      token.isStaff = await new UserRepository().isStaffRoleKey(current.role);
      token.mustChangePassword = current.mustChangePassword;
      if (current.role === 'vendor') {
        // A removed portal user or an archived vendor ends the session at the next check.
        const portal = await findPortalAccess(current.id);
        if (portal === null) return null;
        token.vendorId = portal.vendorId;
        token.vendorRole = portal.portalRole;
      } else {
        token.vendorId = null;
        token.vendorRole = null;
      }
      token.verifiedAt = Date.now();
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub || '';
        session.user.role = (typeof token.role === 'string' ? token.role : null) || 'customer';
        session.user.isStaff = token.isStaff === true;
        session.user.phone =
          typeof token.phone === 'string' || token.phone === null ? token.phone : null;
        session.user.customerStoreId =
          typeof token.customerStoreId === 'string' || token.customerStoreId === null
            ? token.customerStoreId
            : null;
        session.user.mustChangePassword = token.mustChangePassword === true;
        session.user.vendorId = typeof token.vendorId === 'string' ? token.vendorId : null;
        session.user.vendorRole = typeof token.vendorRole === 'string' ? token.vendorRole : null;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
