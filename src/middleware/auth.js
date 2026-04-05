/**
 * Authentication Middleware for Map Manager
 *
 * Provides session verification functions to protect routes.
 * Validates session cookies using HMAC signatures and KV storage.
 */

/**
 * Parse cookies from the Cookie header
 * @param {string} cookieHeader - Cookie header string
 * @returns {Object} Object with cookie name/value pairs
 */
function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;

    cookieHeader.split(';').forEach(cookie => {
        const [name, ...valueParts] = cookie.trim().split('=');
        if (name) {
            cookies[name] = valueParts.join('=');
        }
    });
    return cookies;
}

/**
 * Verify an HMAC signature
 * @param {string} value - Original value
 * @param {string} signature - Signature to verify
 * @param {string} secret - Secret key used for signing
 * @returns {Promise<boolean>} True if signature is valid
 */
async function verifySignature(value, signature, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer), byte =>
        byte.toString(16).padStart(2, '0')
    ).join('');

    // Constant-time comparison to prevent timing attacks
    if (expectedSignature.length !== signature.length) return false;
    let result = 0;
    for (let i = 0; i < expectedSignature.length; i++) {
        result |= expectedSignature.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Verify authentication and return user data if valid.
 *
 * Auth order:
 *  1. X-API-Key header (bot access) — if present and BOT_API_KEY is configured,
 *     do a constant-time compare and either grant editor access or fail closed.
 *     Never falls through to session auth when an API key is presented.
 *  2. map_session cookie (Discord OAuth session) — existing browser flow.
 *
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment with secrets and KV bindings
 * @returns {Promise<Object|null>} User object if authenticated, null otherwise
 */
export async function requireAuth(request, env) {
    // --- Bot API key auth (X-API-Key header) ---
    // Check this before cookie auth so bots don't need a Discord session.
    const botKey = request.headers.get('X-API-Key');
    if (botKey !== null && env.BOT_API_KEY) {
        const encoder = new TextEncoder();
        const a = encoder.encode(botKey);
        const b = encoder.encode(env.BOT_API_KEY);
        // Constant-time compare — prevent timing oracle on key length/content.
        // Keys of different lengths can never match; pad shorter to longer length
        // so the loop always runs the same number of iterations.
        const len = Math.max(a.length, b.length);
        let diff = a.length ^ b.length;  // non-zero if lengths differ
        for (let i = 0; i < len; i++) {
            diff |= (a[i] || 0) ^ (b[i] || 0);
        }
        if (diff === 0) {
            return { permission: 'editor', bot: true, id: 'bot' };
        }
        // Wrong key — fail closed. Do NOT fall through to session auth.
        return null;
    }

    // --- Discord session cookie auth ---
    // Extract session cookie from request
    const cookies = parseCookies(request.headers.get('Cookie'));
    const sessionCookie = cookies['map_session'];

    // No session cookie present
    if (!sessionCookie) {
        return null;
    }

    // Parse signed session: sessionId.signature
    const parts = sessionCookie.split('.');
    if (parts.length !== 2) {
        return null;
    }

    const [sessionId, signature] = parts;

    // Verify the signature using the session secret
    if (!env.SESSION_SECRET) {
        console.error('SESSION_SECRET not configured');
        return null;
    }

    const isValid = await verifySignature(sessionId, signature, env.SESSION_SECRET);
    if (!isValid) {
        console.log('Invalid session signature');
        return null;
    }

    // Look up session in KV storage
    if (!env.MAP_SESSIONS) {
        console.error('MAP_SESSIONS KV namespace not bound');
        return null;
    }

    try {
        const sessionData = await env.MAP_SESSIONS.get(`session:${sessionId}`, { type: 'json' });

        if (!sessionData) {
            // Session not found or expired
            return null;
        }

        // Check if session has expired
        if (sessionData.expiresAt && sessionData.expiresAt < Date.now()) {
            // Clean up expired session
            await env.MAP_SESSIONS.delete(`session:${sessionId}`);
            return null;
        }

        // Return user object with session data
        return {
            id: sessionData.userId,
            username: sessionData.username,
            globalName: sessionData.globalName,
            avatar: sessionData.avatar,
            roles: sessionData.roles,
            permission: sessionData.permission,  // 'editor' or 'viewer'
            sessionId: sessionId
        };

    } catch (error) {
        console.error('Error reading session from KV:', error);
        return null;
    }
}

/**
 * Create a 401 Unauthorized response
 * @returns {Response} 401 response with JSON body
 */
export function unauthorizedResponse() {
    return new Response(JSON.stringify({
        error: 'Unauthorized',
        message: 'Authentication required'
    }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Create a redirect response to the login page
 * @param {Request} request - Original request (used to build redirect URL)
 * @returns {Response} 302 redirect response
 */
export function redirectToLogin(request) {
    const url = new URL(request.url);
    return new Response(null, {
        status: 302,
        headers: {
            'Location': `${url.origin}/login.html`
        }
    });
}
