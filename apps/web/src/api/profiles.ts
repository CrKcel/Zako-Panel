import type { CreateProfileRequest, Profile, ProfileDetail, UpdateProfileRequest } from '@zako/contracts';
import { apiPage, apiRequest, type Page } from './client';

export interface ProfileListParams {
	limit?: number;
	cursor?: string;
}

export const profilesApi = {
	list(params: ProfileListParams = {}): Promise<Page<Profile>> {
		return apiPage<Profile>('/api/v1/admin/profiles', { query: { ...params } });
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
	remove(profileId: string): Promise<void> {
		return apiRequest<void>(`/api/v1/admin/profiles/${profileId}`, { method: 'DELETE' });
	},
};
