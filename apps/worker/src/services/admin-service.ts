import type { AdminUser, CreateAdminRequest, UpdateAdminRequest } from '@zako/contracts';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import {
	countOtherEnabledOwners,
	findAdminById,
	findAdminByEmail,
	insertAdminStatement,
	listAdminRows,
	updateAdminStatement,
	type AdminRow,
} from '../repositories/admins';
import type { Paginated } from '../types';
import type { ListQuery } from './node-service';

function adminNotFound(): AppError {
	return new AppError('NOT_FOUND', 'Administrator not found', 404);
}

function isUniqueConstraintError(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function toAdminUser(row: AdminRow): AdminUser {
	return {
		id: row.id,
		email: row.email,
		role: row.role,
		enabled: row.enabled === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export async function listAdmins(db: D1Database, query: ListQuery): Promise<Paginated<AdminUser>> {
	const rows = await listAdminRows(db, query.limit + 1, query.cursor);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const items = pageRows.map(toAdminUser);
	const last = items[items.length - 1];
	return { items, next_cursor: hasMore && last ? last.id : null };
}

export async function createAdmin(db: D1Database, input: CreateAdminRequest): Promise<AdminUser> {
	const existing = await findAdminByEmail(db, input.email);
	if (existing) throw new AppError('CONFLICT', 'Administrator email already exists', 409);

	const adminId = newId();
	try {
		await insertAdminStatement(db, { id: adminId, email: input.email.trim().toLowerCase(), role: input.role, now: nowSeconds() }).run();
	} catch (error) {
		if (isUniqueConstraintError(error)) throw new AppError('CONFLICT', 'Administrator email already exists', 409);
		throw error;
	}

	const row = await findAdminById(db, adminId);
	if (!row) throw new AppError('INTERNAL_ERROR', 'Administrator was not persisted', 500);
	return toAdminUser(row);
}

/**
 * The last enabled owner cannot be demoted or disabled: doing so would leave the
 * panel without an identity that may manage administrators, and Access alone
 * cannot restore the role.
 */
export async function updateAdmin(db: D1Database, adminId: string, input: UpdateAdminRequest): Promise<AdminUser> {
	const existing = await findAdminById(db, adminId);
	if (!existing) throw adminNotFound();

	const nextRole = input.role ?? existing.role;
	const nextEnabled = input.enabled ?? existing.enabled === 1;
	const removesLastOwner = existing.role === 'owner' && existing.enabled === 1 && (nextRole !== 'owner' || !nextEnabled);
	if (removesLastOwner && (await countOtherEnabledOwners(db, adminId)) === 0) {
		throw new AppError('CONFLICT', 'At least one enabled owner is required', 409);
	}

	await updateAdminStatement(db, adminId, { role: input.role, enabled: input.enabled }, nowSeconds()).run();
	const updated = await findAdminById(db, adminId);
	if (!updated) throw adminNotFound();
	return toAdminUser(updated);
}
