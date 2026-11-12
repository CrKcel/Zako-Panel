import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createProfile, deleteProfile, getProfile, listProfiles, updateProfile } from '../src/services/profile-service';
import { seedNode, seedProfile, seedSubscriber, seedSubscription, testToken } from './helpers';

const nodeIdA = '01J2Z6Q8Y3V9M4K7T1B5C0D2E1';
const nodeIdB = '01J2Z6Q8Y3V9M4K7T1B5C0D2E2';

describe('profile management', () => {
	it('creates and reads profiles with selected nodes', async () => {
		await seedNode({ id: nodeIdA, name: 'A' });
		await seedNode({ id: nodeIdB, name: 'B' });

		const created = await createProfile(env.DB, {
			name: 'Main',
			node_selection: 'selected',
			online_only: true,
			node_ids: [nodeIdA, nodeIdB, nodeIdA],
		});
		expect(created.node_ids.sort()).toEqual([nodeIdA, nodeIdB]);
		expect(created.revision).toBe(1);
		expect(created.online_only).toBe(true);

		const fetched = await getProfile(env.DB, created.id);
		expect(fetched).toEqual(created);
	});

	it('bumps the revision when rules or node selection change', async () => {
		await seedNode({ id: nodeIdA, name: 'A' });
		const created = await createProfile(env.DB, {
			name: 'Main',
			node_selection: 'selected',
			online_only: true,
			node_ids: [nodeIdA],
		});

		const updated = await updateProfile(env.DB, created.id, {
			rules: ['DOMAIN-SUFFIX,example.com,PROXY', 'MATCH,PROXY'],
			node_ids: [],
			online_only: false,
		});
		expect(updated.revision).toBe(2);
		expect(updated.rules).toHaveLength(2);
		expect(updated.node_ids).toEqual([]);
		expect(updated.online_only).toBe(false);
	});

	it('lists profiles by ascending id with a cursor', async () => {
		const first = await seedProfile({ id: '01J2Z6Q8Y3V9M4K7T1B5C0D2F1', name: 'first' });
		const second = await seedProfile({ id: '01J2Z6Q8Y3V9M4K7T1B5C0D2F2', name: 'second' });
		const page = await listProfiles(env.DB, { limit: 1 });
		expect(page.items.map((profile) => profile.id)).toEqual([first]);
		expect(page.next_cursor).toBe(first);
		const rest = await listProfiles(env.DB, { limit: 1, cursor: page.next_cursor ?? undefined });
		expect(rest.items.map((profile) => profile.id)).toEqual([second]);
	});

	it('rejects duplicate group names, empty rules and unknown nodes', async () => {
		await expect(
			createProfile(env.DB, {
				name: 'Bad groups',
				node_selection: 'all',
				online_only: true,
				proxy_groups: [
					{ name: 'PROXY', type: 'select' },
					{ name: 'PROXY', type: 'select' },
				],
			}),
		).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

		await expect(
			createProfile(env.DB, { name: 'Bad rules', node_selection: 'all', online_only: true, rules: ['MATCH,PROXY', '  '] }),
		).rejects.toMatchObject({
			code: 'VALIDATION_ERROR',
			status: 400,
		});

		await expect(
			createProfile(env.DB, {
				name: 'Bad nodes',
				node_selection: 'selected',
				online_only: true,
				node_ids: [nodeIdA],
			}),
		).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
	});

	it('rejects a duplicate profile name and a profile still used by a subscription', async () => {
		const base = { node_selection: 'all' as const, online_only: true };
		await createProfile(env.DB, { ...base, name: 'Unique' });
		await expect(createProfile(env.DB, { ...base, name: 'Unique' })).rejects.toMatchObject({ status: 409 });

		const subscriberId = await seedSubscriber();
		const profileId = await seedProfile({ name: 'InUse' });
		await seedSubscription({ token: testToken('inuse'), subscriberId, profileId });
		await expect(deleteProfile(env.DB, profileId)).rejects.toMatchObject({ status: 409 });

		const removable = await seedProfile({ name: 'Removable' });
		await deleteProfile(env.DB, removable);
		await expect(getProfile(env.DB, removable)).rejects.toMatchObject({ status: 404 });
	});
});
