import type { DrizzleDb } from '@/server/db/drizzle/client';
import { evaluateCondition } from './condition';
import { resolveGrant } from './resolve';
import { ALL_PERMISSION_KEYS, type PermissionKey } from './permissions';
import { AccessControlRepository, type PolicyMatch, type PermissionGrant, type UserAccessModel } from './repository';

/**
 * Every access decision in the application funnels through this service.
 *
 * Evaluation order (first match wins):
 *   1. super_admin bypass            → allow
 *   2. RBAC grants, resolved per permission (see resolveGrant):
 *        a. a direct (per-user) grant beats any role grant
 *        b. among roles, the lowest priority number wins the collision
 *   3. implied read (any allow on a resource lets you read it)
 *   4. ABAC policies (priority asc)  → first enabled matching policy's effect
 *   5. default                       → deny           (fail closed)
 *
 * Enforcement sits at the RBAC layer for coarse grants and the ABAC layer for
 * fine-grained, context-aware rules. Either layer alone is a total order: a
 * user can be fully authorized by RBAC grants even when no ABAC policy exists,
 * and a user with no role grants can still be admitted by an ABAC policy.
 *
 * Performance: models are cached per user (TTL-bounded LRU) and policies are
 * cached per permission key. Every authorization is a pure, in-process lookup
 * after the first miss, so per-request cost is one Map read.
 */

export interface AccessContext {
  branchId?: string | null;
  [key: string]: unknown;
}

export type AccessDecision =
  | {
      allowed: true;
      source: 'super_admin' | 'direct' | 'role' | 'policy' | 'implied';
      grantedBy?: { policyId: string; policyKey: string };
      roleKey?: string;
    }
  | { allowed: false; reason: 'deny-grant' | 'no-grant' | 'policy-deny' | 'inactive' | 'unknown-user' };

export interface AccessSnapshot {
  userId: string;
  superAdmin: boolean;
  roleKeys: string[];
  permissions: PermissionKey[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_USER_TTL_MS = 30_000;
const DEFAULT_POLICY_TTL_MS = 30_000;
const MAX_USER_ENTRIES = 5_000;
const MAX_POLICY_ENTRIES = 1_000;

export class AccessDeniedError extends Error {
  constructor(
    public readonly permissionKey: string,
    public readonly decision: AccessDecision,
  ) {
    super(`Access denied for ${permissionKey} (${decision.allowed ? 'n/a' : decision.reason})`);
    this.name = 'AccessDeniedError';
  }
}

export class AccessControlService {
  private readonly userCache = new Map<string, CacheEntry<UserAccessModel>>();
  private readonly policyCache = new Map<string, CacheEntry<PolicyMatch[]>>();
  private readonly inFlightUsers = new Map<string, Promise<UserAccessModel | null>>();
  private readonly inFlightPolicies = new Map<string, Promise<PolicyMatch[]>>();

  readonly repo: AccessControlRepository;

  constructor(
    db: DrizzleDb,
    private readonly userTtlMs = DEFAULT_USER_TTL_MS,
    private readonly policyTtlMs = DEFAULT_POLICY_TTL_MS,
  ) {
    this.repo = new AccessControlRepository(db);
  }

  // ---------- public API ----------

  async can(userId: string, permissionKey: PermissionKey, ctx?: AccessContext): Promise<boolean> {
    const decision = await this.authorize(userId, permissionKey, ctx);
    return decision.allowed;
  }

  async assert(userId: string, permissionKey: PermissionKey, ctx?: AccessContext): Promise<void> {
    const decision = await this.authorize(userId, permissionKey, ctx);
    if (!decision.allowed) throw new AccessDeniedError(permissionKey, decision);
  }

  /** Snapshot of a user's roles + allowed permission keys for UI rendering. */
  async snapshot(userId: string): Promise<AccessSnapshot> {
    const model = await this.getUserModel(userId);
    if (!model) return { userId, superAdmin: false, roleKeys: [], permissions: [] };

    const roleKeys = new Set<string>();
    const allowed = new Set<PermissionKey>();
    const keys = new Set<string>();
    for (const grant of model.grants) {
      if (grant.roleKey !== null) roleKeys.add(grant.roleKey);
      keys.add(grant.permissionKey);
    }
    // Same precedence as decide(); branch scope is ignored (the snapshot is context-free).
    for (const key of keys) {
      if (resolveGrant(model.grants, key, () => true)?.effect === 'allow') {
        allowed.add(key as PermissionKey);
        // Mirror decide(): any allow on a resource implies reading it.
        const read = `${key.split(':')[0] ?? ''}:read`;
        if (resolveGrant(model.grants, read, () => true)?.effect !== 'deny') {
          allowed.add(read as PermissionKey);
        }
      }
    }
    const superAdmin = model.superAdmin;

    if (superAdmin) {
      roleKeys.add('super_admin');
      return { userId, superAdmin: true, roleKeys: [...roleKeys], permissions: [...ALL_PERMISSION_KEYS] };
    }
    return {
      userId,
      superAdmin: false,
      roleKeys: [...roleKeys],
      permissions: [...allowed].filter((key) => ALL_PERMISSION_KEYS.includes(key)),
    };
  }

  async authorize(userId: string, permissionKey: PermissionKey, ctx?: AccessContext): Promise<AccessDecision> {
    const model = await this.getUserModel(userId);
    return await this.decide(model, permissionKey, ctx);
  }

  /** Invalidate a single user's grants (call after grant/role mutations). */
  invalidateUser(userId: string): void {
    this.userCache.delete(userId);
    this.inFlightUsers.delete(userId);
  }

  /** Invalidate cached policies (call after policy CRUD). */
  invalidatePolicies(): void {
    this.policyCache.clear();
    this.inFlightPolicies.clear();
  }

  // ---------- decision ----------

  private async decide(model: UserAccessModel | null, key: PermissionKey, ctx?: AccessContext): Promise<AccessDecision> {
    if (!model) return { allowed: false, reason: 'unknown-user' };
    if (!model.isActive) return { allowed: false, reason: 'inactive' };

    // 1. super_admin bypass.
    if (model.superAdmin) {
      return { allowed: true, source: 'super_admin' };
    }

    const inScope = (branchId: string | null): boolean =>
      branchId === null || branchId === (ctx?.branchId ?? null);

    // 2. RBAC: direct user grants beat role grants; among roles the lowest priority number wins.
    const resolved = resolveGrant(model.grants, key, inScope);
    if (resolved) {
      if (resolved.effect === 'deny') return { allowed: false, reason: 'deny-grant' };
      return resolved.source === 'direct'
        ? { allowed: true, source: 'direct' }
        : { allowed: true, source: 'role', roleKey: resolved.roleKey ?? undefined };
    }

    // 5b. Any allow on a resource implies reading it (e.g. products:update ⇒ products:read).
    // Explicit read denies were already honoured in steps 2 and 4.
    if (key.endsWith(':read')) {
      const resource = key.slice(0, -'read'.length);
      const impliesRead = model.grants.some(
        (g) => g.effect === 'allow' && g.permissionKey.startsWith(resource) && inScope(g.scopeBranchId),
      );
      if (impliesRead) return { allowed: true, source: 'implied' };
    }

    // 6. ABAC policies.
    const policies = await this.getPolicies(key);
    for (const policy of policies) {
      if (!policy.isEnabled) continue;
      const matched = evaluateCondition(policy.condition, {
        user: model.attrs,
        ctx: ctx ?? {},
        res: {},
      });
      if (matched) {
        if (policy.effect === 'allow') {
          return { allowed: true, source: 'policy', grantedBy: { policyId: policy.id, policyKey: policy.key } };
        }
        return { allowed: false, reason: 'policy-deny' };
      }
    }

    // 7. fail closed.
    return { allowed: false, reason: 'no-grant' };
  }

  // ---------- caches ----------

  private async getUserModel(userId: string): Promise<UserAccessModel | null> {
    const now = Date.now();
    const cached = this.userCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.value;

    const inFlight = this.inFlightUsers.get(userId);
    if (inFlight) {
      return await inFlight;
    }

    const promise = this.loadUserModel(userId).finally(() => {
      this.inFlightUsers.delete(userId);
    });
    this.inFlightUsers.set(userId, promise);
    return await promise;
  }

  private async loadUserModel(userId: string): Promise<UserAccessModel | null> {
    const model = await this.repo.getUserAccessModel(userId);
    if (model !== null) this.setUserCache(userId, model);
    return model;
  }

  private setUserCache(userId: string, model: UserAccessModel): void {
    if (this.userCache.size >= MAX_USER_ENTRIES) {
      const oldest = this.userCache.entries().next().value;
      if (oldest) this.userCache.delete(oldest[0]);
    }
    this.userCache.set(userId, { value: model, expiresAt: Date.now() + this.userTtlMs });
  }

  private getPolicies(key: PermissionKey): Promise<PolicyMatch[]> {
    const now = Date.now();
    const cached = this.policyCache.get(key);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);

    const inFlight = this.inFlightPolicies.get(key);
    if (inFlight) return inFlight;

    const promise = this.repo
      .listPolicies(key)
      .then((rows) => {
        if (this.policyCache.size >= MAX_POLICY_ENTRIES) {
          const oldest = this.policyCache.entries().next().value;
          if (oldest) this.policyCache.delete(oldest[0]);
        }
        this.policyCache.set(key, { value: rows, expiresAt: Date.now() + this.policyTtlMs });
        return rows;
      })
      .finally(() => {
        this.inFlightPolicies.delete(key);
      });
    this.inFlightPolicies.set(key, promise);
    return promise;
  }
}