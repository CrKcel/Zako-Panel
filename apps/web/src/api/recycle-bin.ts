import type { RecycleBinCounts, RecycleBinItemType, RecycleBinList, RecycleBinRestoreResult } from '@zako/contracts';
import { apiRequest } from './client';

export const recycleBinApi = {
	list(type?: RecycleBinItemType): Promise<RecycleBinList> {
		return apiRequest<RecycleBinList>('/api/v1/admin/recycle-bin', {
			query: type ? { type } : undefined,
		});
	},
	restore(itemType: RecycleBinItemType, itemId: string): Promise<RecycleBinRestoreResult> {
		return apiRequest<RecycleBinRestoreResult>(`/api/v1/admin/recycle-bin/${itemType}/${itemId}/restore`, {
			method: 'POST',
		});
	},
	purge(itemType: RecycleBinItemType, itemId: string): Promise<void> {
		return apiRequest<void>(`/api/v1/admin/recycle-bin/${itemType}/${itemId}`, {
			method: 'DELETE',
		});
	},
	empty(type?: RecycleBinItemType): Promise<{ deleted: RecycleBinCounts }> {
		return apiRequest<{ deleted: RecycleBinCounts }>('/api/v1/admin/recycle-bin', {
			method: 'DELETE',
			query: type ? { type } : undefined,
		});
	},
};
