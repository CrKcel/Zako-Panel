import { Hono } from 'hono';
import { agentAuth } from '../../middleware/agent-auth';
import type { AppEnv } from '../../types';
import { configRoutes } from './config';
import { enrollRoutes } from './enroll';
import { reportRoutes } from './report';
import { uninstallRoutes } from './uninstall';
import { updateRoutes } from './update';
import { usersRoutes } from './users';

export const agentRoutes = new Hono<AppEnv>();

// Enrollment authenticates with a one-time enrollment token rather than a node agent token.
agentRoutes.route('/enroll', enrollRoutes);

agentRoutes.use('*', agentAuth);
agentRoutes.route('/report', reportRoutes);
agentRoutes.route('/users', usersRoutes);
agentRoutes.route('/config', configRoutes);
agentRoutes.route('/update', updateRoutes);
agentRoutes.route('/uninstall', uninstallRoutes);
