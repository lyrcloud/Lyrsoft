import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, cleanColumns, cleanGroups, cleanValues, defaultBoard, effectiveRole, memberChangeError } from './model.mjs';

test('staff reach every workspace; others need a membership', () => {
  assert.equal(effectiveRole('superadmin', null), 'owner');
  assert.equal(effectiveRole('superadmin', 'member'), 'owner');
  assert.equal(effectiveRole('admin', null), 'admin');
  assert.equal(effectiveRole('admin', 'owner'), 'owner');
  assert.equal(effectiveRole('user', 'member'), 'member');
  assert.equal(effectiveRole('user', null), null);
});

test('abilities follow role rank', () => {
  assert.equal(can('member', 'editBoards'), true);
  assert.equal(can('member', 'manageMembers'), false);
  assert.equal(can('admin', 'manageMembers'), true);
  assert.equal(can('admin', 'deleteWorkspace'), false);
  assert.equal(can('owner', 'deleteWorkspace'), true);
  assert.equal(can(null, 'view'), false);
});

test('member changes', () => {
  const base = { actorEmail: 'a@x.com', targetEmail: 'b@x.com' };
  assert.equal(memberChangeError({ ...base, actorRole: 'member', targetRole: 'member', newRole: 'admin' })?.[0], 403);
  assert.equal(memberChangeError({ ...base, actorRole: 'admin', targetRole: 'member', newRole: 'admin' }), null);
  assert.equal(memberChangeError({ ...base, actorRole: 'admin', targetRole: 'admin', newRole: null })?.[0], 403);
  assert.equal(memberChangeError({ ...base, actorRole: 'owner', targetRole: 'admin', newRole: null }), null);
  assert.equal(memberChangeError({ ...base, actorRole: 'owner', targetRole: 'owner', newRole: 'member' })?.[0], 400);
  assert.equal(memberChangeError({ ...base, actorRole: 'owner', targetRole: 'member', newRole: 'owner' })?.[0], 400);
  // Leaving: anyone except the owner may remove themselves.
  assert.equal(memberChangeError({ actorEmail: 'b@x.com', targetEmail: 'b@x.com', actorRole: 'member', targetRole: 'member', newRole: null }), null);
  assert.equal(memberChangeError({ actorEmail: 'b@x.com', targetEmail: 'b@x.com', actorRole: 'owner', targetRole: 'owner', newRole: null })?.[0], 400);
});

test('default board validates against its own rules', () => {
  const board = defaultBoard('Launch');
  assert.deepEqual(cleanColumns(board.columns), board.columns);
  assert.deepEqual(cleanGroups(board.groups), board.groups);
});

test('values are checked per column type and unknown columns dropped', () => {
  const { columns } = defaultBoard('x');
  assert.deepEqual(
    cleanValues({ status: 'done', owner: 'Sam@Example.com', due: '2026-10-20', notes: ' hi ', bogus: 1 }, columns),
    { status: 'done', owner: 'sam@example.com', due: '2026-10-20', notes: 'hi' },
  );
  assert.deepEqual(cleanValues({ status: '', due: null }, columns), { status: null, due: null });
  assert.throws(() => cleanValues({ status: 'nope' }, columns), /Unknown status/);
  assert.throws(() => cleanValues({ owner: 'not-an-email' }, columns), /email/);
  assert.throws(() => cleanValues({ due: '20/10/2026' }, columns), /date/);
  assert.deepEqual(cleanValues({ n: '4.5' }, [{ id: 'n', title: 'N', type: 'number' }]), { n: 4.5 });
});

test('columns reject duplicates and bad types', () => {
  assert.throws(() => cleanColumns([{ id: 'a', title: 'A', type: 'text' }, { id: 'a', title: 'B', type: 'text' }]), /unique/);
  assert.throws(() => cleanColumns([{ id: 'a', title: 'A', type: 'formula' }]), /Unknown column type/);
  assert.throws(() => cleanColumns([{ id: 'a', title: 'A', type: 'status', labels: [] }]), /labels/);
});
