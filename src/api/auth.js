/**
 * Discord OAuth2 Authentication Handlers for Map Manager
 *
 * Handles Discord OAuth flow, session management, and role-based access control.
 *
 * DISCORD_AUTH_RULES is a JSON object OR array of objects:
 *   { "guild_id": "123", "editor_role_ids": ["r1"], "viewer_role_ids": ["r2"] }
 *   — or —
 *   [
 *     { "guild_id": "123", "editor_role_ids": ["r1"], "viewer_role_ids": [] },
 *     { "guild_id": "456", "editor_role_ids": ["r3"], "viewer_role_ids": [] }
 *   ]
 *
 * When multiple guilds are configured the callback tries each guild in order.
 * The highest permission found wins (editor > viewer).
 *
 * Permission resolution per guild (first match wins):
 *   1. User has any editor_role_ids role  → permission = "editor"
 *   2. viewer_role_ids is empty           → permission = "viewer" (any member)
 *   3. User has any viewer_role_ids role  → permission = "viewer"
 *   4. None of the above                  → denied for this guild
 */

// Session expiry time: 7 days in seconds
const SESSION_TTL = 7 * 24 * 60 * 60;

// Discord API endpoints
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_OAUTH_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_OAUTH_TOKEN = 'https://discord.com/api/oauth2/token';

/**
 * Parse and validate the DISCORD_AUTH_RULES env var.
 * Supports a single object or an array of objects.
 * @param {Object} env - Cloudflare environment
 * @returns {Array<{guild_id: string, editor_role_ids: string[], viewer_role_ids: string[]}>|null}
 */
function getAuthRules(env) {
    if (!env.DISCORD_AUTH_RULES) {
        console.error('DISCORD_AUTH_RULES not configured');
        return null;
    }
    try {
        const parsed = JSON.parse(env.DISCORD_AUTH_RULES);
        const rawRules = Array.isArray(parsed) ? parsed : [parsed];

        const rules = [];
        for (const rule of rawRules) {
            if (!rule.guild_id) {
                console.error('DISCORD_AUTH_RULES entry missing required guild_id field');
                continue;
            }
            rules.push({
                guild_id: rule.guild_id,
                editor_role_ids: rule.editor_role_ids || [],
                viewer_role_ids: rule.viewer_role_ids || [],
            });
        }

        return rules.length > 0 ? rules : null;
    } catch (e) {
        console.error('Failed to parse DISCORD_AUTH_RULES:', e.message);
        return null;
    }
}

/**
 * Determine a guild member's permission level based on their roles.
 * @param {Object} memberData - Discord guild member object (has .roles array of role IDs)
 * @param {{editor_role_ids: string[], viewer_role_ids: string[]}} rule - Auth rule
 * @returns {'editor'|'viewer'|null} Permission level, or null if not authorized
 */
function getPermissionLevel(memberData, rule) {
    const userRoles = memberData.roles || [];

    // Editor check first — editors always have full access
    if (rule.editor_role_ids.length > 0) {
        if (rule.editor_role_ids.some(id => userRoles.includes(id))) {
            return 'editor';
        }
    }

    // Viewer check — empty viewer_role_ids means any guild member is a viewer
    if (rule.viewer_role_ids.length === 0) {
        return 'viewer';
    }
    if (rule.viewer_role_ids.some(id => userRoles.includes(id))) {
        return 'viewer';
    }

    // No matching role — not authorized
    return null;
}

/**
 * Generate a cryptographically secure random string
 * @param {number} length - Desired byte length
 * @returns {string} Random hex string
 */
function generateSecureToken(length = 32) {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Create an HMAC signature
 * @param {string} value
 * @param {string} secret
 * @returns {Promise<string>} Hex-encoded HMAC
 */
async function createSignature(value, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify an HMAC signature (constant-time comparison)
 * @param {string} value
 * @param {string} signature
 * @param {string} secret
 * @returns {Promise<boolean>}
 */
async function verifySignature(value, signature, secret) {
    const expected = await createSignature(value, secret);
    if (expected.length !== signature.length) return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
        result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Parse cookies from the Cookie header
 * @param {string} cookieHeader
 * @returns {Object}
 */
function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(cookie => {
        const [name, ...valueParts] = cookie.trim().split('=');
        if (name) cookies[name] = valueParts.join('=');
    });
    return cookies;
}

/**
 * Build the OAuth redirect URL from the request origin
 * @param {Request} request
 * @returns {string}
 */
function getRedirectUri(request) {
    const url = new URL(request.url);
    return `${url.origin}/auth/callback`;
}

/**
 * Handle GET /auth/login
 * Redirects to Discord's OAuth authorization page
 */
export async function handleLogin(request, env) {
    const state = generateSecureToken(16);

    const params = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        redirect_uri: getRedirectUri(request),
        response_type: 'code',
        scope: 'identify guilds.members.read',
        state: state
    });

    const response = new Response(null, {
        status: 302,
        headers: { 'Location': `${DISCORD_OAUTH_AUTHORIZE}?${params.toString()}` }
    });

    const signedState = await createSignature(state, env.SESSION_SECRET);
    response.headers.append('Set-Cookie',
        `oauth_state=${state}.${signedState}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
    );

    return response;
}

/**
 * Handle GET /auth/callback
 * Exchanges the OAuth code for a token, fetches the user's guild membership,
 * determines their permission level, and creates a session.
 */
export async function handleCallback(request, env) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
        console.error('Discord OAuth error:', error);
        return new Response('Discord authentication was cancelled or failed', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    if (!code || !state) {
        return new Response('Missing code or state parameter', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    // Verify CSRF state cookie
    const cookies = parseCookies(request.headers.get('Cookie'));
    const stateCookie = cookies['oauth_state'];
    if (!stateCookie) {
        return new Response('Missing state cookie — please try logging in again', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    const [cookieState, cookieSignature] = stateCookie.split('.');
    if (cookieState !== state) {
        return new Response('State mismatch — possible CSRF attack', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    const isValidSignature = await verifySignature(cookieState, cookieSignature, env.SESSION_SECRET);
    if (!isValidSignature) {
        return new Response('Invalid state signature', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    // Exchange code for access token
    const tokenResponse = await fetch(DISCORD_OAUTH_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            client_secret: env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: getRedirectUri(request)
        })
    });

    if (!tokenResponse.ok) {
        console.error('Token exchange failed:', await tokenResponse.text());
        return new Response('Failed to exchange authorization code', {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    const { access_token: accessToken } = await tokenResponse.json();

    // Fetch Discord user info
    const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!userResponse.ok) {
        return new Response('Failed to fetch user information', {
            status: 500,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    const userData = await userResponse.json();

    // Load and validate auth rules (supports single guild or array of guilds)
    const rules = getAuthRules(env);
    if (!rules) {
        return redirectToUnauthorized(request, 'misconfigured');
    }

    // Try each guild rule — keep the highest permission found (editor > viewer)
    let bestPermission = null;
    let bestMemberData = null;

    for (const rule of rules) {
        const memberResponse = await fetch(
            `${DISCORD_API}/users/@me/guilds/${rule.guild_id}/member`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );

        if (!memberResponse.ok) continue;

        const memberData = await memberResponse.json();
        const permission = getPermissionLevel(memberData, rule);

        if (!permission) continue;

        if (permission === 'editor') {
            bestPermission = 'editor';
            bestMemberData = memberData;
            break;
        }

        if (!bestPermission) {
            bestPermission = 'viewer';
            bestMemberData = memberData;
        }
    }

    if (!bestPermission || !bestMemberData) {
        return redirectToUnauthorized(request, 'no_role');
    }

    const permission = bestPermission;

    // Create session
    const sessionId = generateSecureToken(32);
    const sessionData = {
        userId: userData.id,
        username: userData.username,
        globalName: userData.global_name || userData.username,
        avatar: userData.avatar,
        discriminator: userData.discriminator,
        roles: bestMemberData.roles,
        permission: permission,   // 'editor' or 'viewer'
        expiresAt: Date.now() + (SESSION_TTL * 1000)
    };

    if (env.MAP_SESSIONS) {
        await env.MAP_SESSIONS.put(
            `session:${sessionId}`,
            JSON.stringify(sessionData),
            { expirationTtl: SESSION_TTL }
        );
    }

    const sessionSignature = await createSignature(sessionId, env.SESSION_SECRET);
    const signedSession = `${sessionId}.${sessionSignature}`;

    const response = new Response(null, {
        status: 302,
        headers: { 'Location': '/' }
    });

    response.headers.append('Set-Cookie',
        `map_session=${signedSession}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`
    );
    response.headers.append('Set-Cookie',
        'oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    );

    return response;
}

/**
 * Redirect to the unauthorized page with a reason code
 * @param {Request} request
 * @param {string} reason - 'not_member' | 'no_role' | 'misconfigured'
 */
function redirectToUnauthorized(request, reason) {
    const url = new URL(request.url);
    return new Response(null, {
        status: 302,
        headers: { 'Location': `${url.origin}/unauthorized.html?reason=${reason}` }
    });
}

/**
 * Handle GET /auth/logout
 * Deletes the session from KV and clears the cookie
 */
export async function handleLogout(request, env) {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const sessionCookie = cookies['map_session'];

    if (sessionCookie && env.MAP_SESSIONS) {
        const [sessionId] = sessionCookie.split('.');
        try {
            await env.MAP_SESSIONS.delete(`session:${sessionId}`);
        } catch (error) {
            console.error('Error deleting session:', error);
        }
    }

    const response = new Response(null, {
        status: 302,
        headers: { 'Location': '/login.html' }
    });

    response.headers.append('Set-Cookie',
        'map_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    );

    return response;
}

/**
 * Handle GET /auth/me
 * Returns the current user's info and permission level from their session.
 * Used by the frontend to display user info and apply permission-based UI.
 */
export async function handleMe(request, env) {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const sessionCookie = cookies['map_session'];

    if (!sessionCookie) {
        return new Response(JSON.stringify({ error: 'Not authenticated' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const [sessionId, signature] = sessionCookie.split('.');

    const isValid = await verifySignature(sessionId, signature, env.SESSION_SECRET);
    if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid session' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (!env.MAP_SESSIONS) {
        return new Response(JSON.stringify({ error: 'Session storage unavailable' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const sessionData = await env.MAP_SESSIONS.get(`session:${sessionId}`, { type: 'json' });

    if (!sessionData) {
        return new Response(JSON.stringify({ error: 'Session expired' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (sessionData.expiresAt < Date.now()) {
        await env.MAP_SESSIONS.delete(`session:${sessionId}`);
        return new Response(JSON.stringify({ error: 'Session expired' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify({
        user: {
            id: sessionData.userId,
            username: sessionData.username,
            globalName: sessionData.globalName,
            avatar: sessionData.avatar,
            avatarUrl: sessionData.avatar
                ? `https://cdn.discordapp.com/avatars/${sessionData.userId}/${sessionData.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/${parseInt(sessionData.discriminator || '0') % 5}.png`,
            permission: sessionData.permission   // 'editor' or 'viewer'
        }
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
