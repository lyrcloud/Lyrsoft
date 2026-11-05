import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicProfile, roleChangeError, roleFor } from './roles.mjs';

const SUPER = 'lyrclouds@gmail.com';

test('super admin needs the configured email and a Google sign-in', () => {
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'LyrClouds@gmail.com' }, SUPER), 'superadmin');
  assert.equal(roleFor({ provider: 'GitHubBridge', email: SUPER }, SUPER), 'user');
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: null }, SUPER), 'user');
});

test('stored roles: only "admin" is honoured, superadmin is never read from storage', () => {
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'a@b.com', role: 'admin' }, SUPER), 'admin');
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'a@b.com', role: 'superadmin' }, SUPER), 'user');
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'a@b.com' }, SUPER), 'user');
});

test('only the super admin changes roles, and never their own', () => {
  assert.deepEqual(roleChangeError('admin', 'user', 'admin')?.[0], 403);
  assert.deepEqual(roleChangeError('user', 'user', 'admin')?.[0], 403);
  assert.deepEqual(roleChangeError('superadmin', 'user', 'superadmin')?.[0], 400);
  assert.deepEqual(roleChangeError('superadmin', 'superadmin', 'user')?.[0], 400);
  assert.equal(roleChangeError('superadmin', 'user', 'admin'), null);
  assert.equal(roleChangeError('superadmin', 'admin', 'user'), null);
});

test('publicProfile reports the derived role', () => {
  const profile = publicProfile({ userId: 'u1', provider: 'GoogleOIDC', email: SUPER, role: 'user' }, SUPER);
  assert.equal(profile.role, 'superadmin');
  assert.equal(profile.userId, 'u1');
});

test('provider names match in any case, and email accounts are recognised', async () => {
  const { normalizeProvider, providerFromUsername, emailTrusted } = await import('./roles.mjs');
  assert.equal(normalizeProvider('googleoidc'), 'GoogleOIDC');
  assert.equal(providerFromUsername('googleoidc_1089'), 'GoogleOIDC');
  assert.equal(providerFromUsername('GitHubBridge_github:1'), 'GitHubBridge');
  assert.equal(providerFromUsername('ada@example.com'), 'Cognito');
  assert.equal(roleFor({ provider: 'googleoidc', email: SUPER }, SUPER), 'superadmin');
  assert.equal(emailTrusted('GoogleOIDC', 'false'), true);
  assert.equal(emailTrusted('Cognito', 'true'), true);
  assert.equal(emailTrusted('Cognito', 'false'), false);
  assert.equal(emailTrusted('GitHubBridge', 'true'), false);
});

test('admins manage users; only the super admin manages admins', async () => {
  const { userUpdateError } = await import('./roles.mjs');
  assert.equal(userUpdateError('admin', 'user', { disabled: true }), null);
  assert.equal(userUpdateError('admin', 'user', { role: 'admin' })?.[0], 403);
  assert.equal(userUpdateError('admin', 'admin', { disabled: true })?.[0], 403);
  assert.equal(userUpdateError('superadmin', 'admin', { role: 'user' }), null);
  assert.equal(userUpdateError('superadmin', 'superadmin', { disabled: true })?.[0], 400);
  assert.equal(userUpdateError('superadmin', 'user', { plan: 'x' })?.[0], 400);
  assert.equal(userUpdateError('user', 'user', { disabled: true })?.[0], 403);
});
