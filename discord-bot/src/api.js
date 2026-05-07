/**
 * Map Manager API client.
 * Thin wrapper around fetch that adds the X-API-Key header
 * and provides typed methods for each endpoint.
 */

export class MapApi {
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey;

        // Simple in-memory cache for autocomplete
        this._configCache = null;
        this._configCacheTime = 0;
        this._locationsCache = null;
        this._locationsCacheTime = 0;
    }

    async _fetch(path, options = {}) {
        const headers = {
            'X-API-Key': this.apiKey,
            ...options.headers,
        };

        if (options.body && typeof options.body === 'object') {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }

        const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers });

        if (!res.ok) {
            let message = `API error ${res.status}`;
            try {
                const data = await res.json();
                if (data.error) message = data.error;
                if (data.message) message = data.message;
            } catch {}
            throw new Error(message);
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return res.json();
        }
        return res;
    }

    // ── Config ──────────────────────────────────────────────

    async getConfig(useCache = false) {
        if (useCache && this._configCache && Date.now() - this._configCacheTime < 60_000) {
            return this._configCache;
        }
        const data = await this._fetch('/api/config');
        this._configCache = data;
        this._configCacheTime = Date.now();
        return data;
    }

    async getLayers(useCache = false) {
        const config = await this.getConfig(useCache);
        return config.layers || [];
    }

    // ── Locations ───────────────────────────────────────────

    async getLocations(layer = null, useCache = false) {
        if (useCache && this._locationsCache && Date.now() - this._locationsCacheTime < 30_000) {
            const locs = this._locationsCache;
            return layer ? locs.filter(l => l.layer === layer) : locs;
        }
        const params = layer ? `?layer=${encodeURIComponent(layer)}` : '';
        const data = await this._fetch(`/api/locations${params}`);
        const locations = data.locations || [];
        if (!layer) {
            this._locationsCache = locations;
            this._locationsCacheTime = Date.now();
        }
        return locations;
    }

    async createLocation({ name, x, y, layer }) {
        const data = await this._fetch('/api/locations', {
            method: 'POST',
            body: { name, x, y, layer },
        });
        this._locationsCache = null;
        return data.location;
    }

    async updateLocation(id, fields) {
        const data = await this._fetch(`/api/locations/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: fields,
        });
        this._locationsCache = null;
        return data.location;
    }

    async deleteLocation(id) {
        const data = await this._fetch(`/api/locations/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        this._locationsCache = null;
        return data;
    }

    async exportLocations(layers = null) {
        const params = layers ? `?layers=${encodeURIComponent(layers)}` : '';
        const res = await this._fetch(`/api/locations/export${params}`);
        return res.text();
    }

    // ── Search helpers ──────────────────────────────────────

    async findLocationsByName(search) {
        const all = await this.getLocations(null, true);
        const lower = search.toLowerCase();
        return all.filter(l => l.name.toLowerCase().includes(lower));
    }

    async findExactLocation(name) {
        const all = await this.getLocations(null, true);
        const lower = name.toLowerCase();
        const exact = all.filter(l => l.name.toLowerCase() === lower);
        if (exact.length === 1) return exact[0];
        const partial = all.filter(l => l.name.toLowerCase().includes(lower));
        if (partial.length === 1) return partial[0];
        return null;
    }
}
