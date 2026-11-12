import type { AdminUser, CreateAdminRequest, UpdateAdminRequest } from '@zako/contracts';
import { notImplemented } from '../lib/errors';
import type { Paginated } from '../types';
import type { ListQuery } from './node-service';

export async function listAdmins(_db: D1Database, _query: ListQuery): Promise<Paginated<AdminUser>> {
	throw notImplemented('administrator listing');
}

export async function createAdmin(_db: D1Database, _input: CreateAdminRequest): Promise<AdminUser> {
	throw notImplemented('administrator creation');
}

export async function updateAdmin(_db: D1Database, _adminId: string, _input: UpdateAdminRequest): Promise<AdminUser> {
	throw notImplemented('administrator update');
}
