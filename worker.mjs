import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import runtime from './lib/runtime-env.js';

runtime.configureRuntimeBindings(env);
const { default: app } = await import('./server.js');
app.listen(3000);

export default httpServerHandler({ port: 3000 });
