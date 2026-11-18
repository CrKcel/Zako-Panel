import type { CreateProfileRequest, Profile, ProfileDetail, ProxyGroup, UpdateProfileRequest } from '@zako/contracts';
import { isUniqueConstraintError, isForeignKeyConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { findNodesByIds } from '../repositories/nodes';
import {
	deleteProfileRow,
	findProfileById,
	findProfileByName,
	insertProfileStatement,
	listProfileNodeIds,
	listProfileRows,
	replaceProfileNodesStatements,
	updateProfile as updateProfileRow,
	type ProfileRow,
} from '../repositories/profiles';
import type { ListQuery, Paginated } from '../types';
import { toProfile, toProfileDetail } from './profile-mapping';

const MAX_RULES = 200;
const MAX_RULE_LENGTH = 512;
const MAX_GROUPS = 50;

function profileNotFound(): AppError {
	return new AppError('NOT_FOUND', 'Profile not found', 404);
}

/**
 * Rules are stored as structured strings and later interpolated into YAML, so
 * each entry must be non-empty and bounded in size.
 */
function validateRules(rules: string[]): void {
	if (rules.length > MAX_RULES) {
		throw new AppError('VALIDATION_ERROR', `At most ${MAX_RULES} rules are allowed`, 400);
	}
	for (const rule of rules) {
		const trimmed = rule.trim();
		if (trimmed === '') throw new AppError('VALIDATION_ERROR', 'Rules must not be empty', 400);
		if (trimmed.length > MAX_RULE_LENGTH) {
			throw new AppError('VALIDATION_ERROR', `A rule exceeds ${MAX_RULE_LENGTH} characters`, 400);
		}
	}
}

function validateProxyGroups(groups: ProxyGroup[]): void {
	if (groups.length > MAX_GROUPS) {
		throw new AppError('VALIDATION_ERROR', `At most ${MAX_GROUPS} proxy groups are allowed`, 400);
	}
	const names = new Set<string>();
	for (const group of groups) {
		const name = group.name.trim();
		if (names.has(name)) {
			throw new AppError('VALIDATION_ERROR', `Duplicate proxy group name: ${name}`, 400);
		}
		names.add(name);
	}
}

async function assertNodesExist(db: D1Database, nodeIds: string[]): Promise<void> {
	if (nodeIds.length === 0) return;
	const unique = [...new Set(nodeIds)];
	const rows = await findNodesByIds(db, unique);
	if (rows.length !== unique.length) {
		const found = new Set(rows.map((row) => row.id));
		const missing = unique.filter((nodeId) => !found.has(nodeId));
		throw new AppError('VALIDATION_ERROR', `Unknown node ids: ${missing.join(', ')}`, 400);
	}
}

export async function listProfiles(db: D1Database, query: ListQuery): Promise<Paginated<Profile>> {
	const rows = await listProfileRows(db, query.limit + 1, query.cursor);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const items = pageRows.map(toProfile);
	const last = items[items.length - 1];
	return { items, next_cursor: hasMore && last ? last.id : null };
}

export async function createProfile(db: D1Database, input: CreateProfileRequest): Promise<ProfileDetail> {
	const rules = input.rules ?? [];
	const proxyGroups = input.proxy_groups ?? [];
	const nodeIds = [...new Set(input.node_ids ?? [])];
	validateRules(rules);
	validateProxyGroups(proxyGroups);
	await assertNodesExist(db, nodeIds);

	const now = nowSeconds();
	const profileId = newId();
	try {
		await db.batch([
			insertProfileStatement(db, {
				id: profileId,
				name: input.name,
				description: input.description ?? null,
				node_selection: input.node_selection ?? 'all',
				online_only: input.online_only ?? true,
				clash_base_json: JSON.stringify(input.clash_base ?? {}),
				proxy_groups_json: JSON.stringify(proxyGroups),
				rules_json: JSON.stringify(rules),
				now,
			}),
			...replaceProfileNodesStatements(db, profileId, nodeIds),
		]);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Profile name already exists', 409);
		}
		throw error;
	}

	const row = await findProfileById(db, profileId);
	if (!row) throw new AppError('INTERNAL_ERROR', 'Profile was not persisted', 500);
	return toProfileDetail(row, nodeIds);
}

export async function getProfile(db: D1Database, profileId: string): Promise<ProfileDetail> {
	const row = await findProfileById(db, profileId);
	if (!row) throw profileNotFound();
	const nodeIds = await listProfileNodeIds(db, profileId);
	return toProfileDetail(row, nodeIds);
}

export async function updateProfile(db: D1Database, profileId: string, input: UpdateProfileRequest): Promise<ProfileDetail> {
	const existing = await findProfileById(db, profileId);
	if (!existing) throw profileNotFound();

	if (input.name !== undefined) {
		const clash = await findProfileByName(db, input.name);
		if (clash && clash.id !== profileId) {
			throw new AppError('CONFLICT', 'Profile name already exists', 409);
		}
	}
	if (input.rules !== undefined) validateRules(input.rules);
	if (input.proxy_groups !== undefined) validateProxyGroups(input.proxy_groups);
	const nodeIds = input.node_ids === undefined ? undefined : [...new Set(input.node_ids)];
	if (nodeIds !== undefined) await assertNodesExist(db, nodeIds);

	try {
		await updateProfileRow(
			db,
			profileId,
			{
				name: input.name,
				description: input.description,
				node_selection: input.node_selection,
				online_only: input.online_only,
				clash_base_json: input.clash_base === undefined ? undefined : JSON.stringify(input.clash_base),
				proxy_groups_json: input.proxy_groups === undefined ? undefined : JSON.stringify(input.proxy_groups),
				rules_json: input.rules === undefined ? undefined : JSON.stringify(input.rules),
			},
			nowSeconds(),
		);
		if (nodeIds !== undefined) {
			await db.batch(replaceProfileNodesStatements(db, profileId, nodeIds));
		}
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Profile name already exists', 409);
		}
		throw error;
	}

	const updated = await findProfileById(db, profileId);
	if (!updated) throw profileNotFound();
	return toProfileDetail(updated, nodeIds ?? (await listProfileNodeIds(db, profileId)));
}

export async function deleteProfile(db: D1Database, profileId: string): Promise<void> {
	const existing = await findProfileById(db, profileId);
	if (!existing) throw profileNotFound();
	try {
		await deleteProfileRow(db, profileId);
	} catch (error) {
		if (isForeignKeyConstraintError(error)) {
			throw new AppError('CONFLICT', 'Profile is referenced by a subscription', 409);
		}
		throw error;
	}
}
