// Copied from the Lyrcloud repo (api/account/roles.mjs), which owns the account API; the work API
// uses it to recognise the super admin and Lyrcloud admins. Keep the two copies in step.
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

export function roleFor(profile, superAdminEmail) {
  const email = String(profile?.email || '').toLowerCase();
  if (profile?.provider === SUPER_ADMIN_PROVIDER && email && email === String(superAdminEmail).toLowerCase()) {
    return 'superadmin';
  }
  return profile?.role === 'admin' ? 'admin' : 'user';
}

export const isStaff = (role) => role === 'admin' || role === 'superadmin';

// Returns [statusCode, message] when `actorRole` may not give `target` the role `newRole`, else null.
// Admins can see every account; only the super admin grants or removes admin.
export function roleChangeError(actorRole, targetRole, newRole) {
  if (actorRole !== 'superadmin') return [403, 'Only the super admin can change roles.'];
  if (!ASSIGNABLE_ROLES.includes(newRole)) return [400, 'Role must be "admin" or "user".'];
  if (targetRole === 'superadmin') return [400, "The super admin's role can't be changed."];
  return null;
}

// The account shape returned to the browser.
export function publicProfile(profile, superAdminEmail) {
  return {
    userId: profile.userId,
    email: profile.email ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    provider: profile.provider ?? null,
    role: roleFor(profile, superAdminEmail),
    createdAt: profile.createdAt ?? null,
    lastLoginAt: profile.lastLoginAt ?? null,
  };
}
