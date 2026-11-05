// Based on the Lyrcloud repo's api/account/roles.mjs (same user pool, same role model); the work API
// uses it to recognise the super admin and admins. Keep the shared rules in step with Lyrcloud.
//
// Account roles: "superadmin", "admin" or "user" (same model as Lyrshop).
//
// The super admin is never stored: it is derived on every request from the
// profile Cognito returns. Google sign-ins arrive with email_verified=false
// (the attribute isn't mapped) and the GitHub bridge passes through whatever
// email GitHub reports, so the email alone isn't proof of ownership. Google
// only issues @gmail.com identities to the mailbox owner, so the super admin
// must also have signed in through Google.
export const SUPER_ADMIN_PROVIDER = 'GoogleOIDC';
export const ASSIGNABLE_ROLES = ['admin', 'user'];

// "Cognito" is an email-and-password account (sign-up form with an emailed code).
export const EMAIL_PROVIDER = 'Cognito';
const KNOWN_PROVIDERS = ['GoogleOIDC', 'GitHubBridge', EMAIL_PROVIDER];

// Cognito builds federated usernames as "<provider>_<id>" but may lowercase the provider part
// ("googleoidc_123…"), so an exact match on "GoogleOIDC" can miss the super admin. Map any casing
// back to the provider's configured name.
export function normalizeProvider(provider) {
  const raw = String(provider || '');
  return KNOWN_PROVIDERS.find((name) => name.toLowerCase() === raw.toLowerCase()) || raw || null;
}

// The provider behind a Cognito username: federated ones are "<provider>_<id>"; anything else (the
// email an account signed up with) is an email-and-password account.
export function providerFromUsername(username) {
  const known = normalizeProvider(String(username || '').split('_')[0]);
  return KNOWN_PROVIDERS.includes(known) && known !== EMAIL_PROVIDER ? known : EMAIL_PROVIDER;
}

// Whether the email Cognito reports for this sign-in proves the person owns that mailbox: Google
// only issues an identity to the mailbox owner, and email-and-password accounts confirm theirs with
// an emailed code. GitHub passes through whatever email the GitHub account lists.
export function emailTrusted(provider, emailVerified) {
  const normalized = normalizeProvider(provider);
  if (normalized === SUPER_ADMIN_PROVIDER) return true;
  return normalized === EMAIL_PROVIDER && String(emailVerified) === 'true';
}

export function roleFor(profile, superAdminEmail) {
  const email = String(profile?.email || '').toLowerCase();
  if (normalizeProvider(profile?.provider) === SUPER_ADMIN_PROVIDER && email && email === String(superAdminEmail).toLowerCase()) {
    return 'superadmin';
  }
  return profile?.role === 'admin' ? 'admin' : 'user';
}

export const isStaff = (role) => role === 'admin' || role === 'superadmin';

// Who manages whom: admins manage regular users; only the super admin manages admins; nobody
// manages the super admin through the admin API.
export function canManage(actorRole, targetRole) {
  if (targetRole === 'user') return isStaff(actorRole);
  if (targetRole === 'admin') return actorRole === 'superadmin';
  return false;
}

// Returns [statusCode, message] when `actorRole` may not give `target` the role `newRole`, else null.
// Admins can see every account; only the super admin grants or removes admin.
export function roleChangeError(actorRole, targetRole, newRole) {
  if (actorRole !== 'superadmin') return [403, 'Only the super admin can change roles.'];
  if (!ASSIGNABLE_ROLES.includes(newRole)) return [400, 'Role must be "admin" or "user".'];
  if (targetRole === 'superadmin') return [400, "The super admin's role can't be changed."];
  return null;
}

// Returns [statusCode, message] when `actorRole` may not apply `changes` ({ role?, disabled? }) to an
// account whose role is `targetRole`, else null.
export function userUpdateError(actorRole, targetRole, changes) {
  if (!isStaff(actorRole)) return [403, 'Admins only.'];
  const keys = Object.keys(changes || {});
  if (!keys.length) return [400, 'Nothing to change.'];
  const unknown = keys.find((key) => !['role', 'disabled'].includes(key));
  if (unknown) return [400, `Unknown field "${unknown}".`];
  if (targetRole === 'superadmin') return [400, "The super admin's account can't be changed here."];
  if (!canManage(actorRole, targetRole)) return [403, 'Only the super admin can manage admins.'];
  if ('role' in changes) {
    const refused = roleChangeError(actorRole, targetRole, changes.role);
    if (refused) return refused;
  }
  if ('disabled' in changes && typeof changes.disabled !== 'boolean') return [400, '"disabled" must be true or false.'];
  return null;
}

// The account shape returned to the browser.
export function publicProfile(profile, superAdminEmail) {
  return {
    userId: profile.userId,
    email: profile.email ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    provider: normalizeProvider(profile.provider),
    role: roleFor(profile, superAdminEmail),
    createdAt: profile.createdAt ?? null,
    lastLoginAt: profile.lastLoginAt ?? null,
  };
}
