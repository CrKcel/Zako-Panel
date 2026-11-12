import { Hono } from 'hono';
import { agentAuth } from '../../middleware/agent-auth';
import type { AppEnv } from '../../types';
import { configRoutes } from './config';
import { reportRoutes } from './report';
import { usersRoutes } from './users';

export const agentRoutes = new Hono<AppEnv>();

agentRoutes.use('*', agentAuth);
agentRoutes.route('/report', reportRoutes);
agentRoutes.route('/users', usersRoutes);
agentRoutes.route('/config', configRoutes);
