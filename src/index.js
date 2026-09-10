import { handleAgent, handleApi } from './admin.js';
import { json } from './common.js';
import { handleClick, handleHealth, handleOpen } from './tracking.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health' && request.method === 'GET') {
      return handleHealth(env);
    }

    const openMatch = path.match(/^\/o\/([A-Za-z0-9_-]{8,120})\.gif$/);
    if (openMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleOpen(request, env, ctx, openMatch[1]);
    }

    const clickMatch = path.match(/^\/c\/([A-Za-z0-9_-]{8,120})\/([A-Za-z0-9_-]{1,80})$/);
    if (clickMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleClick(request, env, ctx, clickMatch[1], clickMatch[2]);
    }

    if (path.startsWith('/agent/')) {
      return handleAgent(request, env, url);
    }

    if (path.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    return json({ error: 'not_found' }, 404);
  },
};
