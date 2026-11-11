import NextAuth, { CredentialsSignin, type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type {} from 'next-auth/jwt';
import { firstFilled } from '@/lib/values';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { findPortalAccess } from '@/server/domains/vendors/portal-access';

declare module 'next-auth' {
  interface User {
    role?: string;
    isStaff?: boolean;
    phone?: string | null;
    customerStoreId?: string | null;
    mustChangePassword?: boolean;
    /** A rider who signed in with a PIN the office handed out must choose their own first. */
    mustChangePin?: boolean;
    /** When the PIN this session was made with was set: a later reset or removal ends the session. */
    pinStamp?: number;
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
      mustChangePin: boolean;
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
    mustChangePin?: boolean;
    pinStamp?: number;
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

/** Signing in with a PIN failed because too many wrong tries shut the rider out; says for how long. */
export const RIDER_PIN_LOCKED_CODE = 'rider_pin_locked';
export class RiderPinLocked extends CredentialsSignin {
  override code = RIDER_PIN_LOCKED_CODE;
  constructor(readonly words: string) {
    super();
  }
}

const authSecret = firstFilled(process.env.AUTH_SECRET, process.env.NEXTAUTH_SECRET);
if (authSecret === null) {
  throw new Error('AUTH_SECRET is required. Generate one with: openssl rand -base64 32');
}

/**
 * How stale a staff session's role may get. JWTs live for 30 days, so without
 * this a demoted or suspended admin would keep admin access until expiry.
 */
const STAFF_REVALIDATE_MS = 60_000;

/** Portal pages anyone may open: signing up. Everything else under /vendor needs a vendor session. */
const PUBLIC_VENDOR_PATHS = new Set(['/vendor/register', '/vendor/invitations/accept']);

/** A phone fetches the app's manifest without sign-in cookies, so it must be open for the app to be installable. */
const RIDER_MANIFEST_PATH = '/rider/manifest.webmanifest';
/** The rider app's own sign-in (phone number and PIN) and where a rider chooses their own PIN. */
export const RIDER_SIGN_IN_PATH = '/rider/sign-in';
export const RIDER_PIN_PATH = '/rider/pin';

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
      const name = typeof error === 'string' ? error : error.name;
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
        const email = typeof credentials.email === 'string' ? credentials.email.toLowerCase().trim() : '';
        const password = typeof credentials.password === 'string' ? credentials.password : '';
        if (email === '' || password === '') return null;

        const users = new UserRepository();
        await users.ensureSuperAdminSeed();
        const user = await users.verifyPassword(email, password);
        if (user === null) return null;
        // The single place credentials are checked — every sign-in path goes through here.
        if (user.emailVerifiedAt === null) throw new EmailNotVerified();

        // A vendor login is only valid while it belongs to a vendor business.
        const portal = user.role === 'vendor' || user.role === 'customer' ? await findPortalAccess(user.id) : null;
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
    Credentials({
      id: 'rider-pin',
      name: 'Phone number and PIN',
      credentials: {
        phone: { label: 'Phone number', type: 'tel' },
        pin: { label: 'PIN', type: 'password' },
      },
      authorize: async (credentials) => {
        const { getContainer } = await import('@/server/di/container');
        const pins = getContainer().riderPins;
        const checked = await pins.verify(credentials.phone, credentials.pin);
        if (!checked.ok) {
          if (checked.reason === 'locked') throw new RiderPinLocked(checked.words);
          return null;
        }
        const user = await new UserRepository().findById(checked.userId);
        if (user === null || !user.isActive || user.status === 'suspended') return null;
        // A PIN opens the rider app and nothing else: never a back-office account, whatever the account holds.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          isStaff: false,
          phone: user.phone,
          customerStoreId: null,
          mustChangePassword: false,
          mustChangePin: checked.mustChange,
          pinStamp: (await pins.stampFor(user.id)) ?? 0,
          vendorId: null,
          vendorRole: null,
        };
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      const person = auth?.user;
      if (path.startsWith('/admin')) {
        if (person?.isStaff !== true) return false;
        if (person.mustChangePassword) {
          const target = new URL('/change-password', request.nextUrl);
          target.searchParams.set('callbackUrl', `${path}${request.nextUrl.search}`);
          return Response.redirect(target);
        }
      }
      if (path.startsWith('/rider') && path !== RIDER_MANIFEST_PATH && path !== RIDER_SIGN_IN_PATH) {
        // Anyone signed in may reach the door; the pages and actions decide whether they are a rider.
        if (person === undefined) return Response.redirect(new URL(RIDER_SIGN_IN_PATH, request.nextUrl));
        // A PIN the office handed out is replaced with the rider's own before anything else.
        if (person.mustChangePin && path !== RIDER_PIN_PATH) return Response.redirect(new URL(RIDER_PIN_PATH, request.nextUrl));
        if (person.mustChangePassword) {
          const target = new URL('/change-password', request.nextUrl);
          target.searchParams.set('callbackUrl', `${path}${request.nextUrl.search}`);
          return Response.redirect(target);
        }
      }
      if (path.startsWith('/vendor') && !PUBLIC_VENDOR_PATHS.has(path)) {
        // Staff never use the portal and vendors never use the back office.
        if (person?.isStaff === true) return Response.redirect(new URL('/admin', request.nextUrl));
        return (person?.role === 'vendor' || person?.role === 'customer') && typeof person.vendorId === 'string' && person.vendorId !== '' && typeof person.vendorRole === 'string';
      }
      return true;
    },
    async jwt({ token, user }) {
      // The library types `user` as always present, but it is only there on the call that signs someone in.
      const signedIn = user as typeof user | undefined;
      if (signedIn !== undefined) {
        return {
          ...token,
          role: signedIn.role,
          isStaff: signedIn.isStaff === true,
          phone: signedIn.phone,
          customerStoreId: signedIn.customerStoreId,
          mustChangePassword: signedIn.mustChangePassword === true,
          mustChangePin: signedIn.mustChangePin === true,
          pinStamp: signedIn.pinStamp,
          sub: signedIn.id,
          vendorId: signedIn.vendorId ?? null,
          vendorRole: signedIn.vendorRole ?? null,
          verifiedAt: Date.now(),
        };
      }
      // Only non-shopper sessions carry privileges worth re-checking; shopper sessions skip
      // the lookup so storefront traffic never pays for it. Tokens issued before the staff
      // flag existed (isStaff undefined) refresh immediately.
      if (
        (token.role === 'customer' && (token.vendorId === null || token.vendorId === undefined)) ||
        (token.isStaff !== undefined && Date.now() - (token.verifiedAt ?? 0) < STAFF_REVALIDATE_MS)
      ) {
        return token;
      }
      const current = token.sub !== undefined && token.sub !== '' ? await new UserRepository().findById(token.sub) : null;
      if (current === null || !current.isActive || current.status === 'suspended') {
        return null; // Ends the session.
      }
      // A session made with a PIN ends when the office gives that rider a new PIN or turns the PIN off, or the rider changes it elsewhere.
      if (typeof token.pinStamp === 'number') {
        const { getContainer } = await import('@/server/di/container');
        if ((await getContainer().riderPins.stampFor(current.id)) !== token.pinStamp) return null;
      }
      const refreshed = {
        ...token,
        role: current.role,
        isStaff: await new UserRepository().isStaffRoleKey(current.role),
        mustChangePassword: current.mustChangePassword,
        verifiedAt: Date.now(),
      };
      if (current.role === 'vendor' || current.role === 'customer') {
        // A removed portal user or an archived vendor ends the session at the next check.
        const portal = await findPortalAccess(current.id);
        if (portal === null && current.role === 'vendor') return null;
        return { ...refreshed, vendorId: portal?.vendorId ?? null, vendorRole: portal?.portalRole ?? null };
      }
      return { ...refreshed, vendorId: null, vendorRole: null };
    },
    session({ session, token }) {
      const role = typeof token.role === 'string' && token.role !== '' ? token.role : 'customer';
      return {
        ...session,
        user: {
          ...session.user,
          id: token.sub ?? '',
          role,
          isStaff: token.isStaff === true,
          phone: typeof token.phone === 'string' || token.phone === null ? token.phone : null,
          customerStoreId: typeof token.customerStoreId === 'string' || token.customerStoreId === null ? token.customerStoreId : null,
          mustChangePassword: token.mustChangePassword === true,
          mustChangePin: token.mustChangePin === true,
          vendorId: typeof token.vendorId === 'string' ? token.vendorId : null,
          vendorRole: typeof token.vendorRole === 'string' ? token.vendorRole : null,
        },
      };
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
