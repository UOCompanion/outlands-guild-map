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
 * Verify authentication and return user data if valid
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment with secrets and KV bindings
 * @returns {Promise<Object|null>} User object if authenticated, null otherwise
 */
export async function requireAuth(request, env) {
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
