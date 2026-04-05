/**
 * Location API handlers for Map Manager
 *
 * Provides CRUD operations for map locations stored in Cloudflare KV.
 * All locations are stored as a single JSON blob under the 'locations' key.
 * Layer metadata (color, icon) is resolved from the live config via getConfig().
 */

import { getConfig } from './config.js';


/**
 * Generate a unique ID for new locations
 * Uses timestamp + random string for uniqueness
 * @returns {string} Unique identifier
 */
function generateId() {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substring(2, 8);
    return `loc-${timestamp}-${randomPart}`;
}

/**
 * Get all locations from KV storage
 * Returns empty array if KV is empty (new deployment starts with a blank map)
 * @param {Object} env - Cloudflare environment with KV binding
 * @returns {Promise<Array>} Array of location objects
 */
async function getLocations(env) {
    try {
        if (env.MAP_LOCATIONS) {
            const stored = await env.MAP_LOCATIONS.get('locations', { type: 'json' });
            if (stored && stored.locations) {
                return stored.locations;
            }
        }
    } catch (error) {
        console.error('Error reading from KV:', error);
    }

    return [];
}

/**
 * Save locations to KV storage
 * @param {Object} env - Cloudflare environment with KV binding
 * @param {Array} locations - Array of location objects to save
 * @returns {Promise<boolean>} Success status
 */
async function saveLocations(env, locations) {
    try {
        if (env.MAP_LOCATIONS) {
            await env.MAP_LOCATIONS.put('locations', JSON.stringify({ locations }));
            return true;
        }
    } catch (error) {
        console.error('Error writing to KV:', error);
    }
    return false;
}

/**
 * Look up color and icon for a layer from the live config.
 * Falls back to a neutral grey if the layer ID isn't found.
 * @param {Object} env - Cloudflare environment
 * @param {string} layerId - Layer id slug
 * @returns {Promise<{color: string, icon: string}>}
 */
async function getLayerMeta(env, layerId) {
    const config = await getConfig(env);
    const layer = config.layers.find(l => l.id === layerId);
    if (layer) {
        return { color: layer.color, icon: layer.icon || 'dot' };
    }
    return { color: '#666666', icon: 'dot' };
}

/**
 * Handle GET /api/locations
 * Returns all locations, optionally filtered by layer
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment
 * @returns {Response} JSON response with locations array
 */
export async function handleGetLocations(request, env) {
    const url = new URL(request.url);
    const layerFilter = url.searchParams.get('layer');

    let locations = await getLocations(env);

    // Apply layer filter if specified
    if (layerFilter) {
        locations = locations.filter(loc => loc.layer === layerFilter);
    }

    return new Response(JSON.stringify({ locations }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Handle POST /api/locations
 * Creates a new location
 * @param {Request} request - Incoming request with location data in body
 * @param {Object} env - Cloudflare environment
 * @returns {Response} JSON response with created location
 */
export async function handleCreateLocation(request, env) {
    try {
        const body = await request.json();

        // Validate required fields
        if (!body.name || body.x === undefined || body.y === undefined || !body.layer) {
            return new Response(JSON.stringify({
                error: 'Missing required fields: name, x, y, layer'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Resolve layer metadata from config (color + icon)
        const meta = await getLayerMeta(env, body.layer);

        // Get current locations
        const locations = await getLocations(env);

        // Create new location with generated ID
        const newLocation = {
            id: generateId(),
            name: body.name,
            x: parseInt(body.x, 10),
            y: parseInt(body.y, 10),
            layer: body.layer,
            icon: body.icon || meta.icon,
            color: body.color || meta.color
        };

        // Add to locations array
        locations.push(newLocation);

        // Save to KV
        const saved = await saveLocations(env, locations);

        if (!saved) {
            // If KV not available, still return success (for local dev)
            console.warn('KV not available, location created in memory only');
        }

        // Push updated layer to alliance hub (fire-and-forget)
        pushSharedLayerToHub(env, newLocation.layer, locations).catch(() => {});

        return new Response(JSON.stringify({ location: newLocation }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Handle PUT /api/locations/:id
 * Updates an existing location
 * @param {Request} request - Incoming request with updated location data
 * @param {Object} env - Cloudflare environment
 * @param {string} id - Location ID from URL path
 * @returns {Response} JSON response with updated location
 */
export async function handleUpdateLocation(request, env, id) {
    try {
        const body = await request.json();

        // Get current locations
        const locations = await getLocations(env);

        // Find the location to update
        const index = locations.findIndex(loc => loc.id === id);

        if (index === -1) {
            return new Response(JSON.stringify({ error: 'Location not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // If the layer is changing, re-resolve color/icon from config
        let metaOverride = {};
        if (body.layer && body.layer !== locations[index].layer) {
            metaOverride = await getLayerMeta(env, body.layer);
        }

        // Update location fields (only provided fields)
        const updatedLocation = {
            ...locations[index],
            ...(body.name !== undefined && { name: body.name }),
            ...(body.x !== undefined && { x: parseInt(body.x, 10) }),
            ...(body.y !== undefined && { y: parseInt(body.y, 10) }),
            ...(body.layer !== undefined && { layer: body.layer }),
            // Re-apply color/icon from new layer meta, but let explicit body values win
            ...(metaOverride.icon && { icon: metaOverride.icon }),
            ...(metaOverride.color && { color: metaOverride.color }),
            ...(body.icon !== undefined && { icon: body.icon }),
            ...(body.color !== undefined && { color: body.color })
        };

        locations[index] = updatedLocation;

        // Save to KV
        await saveLocations(env, locations);

        // Push updated layer to alliance hub (fire-and-forget)
        pushSharedLayerToHub(env, updatedLocation.layer, locations).catch(() => {});

        return new Response(JSON.stringify({ location: updatedLocation }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Handle DELETE /api/locations/:id
 * Removes a location
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment
 * @param {string} id - Location ID from URL path
 * @returns {Response} JSON response confirming deletion
 */
export async function handleDeleteLocation(request, env, id) {
    // Get current locations
    const locations = await getLocations(env);

    // Find the location to delete
    const index = locations.findIndex(loc => loc.id === id);

    if (index === -1) {
        return new Response(JSON.stringify({ error: 'Location not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Remove the location
    const deleted = locations.splice(index, 1)[0];

    // Save to KV
    await saveLocations(env, locations);

    // Push updated layer to alliance hub (fire-and-forget — sends the remaining locations)
    pushSharedLayerToHub(env, deleted.layer, locations).catch(() => {});

    return new Response(JSON.stringify({
        message: 'Location deleted',
        location: deleted
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Handle POST /api/locations/import
 * Bulk-imports locations from a CSV body.
 * CSV format: x,y,0,NAME,icon-name,color,0
 * The target layer is supplied via the ?layer= query param.
 * Color and icon are resolved from config for the chosen layer.
 * @param {Request} request - Incoming request with CSV text body
 * @param {Object} env - Cloudflare environment
 * @returns {Response} JSON response with import summary
 */
export async function handleImportLocations(request, env) {
    const url = new URL(request.url);
    const layer = url.searchParams.get('layer');

    if (!layer) {
        return new Response(JSON.stringify({ error: 'Missing required query param: layer' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Validate layer exists in config — reject imports to unknown layers
    const config = await getConfig(env);
    const layerExists = config.layers.some(l => l.id === layer);
    if (!layerExists) {
        return new Response(JSON.stringify({
            error: `Unknown layer: "${layer}". Import cancelled — select a valid layer and try again.`
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Resolve layer metadata once for all imported rows
    const meta = config.layers.find(l => l.id === layer);
    const metaResult = { color: meta.color, icon: meta.icon || 'dot' };

    const csvText = await request.text();
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const imported = [];
    const skipped = [];

    for (const line of lines) {
        // Format: x,y,0,NAME,icon-name,color,0
        const parts = line.split(',');
        if (parts.length < 4) {
            skipped.push({ line, reason: 'too few columns' });
            continue;
        }

        const x = parseInt(parts[0], 10);
        const y = parseInt(parts[1], 10);
        // parts[2] is always '0' (ignored)
        const name = parts[3].trim();

        if (isNaN(x) || isNaN(y) || !name) {
            skipped.push({ line, reason: 'invalid x, y, or empty name' });
            continue;
        }

        imported.push({ x, y, name });
    }

    if (imported.length === 0) {
        return new Response(JSON.stringify({
            error: 'No valid rows found in CSV',
            skipped
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Load existing locations and append new ones
    const locations = await getLocations(env);

    const newLocations = imported.map(row => ({
        id: generateId(),
        name: row.name,
        x: row.x,
        y: row.y,
        layer,
        icon: metaResult.icon,
        color: metaResult.color
    }));

    locations.push(...newLocations);
    await saveLocations(env, locations);

    // Push updated layer to alliance hub (fire-and-forget)
    pushSharedLayerToHub(env, layer, locations).catch(() => {});

    return new Response(JSON.stringify({
        imported: newLocations.length,
        skipped: skipped.length,
        skippedRows: skipped
    }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Push all locations on a given layer to the alliance hub.
 * Called fire-and-forget after every write on an alliance-shared layer.
 * Failures are logged but never propagate — guild KV is always authoritative.
 *
 * Requires env vars: ALLIANCE_HUB_URL, ALLIANCE_API_KEY
 * Alliance ID resolved from KV alliance_config (set via UI) → ALLIANCE_ID env var
 * Guild identity is resolved from DISCORD_AUTH_RULES (same as public endpoint).
 *
 * @param {Object} env - Cloudflare environment
 * @param {string} layerId - The layer that was just written
 * @param {Array} allLocations - Current full locations array (after the write)
 */
async function pushSharedLayerToHub(env, layerId, allLocations) {
    if (!env.ALLIANCE_HUB_URL || !env.ALLIANCE_API_KEY) return;

    // Resolve alliance_id: KV alliance_config (set by UI create/join) takes priority
    // over the ALLIANCE_ID env var (set at deploy time in wrangler.toml).
    let allianceId = env.ALLIANCE_ID || null;
    if (env.MAP_LOCATIONS) {
        try {
            const stored = await env.MAP_LOCATIONS.get('alliance_config', { type: 'json' });
            if (stored && stored.alliance_id) allianceId = stored.alliance_id;
        } catch { /* ignore */ }
    }
    if (!allianceId) return;

    const config = await getConfig(env);
    const layer = config.layers.find(l => l.id === layerId);

    // Only push if this layer is flagged alliance_shared
    if (!layer || !layer.alliance_shared) return;

    // Resolve guild identity from DISCORD_AUTH_RULES
    let guildId = '';
    try {
        const authRules = JSON.parse(env.DISCORD_AUTH_RULES || '{}');
        guildId = authRules.guild_id || '';
    } catch (e) { /* ignore */ }

    if (!guildId) {
        console.error('Hub push skipped: could not resolve guild_id from DISCORD_AUTH_RULES');
        return;
    }

    // Collect all locations on this layer (full re-push, not delta)
    const layerLocations = allLocations
        .filter(loc => loc.layer === layerId)
        .map(loc => ({
            location_id: loc.id,
            name: loc.name,
            x: loc.x,
            y: loc.y,
            layer: loc.layer,
            icon: loc.icon,
            color: loc.color
        }));

    const payload = {
        guild_id: guildId,
        alliance_id: allianceId,
        locations: layerLocations,
        layers: [{
            layer_id: layer.id,
            layer_name: layer.name,
            color: layer.color,
            icon: layer.icon || 'dot'
        }]
    };

    try {
        const resp = await fetch(`${env.ALLIANCE_HUB_URL}/api/federation/push`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': env.ALLIANCE_API_KEY
            },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            console.error(`Hub push failed [${resp.status}]:`, err);
        }
    } catch (err) {
        console.error('Hub push error (non-fatal):', err.message);
    }
}

/**
 * Handle GET /api/public/locations
 * Returns locations on alliance-shared layers without requiring Discord auth.
 * Validated by a Bearer token matching the ALLIANCE_PUBLIC_KEY env var.
 * Location IDs are omitted — consumers get display data only, no mutation handles.
 * Response includes guild_id and guild_name for the consuming map to namespace layers.
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment
 * @returns {Response} JSON response with guild info and locations array
 */
export async function handleGetPublicLocations(request, env) {
    // Validate bearer token against ALLIANCE_PUBLIC_KEY
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!env.ALLIANCE_PUBLIC_KEY || token !== env.ALLIANCE_PUBLIC_KEY) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Get config to find which layers are alliance-shared
    const config = await getConfig(env);
    const sharedLayerIds = new Set(
        config.layers.filter(l => l.alliance_shared).map(l => l.id)
    );

    if (sharedLayerIds.size === 0) {
        return new Response(JSON.stringify({
            guild_id: env.DISCORD_GUILD_ID || '',
            guild_name: env.GUILD_NAME || '',
            locations: []
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Load all locations and filter to shared layers only
    const allLocs = await getLocations(env);
    const sharedLocs = allLocs
        .filter(loc => sharedLayerIds.has(loc.layer))
        .map(({ id: _id, ...rest }) => rest); // strip id — read-only consumers don't need it

    // Resolve guild identity — guild_id from DISCORD_AUTH_RULES, name from GUILD_NAME
    let guildId = '';
    try {
        const authRules = JSON.parse(env.DISCORD_AUTH_RULES || '{}');
        guildId = authRules.guild_id || '';
    } catch (e) { /* ignore parse errors */ }
    const guildName = env.GUILD_NAME || '';

    return new Response(JSON.stringify({
        guild_id: guildId,
        guild_name: guildName,
        locations: sharedLocs
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Handle GET /api/locations/export
 * Exports locations as CSV in the required format:
 * x,y,0,NAME,icon-name,color,0
 * Supports ?layers= query param to filter by selected layers (comma-separated)
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment
 * @returns {Response} CSV file download
 */
export async function handleExportLocations(request, env) {
    const url = new URL(request.url);
    const layersParam = url.searchParams.get('layers');

    let locations = await getLocations(env);

    // Filter by selected layers if specified
    if (layersParam) {
        const selectedLayers = layersParam.split(',').map(l => l.trim());
        locations = locations.filter(loc => selectedLayers.includes(loc.layer));
    }

    // Load config once to resolve icon/color names per layer
    const config = await getConfig(env);
    const layerMap = Object.fromEntries(config.layers.map(l => [l.id, l]));

    // Build CSV content: x,y,0,NAME,icon-name,color,0
    const csvLines = locations.map(loc => {
        const layerMeta = layerMap[loc.layer];
        const iconName = layerMeta ? (layerMeta.icon || 'dot') : 'dot';
        // Strip # from hex color for CSV
        const colorValue = (loc.color || '#666666').replace('#', '');
        return `${loc.x},${loc.y},0,${loc.name},${iconName},${colorValue},0`;
    });

    const csvContent = csvLines.join('\n');

    return new Response(csvContent, {
        headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="locations.csv"'
        }
    });
}
