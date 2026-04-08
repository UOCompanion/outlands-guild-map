/**
 * Map Manager - Cloudflare Worker Entry Point
 *
 * Main worker script that handles API requests, authentication, and serves static assets.
 * Uses @cloudflare/kv-asset-handler for reliable static file serving.
 * Protected by Discord OAuth — only users satisfying DISCORD_AUTH_RULES can access.
 */

import { getAssetFromKV, NotFoundError, MethodNotAllowedError } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
import {
    handleGetLocations,
    handleCreateLocation,
    handleUpdateLocation,
    handleDeleteLocation,
    handleExportLocations,
    handleImportLocations,
    handleGetPublicLocations
} from './api/locations.js';
import {
    handleGetConfig,
    handleUpdateConfig
} from './api/config.js';
import {
    handleGetAllianceInfo,
    handleCreateAlliance,
    handleJoinAlliance,
    handleCreateAllianceInvite,
    handleLeaveAlliance
} from './api/alliance.js';
import {
    handleLogin,
    handleCallback,
    handleLogout,
    handleMe
} from './api/auth.js';
import {
    requireAuth,
    unauthorizedResponse,
    redirectToLogin
} from './middleware/auth.js';

// Parse the asset manifest
const assetManifest = JSON.parse(manifestJSON);

// CORS headers for API responses
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
};

// Public routes that don't require authentication
const PUBLIC_PATHS = [
    '/auth/login',
    '/auth/callback',
    '/auth/logout',
    '/login.html',
    '/unauthorized.html'
];

// Static asset extensions that don't require auth
const PUBLIC_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.webp'];

/**
 * Check if a path is public (doesn't require authentication)
 * @param {string} path - Request path
 * @returns {boolean} True if path is public
 */
function isPublicPath(path) {
    if (PUBLIC_PATHS.includes(path)) {
        return true;
    }

    const extension = path.substring(path.lastIndexOf('.'));
    if (PUBLIC_EXTENSIONS.includes(extension.toLowerCase())) {
        return true;
    }

    return false;
}

/**
 * Main request handler for the Cloudflare Worker
 * Handles /auth/* routes, /api/* routes with auth, and delegates static files to KV asset handler
 */
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // Handle CORS preflight requests
        if (method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        // Handle authentication routes (public)
        if (path.startsWith('/auth/')) {
            return handleAuthRequest(request, env, path);
        }

        // Public federation endpoint — bearer token auth, no Discord session required
        if (path === '/api/public/locations' && method === 'GET') {
            const resp = await handleGetPublicLocations(request, env);
            const newHeaders = new Headers(resp.headers);
            Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
            return new Response(resp.body, { status: resp.status, headers: newHeaders });
        }

        // Check if this is a public path
        if (isPublicPath(path)) {
            return handleStaticAssets(request, env, ctx);
        }

        // For all other routes, require authentication
        const user = await requireAuth(request, env);

        if (!user) {
            // For API requests, return 401 JSON
            if (path.startsWith('/api/')) {
                return unauthorizedResponse();
            }
            // For page requests, redirect to login
            return redirectToLogin(request);
        }

        // User is authenticated - handle the request
        if (path.startsWith('/api/')) {
            return handleApiRequest(request, env, path, method, user);
        }

        // Serve static assets for authenticated users
        return handleStaticAssets(request, env, ctx);
    }
};

/**
 * Handle authentication routes
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment
 * @param {string} path - Request path
 * @returns {Response} Response from auth handler
 */
async function handleAuthRequest(request, env, path) {
    try {
        switch (path) {
            case '/auth/login':
                return handleLogin(request, env);
            case '/auth/callback':
                return handleCallback(request, env);
            case '/auth/logout':
                return handleLogout(request, env);
            case '/auth/me':
                return handleMe(request, env);
            default:
                return new Response('Not Found', { status: 404 });
        }
    } catch (error) {
        console.error('Auth error:', error);
        return new Response('Authentication error: ' + error.message, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

/**
 * Return a 403 Forbidden response for viewer attempts to write
 * @returns {Response}
 */
function editorOnlyResponse() {
    return new Response(JSON.stringify({
        error: 'Forbidden',
        message: 'You have view-only access and cannot make changes'
    }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Handle API requests (user is already authenticated)
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment
 * @param {string} path - Request path
 * @param {string} method - HTTP method
 * @param {Object} user - Authenticated user object (has .permission: 'editor'|'viewer')
 * @returns {Response} API response
 */
async function handleApiRequest(request, env, path, method, user) {
    const isEditor = user.permission === 'editor';

    try {
        let response;

        // GET /api/config - Fetch guild config (layers)
        if (path === '/api/config' && method === 'GET') {
            response = await handleGetConfig(request, env);
        }
        // PUT /api/config - Update guild config (layers) — editors only
        else if (path === '/api/config' && method === 'PUT') {
            response = isEditor ? await handleUpdateConfig(request, env) : editorOnlyResponse();
        }
        // GET /api/locations/export - Export CSV (must be before /api/locations/:id)
        else if (path === '/api/locations/export' && method === 'GET') {
            response = await handleExportLocations(request, env);
        }
        // POST /api/locations/import - Bulk import from CSV — editors only
        else if (path === '/api/locations/import' && method === 'POST') {
            response = isEditor ? await handleImportLocations(request, env) : editorOnlyResponse();
        }
        // GET /api/locations - Fetch all locations
        else if (path === '/api/locations' && method === 'GET') {
            response = await handleGetLocations(request, env);
        }
        // POST /api/locations - Create new location — editors only
        else if (path === '/api/locations' && method === 'POST') {
            response = isEditor ? await handleCreateLocation(request, env) : editorOnlyResponse();
        }
        // PUT /api/locations/:id - Update location — editors only
        else if (path.match(/^\/api\/locations\/[^/]+$/) && method === 'PUT') {
            const id = path.split('/').pop();
            response = isEditor ? await handleUpdateLocation(request, env, id) : editorOnlyResponse();
        }
        // DELETE /api/locations/:id - Delete location — editors only
        else if (path.match(/^\/api\/locations\/[^/]+$/) && method === 'DELETE') {
            const id = path.split('/').pop();
            response = isEditor ? await handleDeleteLocation(request, env, id) : editorOnlyResponse();
        }
        // Alliance management — proxied to hub (editors only for writes)
        else if (path === '/api/alliance/info' && method === 'GET') {
            response = await handleGetAllianceInfo(request, env);
        }
        else if (path === '/api/alliance/create' && method === 'POST') {
            response = isEditor ? await handleCreateAlliance(request, env) : editorOnlyResponse();
        }
        else if (path === '/api/alliance/join' && method === 'POST') {
            response = isEditor ? await handleJoinAlliance(request, env) : editorOnlyResponse();
        }
        else if (path === '/api/alliance/invite' && method === 'POST') {
            response = isEditor ? await handleCreateAllianceInvite(request, env) : editorOnlyResponse();
        }
        else if (path === '/api/alliance/leave' && method === 'DELETE') {
            response = isEditor ? await handleLeaveAlliance(request, env) : editorOnlyResponse();
        }
        // Unknown API endpoint
        else {
            response = new Response(JSON.stringify({
                error: 'Not Found',
                message: `Unknown API endpoint: ${method} ${path}`
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Add CORS headers to API response
        const newHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => {
            newHeaders.set(key, value);
        });

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });

    } catch (error) {
        console.error('API error:', error);
        return new Response(JSON.stringify({
            error: 'Internal Server Error',
            message: error.message
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });
    }
}

/**
 * Handle static asset requests using KV asset handler
 */
// Tiles change only when regenerated and redeployed — cache aggressively.
// Everything else uses kv-asset-handler defaults (2h edge TTL, no browser TTL).
function cacheControl(req) {
    if (new URL(req.url).pathname.startsWith('/tiles/')) {
        return { edgeTTL: 30 * 24 * 60 * 60, browserTTL: 30 * 24 * 60 * 60 };
    }
    return {};
}

async function handleStaticAssets(request, env, ctx) {
    try {
        return await getAssetFromKV(
            {
                request,
                waitUntil: ctx.waitUntil.bind(ctx)
            },
            {
                ASSET_NAMESPACE: env.__STATIC_CONTENT,
                ASSET_MANIFEST: assetManifest,
                cacheControl
            }
        );

    } catch (e) {
        if (e instanceof NotFoundError) {
            // Try serving index.html for SPA routing
            try {
                const indexRequest = new Request(
                    new URL('/index.html', request.url).toString(),
                    request
                );

                return await getAssetFromKV(
                    {
                        request: indexRequest,
                        waitUntil: ctx.waitUntil.bind(ctx)
                    },
                    {
                        ASSET_NAMESPACE: env.__STATIC_CONTENT,
                        ASSET_MANIFEST: assetManifest
                    }
                );
            } catch (indexError) {
                return new Response('Not Found', { status: 404 });
            }
        } else if (e instanceof MethodNotAllowedError) {
            return new Response('Method Not Allowed', { status: 405 });
        }

        console.error('Asset error:', e);
        return new Response('Error serving asset: ' + e.message, { status: 500 });
    }
}
