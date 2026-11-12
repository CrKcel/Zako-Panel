import { Hono } from 'hono';
import { accessAuth } from '../../middleware/access';
import type { AppEnv } from '../../types';
import { adminUserRoutes } from './admins';
import { configRoutes } from './configs';
import { nodeRoutes } from './nodes';
import { profileRoutes } from './profiles';
import { subscriberRoutes } from './subscribers';
import { subscriptionRoutes } from './subscriptions';
import { trafficRoutes } from './traffic';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', accessAuth);
adminRoutes.route('/nodes', nodeRoutes);
adminRoutes.route('/nodes', configRoutes);
adminRoutes.route('/profiles', profileRoutes);
adminRoutes.route('/subscriptions', subscriptionRoutes);
adminRoutes.route('/subscribers', subscriberRoutes);
adminRoutes.route('/admins', adminUserRoutes);
adminRoutes.route('/traffic', trafficRoutes);
