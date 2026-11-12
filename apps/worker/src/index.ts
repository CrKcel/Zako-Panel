import { Hono } from 'hono';
import type { Env } from './env';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestContext } from './middleware/request-context';
import { requestLogging } from './middleware/request-logging';
import { adminRoutes } from './routes/admin';
import { agentRoutes } from './routes/agent';
import { subscriptionRoutes } from './routes/subscription';
import { runScheduledJob } from './services/cron-service';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', requestContext);
app.use('*', requestLogging);
app.onError(errorHandler);
app.notFound(notFoundHandler);

app.route('/api/v1/admin', adminRoutes);
app.route('/api/v1/agent', agentRoutes);
app.route('/sub', subscriptionRoutes);

const worker = {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
	scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runScheduledJob(env, controller.cron, controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

export default worker;
