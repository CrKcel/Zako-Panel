import type { AdminUser, CreateAdminRequest, UpdateAdminRequest } from '@zako/contracts';
import { apiPage, apiRequest, LIST_LIMIT, type Page } from './client';

export interface AdminListParams {
	limit?: number;
	cursor?: string;
}

export const adminsApi = {
	list(params: AdminListParams = {}): Promise<Page<AdminUser>> {
		return apiPage<AdminUser>('/api/v1/admin/admins', { query: { limit: LIST_LIMIT, ...params } });
	},
	create(input: CreateAdminRequest): Promise<AdminUser> {
		return apiRequest<AdminUser>('/api/v1/admin/admins', { method: 'POST', body: input });
	},
	update(adminId: string, input: UpdateAdminRequest): Promise<AdminUser> {
		return apiRequest<AdminUser>(`/api/v1/admin/admins/${adminId}`, { method: 'PATCH', body: input });
	},
};
