/**
 * Alliance API handlers — proxy routes to the Alliance Hub Worker
 *
 * These routes are authenticated by Discord session (same as all /api/* routes).
 * They use ALLIANCE_HUB_URL + ALLIANCE_API_KEY (secrets) to call the hub on behalf
 * of the guild, so the API key is never exposed to the browser.
 *
 * Routes:
 *   GET    /api/alliance/info    — get current alliance info from hub
 *   POST   /api/alliance/create  — create a new alliance, stores alliance_id in KV
 *   POST   /api/alliance/join    — join via token, stores alliance_id in KV
 *   POST   /api/alliance/invite  — generate a single-use invite token
 *   DELETE /api/alliance/leave   — leave the alliance, clears KV alliance_id
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGuildId(env) {
    try {
        const rules = JSON.parse(env.DISCORD_AUTH_RULES || '{}');
        return rules.guild_id || '';
    } catch {
        return '';
    }
}

async function getAllianceId(env) {
    if (env.MAP_LOCATIONS) {
        try {
            const stored = await env.MAP_LOCATIONS.get('alliance_config', { type: 'json' });
            if (stored && stored.alliance_id) return stored.alliance_id;
        } catch { /* ignore */ }
    }
    return env.ALLIANCE_ID || null;
}

async function setAllianceId(env, allianceId) {
    if (env.MAP_LOCATIONS) {
        await env.MAP_LOCATIONS.put('alliance_config', JSON.stringify({ alliance_id: allianceId }));
    }
}

async function hubFetch(env, path, options = {}) {
    return fetch(`${env.ALLIANCE_HUB_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': env.ALLIANCE_API_KEY,
            ...(options.headers || {})
        }
    });
}

function jsonErr(msg, status = 400) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function jsonOk(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function requireHub(env) {
    if (!env.ALLIANCE_HUB_URL || !env.ALLIANCE_API_KEY) {
        return jsonErr('Hub federation not configured on this guild worker', 404);
    }
    return null;
}

async function proxyHubResponse(resp) {
    const body = await resp.json().catch(() => ({}));
    return new Response(JSON.stringify(body), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// ---------------------------------------------------------------------------
// GET /api/alliance/info
// Returns current alliance info + member list from hub.
// Returns { alliance: null } if no alliance is configured (not an error).
// ---------------------------------------------------------------------------
export async function handleGetAllianceInfo(request, env) {
    const hubErr = requireHub(env);
    if (hubErr) return hubErr;

    const allianceId = await getAllianceId(env);
    if (!allianceId) {
        return jsonOk({ alliance: null });
    }

    const resp = await hubFetch(env, `/api/alliances/${encodeURIComponent(allianceId)}`).catch(() => null);
    if (!resp) return jsonErr('Failed to reach alliance hub', 502);
    if (!resp.ok) return proxyHubResponse(resp);

    const data = await resp.json();
    return jsonOk({ alliance: data });
}

// ---------------------------------------------------------------------------
// POST /api/alliance/create
// Body: { alliance_name }
// Creates a new alliance on the hub, stores the returned alliance_id in KV.
// ---------------------------------------------------------------------------
export async function handleCreateAlliance(request, env) {
    const hubErr = requireHub(env);
    if (hubErr) return hubErr;

    const body = await request.json().catch(() => null);
    if (!body || !body.alliance_name) return jsonErr('Missing required field: alliance_name');

    const guildId = getGuildId(env);
    if (!guildId) return jsonErr('Guild ID not resolvable from DISCORD_AUTH_RULES');

    const resp = await hubFetch(env, '/api/alliances', {
        method: 'POST',
        body: JSON.stringify({ guild_id: guildId, alliance_name: body.alliance_name })
    }).catch(() => null);

    if (!resp) return jsonErr('Failed to reach alliance hub', 502);
    if (!resp.ok) return proxyHubResponse(resp);

    const data = await resp.json();
    await setAllianceId(env, data.alliance_id);

    return jsonOk(data, 201);
}

// ---------------------------------------------------------------------------
// POST /api/alliance/join
// Body: { token }
// Joins via a single-use or bootstrap invite token; stores alliance_id in KV.
// ---------------------------------------------------------------------------
export async function handleJoinAlliance(request, env) {
    const hubErr = requireHub(env);
    if (hubErr) return hubErr;

    const body = await request.json().catch(() => null);
    if (!body || !body.token) return jsonErr('Missing required field: token');

    const guildId = getGuildId(env);
    if (!guildId) return jsonErr('Guild ID not resolvable from DISCORD_AUTH_RULES');

    const resp = await hubFetch(env, '/api/alliances/join', {
        method: 'POST',
        body: JSON.stringify({ guild_id: guildId, token: body.token })
    }).catch(() => null);

    if (!resp) return jsonErr('Failed to reach alliance hub', 502);
    if (!resp.ok) return proxyHubResponse(resp);

    const data = await resp.json();
    if (data.alliance_id) await setAllianceId(env, data.alliance_id);

    return jsonOk(data);
}

// ---------------------------------------------------------------------------
// POST /api/alliance/invite
// Body: { expires_in_hours? }
// Generates a single-use invite token for the current alliance.
// ---------------------------------------------------------------------------
export async function handleCreateAllianceInvite(request, env) {
    const hubErr = requireHub(env);
    if (hubErr) return hubErr;

    const allianceId = await getAllianceId(env);
    if (!allianceId) return jsonErr('Not in an alliance — create or join one first');

    const guildId = getGuildId(env);
    if (!guildId) return jsonErr('Guild ID not resolvable from DISCORD_AUTH_RULES');

    const body = await request.json().catch(() => ({}));

    const resp = await hubFetch(env, `/api/alliances/${encodeURIComponent(allianceId)}/invites`, {
        method: 'POST',
        body: JSON.stringify({ guild_id: guildId, expires_in_hours: body.expires_in_hours || 72 })
    }).catch(() => null);

    if (!resp) return jsonErr('Failed to reach alliance hub', 502);
    if (!resp.ok) return proxyHubResponse(resp);

    return jsonOk(await resp.json(), 201);
}

// ---------------------------------------------------------------------------
// DELETE /api/alliance/leave
// Removes this guild from the current alliance; clears KV alliance_id.
// ---------------------------------------------------------------------------
export async function handleLeaveAlliance(request, env) {
    const hubErr = requireHub(env);
    if (hubErr) return hubErr;

    const allianceId = await getAllianceId(env);
    if (!allianceId) return jsonErr('Not in an alliance');

    const guildId = getGuildId(env);
    if (!guildId) return jsonErr('Guild ID not resolvable from DISCORD_AUTH_RULES');

    const resp = await hubFetch(env, `/api/alliances/${encodeURIComponent(allianceId)}/members/${encodeURIComponent(guildId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ guild_id: guildId })
    }).catch(() => null);

    if (!resp) return jsonErr('Failed to reach alliance hub', 502);
    if (!resp.ok) return proxyHubResponse(resp);

    // Clear the stored alliance_id
    if (env.MAP_LOCATIONS) {
        await env.MAP_LOCATIONS.delete('alliance_config').catch(() => {});
    }

    return jsonOk({ left: true, alliance_id: allianceId });
}
