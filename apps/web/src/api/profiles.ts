import type { ClashPreview, CreateProfileRequest, Profile, ProfileDetail, UpdateProfileRequest } from '@zako/contracts';
import { apiPage, apiRequest, LIST_LIMIT, type Page } from './client';

export interface ProfileListParams {
	limit?: number;
	cursor?: string;
}

export const profilesApi = {
	list(params: ProfileListParams = {}): Promise<Page<Profile>> {
		return apiPage<Profile>('/api/v1/admin/profiles', { query: { limit: LIST_LIMIT, ...params } });
	},
	create(input: CreateProfileRequest): Promise<ProfileDetail> {
		return apiRequest<ProfileDetail>('/api/v1/admin/profiles', { method: 'POST', body: input });
	},
	get(profileId: string): Promise<ProfileDetail> {
		return apiRequest<ProfileDetail>(`/api/v1/admin/profiles/${profileId}`);
	},
	update(profileId: string, input: UpdateProfileRequest): Promise<ProfileDetail> {
		return apiRequest<ProfileDetail>(`/api/v1/admin/profiles/${profileId}`, {
			method: 'PATCH',
			body: input,
		});
	},
	preview(profileId: string, subscriberId?: string): Promise<ClashPreview> {
		return apiRequest<ClashPreview>(`/api/v1/admin/profiles/${profileId}/preview`, {
			query: { subscriberId },
		});
	},
	remove(profileId: string): Promise<void> {
		return apiRequest<void>(`/api/v1/admin/profiles/${profileId}`, { method: 'DELETE' });
	},
};
