/**
 * Config API handlers for Map Manager
 *
 * Manages guild configuration stored in Cloudflare KV under the 'config' key.
 * Currently covers map layer definitions (id, name, color, icon).
 *
 * Config resolution order:
 *   1. KV 'config' key  — authoritative, set via PUT /api/config or seeded on first use
 *   2. MAP_LAYERS env var — wrangler.toml seed; written to KV so future reads use KV
 *   3. Hardcoded fallback — last resort so the app never crashes without configuration
 */

// Hardcoded fallback layers used only when neither KV nor MAP_LAYERS env var is set
const DEFAULT_LAYERS = [
    { id: 'layer-1', name: 'Layer 1', color: '#2196F3', icon: 'dot' },
    { id: 'layer-2', name: 'Layer 2', color: '#4CAF50', icon: 'dot' }
];

/**
 * Load config from KV, seeding from MAP_LAYERS env var if KV is empty.
 * Writes the seed into KV so subsequent reads skip the env var parse.
 * @param {Object} env - Cloudflare environment
 * @returns {Promise<{layers: Array}>} Config object
 */
export async function getConfig(env) {
    // 1. Try KV first
    if (env.MAP_LOCATIONS) {
        try {
            const stored = await env.MAP_LOCATIONS.get('config', { type: 'json' });
            if (stored && Array.isArray(stored.layers)) {
                return stored;
            }
        } catch (error) {
            console.error('Error reading config from KV:', error);
        }
    }

    // 2. Fall back to MAP_LAYERS env var and seed it into KV
    let layers = DEFAULT_LAYERS;

    if (env.MAP_LAYERS) {
        try {
            const parsed = JSON.parse(env.MAP_LAYERS);
            if (Array.isArray(parsed) && parsed.length > 0) {
                layers = parsed;
            }
        } catch (e) {
            console.error('Failed to parse MAP_LAYERS env var:', e.message);
        }
    }

    const config = { layers };

    // Persist seed to KV so future requests don't re-parse the env var
    if (env.MAP_LOCATIONS) {
        try {
            await env.MAP_LOCATIONS.put('config', JSON.stringify(config));
        } catch (error) {
            console.error('Error seeding config to KV:', error);
        }
    }

    return config;
}

/**
 * Handle GET /api/config
 * Returns the current guild config (layers, etc.)
 * @param {Request} request - Incoming request
 * @param {Object} env - Cloudflare environment
 * @returns {Response} JSON response with config object
 */
export async function handleGetConfig(request, env) {
    const config = await getConfig(env);
    return new Response(JSON.stringify(config), {
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Handle PUT /api/config
 * Replaces the stored config with the provided body.
 * Validates that layers is a non-empty array and each layer has required fields.
 * When layers are deleted, purges all locations belonging to those layers from KV.
 * @param {Request} request - Incoming request with config JSON body
 * @param {Object} env - Cloudflare environment
 * @returns {Response} JSON response with the saved config
 */
export async function handleUpdateConfig(request, env) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Validate layers array
    if (!body.layers || !Array.isArray(body.layers)) {
        return new Response(JSON.stringify({ error: 'Missing or invalid layers array' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Validate each layer has the required fields
    for (const layer of body.layers) {
        if (!layer.id || !layer.name || !layer.color) {
            return new Response(JSON.stringify({
                error: 'Each layer must have id, name, and color fields'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        // Default icon to 'dot' if not provided
        if (!layer.icon) {
            layer.icon = 'dot';
        }
    }

    const config = { layers: body.layers };

    if (!env.MAP_LOCATIONS) {
        return new Response(JSON.stringify({ error: 'KV storage unavailable' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // Determine which layer IDs are being removed so we can purge their locations
        const oldConfig = await getConfig(env);
        const newLayerIds = new Set(body.layers.map(l => l.id));
        const deletedLayerIds = oldConfig.layers.map(l => l.id).filter(id => !newLayerIds.has(id));

        // Save the new config
        await env.MAP_LOCATIONS.put('config', JSON.stringify(config));

        // Purge locations belonging to deleted layers
        if (deletedLayerIds.length > 0) {
            const stored = await env.MAP_LOCATIONS.get('locations', { type: 'json' });
            if (stored && stored.locations) {
                const remaining = stored.locations.filter(loc => !deletedLayerIds.includes(loc.layer));
                await env.MAP_LOCATIONS.put('locations', JSON.stringify({ locations: remaining }));
            }
        }
    } catch (error) {
        console.error('Error saving config to KV:', error);
        return new Response(JSON.stringify({ error: 'Failed to save config' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify(config), {
        headers: { 'Content-Type': 'application/json' }
    });
}
