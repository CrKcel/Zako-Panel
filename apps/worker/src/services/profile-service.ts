import type { CreateProfileRequest, Profile, ProfileDetail, UpdateProfileRequest } from '@zako/contracts';
import { notImplemented } from '../lib/errors';
import type { Paginated } from '../types';
import type { ListQuery } from './node-service';

export async function listProfiles(_db: D1Database, _query: ListQuery): Promise<Paginated<Profile>> {
	throw notImplemented('profile listing');
}

export async function createProfile(_db: D1Database, _input: CreateProfileRequest): Promise<ProfileDetail> {
	throw notImplemented('profile creation');
}

export async function getProfile(_db: D1Database, _profileId: string): Promise<ProfileDetail> {
	throw notImplemented('profile lookup');
}

export async function updateProfile(_db: D1Database, _profileId: string, _input: UpdateProfileRequest): Promise<ProfileDetail> {
	throw notImplemented('profile update');
}

export async function deleteProfile(_db: D1Database, _profileId: string): Promise<void> {
	throw notImplemented('profile deletion');
}
