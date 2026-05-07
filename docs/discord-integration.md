# Discord Bot Integration

A Discord bot that provides slash-command access to the Map Manager API. No local database — the bot is a thin client that authenticates via `BOT_API_KEY` and calls the same Worker endpoints the web UI uses.

## Motivation

The existing D-A dockmaster bot (`D:\UO\Outlands\D-A\`) maintains its own SQLite database, which drifts out of sync with the web map. By building the bot as an API client to the Map Manager worker, all data lives in one place — changes from the bot appear on the map instantly, and vice versa.

## Architecture

```
Discord User
    ↓ slash command
Discord Bot (Node.js, discord.js)
    ↓ HTTP + X-API-Key header
Map Manager Worker (Cloudflare)
    ↓
KV Storage (MAP_LOCATIONS)
```

- **No local database.** Every read/write goes through the Worker API.
- **Auth:** The bot uses the `BOT_API_KEY` secret (already supported by the worker's `requireAuth` middleware). This grants editor-level access.
- **One bot instance per guild deployment.** Each guild configures their own bot token and API key pointed at their own worker URL.

## Tech Stack

- **Runtime:** Node.js 18+
- **Discord library:** discord.js v14
- **HTTP client:** Built-in `fetch` (Node 18+)
- **Deployment:** VPS or any always-on host. Not a Cloudflare Worker (needs persistent WebSocket to Discord gateway for autocomplete and event handling).

## Slash Commands

### `/add <layer> <name> <x> <y>`

Add a new location to a layer.

- `layer` — string autocomplete, populated from `GET /api/config` layers
- `name` — string, required
- `x` — integer, required
- `y` — integer, required
- Calls `POST /api/locations` with `{ name, x, y, layer }`
- Responds with confirmation: "Added **East Dock** to Dockmasters at (4200, 3100)"

### `/delete <name>`

Delete a location by name.

- `name` — string autocomplete, searches against all locations
- Fetches `GET /api/locations` to find the matching location by name (case-insensitive)
- If multiple matches, lists them and asks the user to be more specific
- If exactly one match, calls `DELETE /api/locations/:id`
- Responds with confirmation or "not found"

### `/update <name>`

Update an existing location's name, coordinates, or layer.

- `name` — string autocomplete, searches against all locations
- Optional flags: `new_name`, `x`, `y`, `layer` (autocomplete)
- Resolves the location by name (same as delete)
- Calls `PUT /api/locations/:id` with only the changed fields
- Responds with confirmation showing what changed

### `/list [layer] [search]`

List locations, optionally filtered.

- `layer` — optional, string autocomplete from config
- `search` — optional, partial name filter (client-side)
- Calls `GET /api/locations` (with `?layer=` if specified)
- Formats as an embed with sorted location list
- If >25 results, truncates and notes the total count
- If >2000 chars, attaches as a text file (same pattern as the old bot)

### `/export [layer]`

Download locations as CSV.

- `layer` — optional autocomplete; if omitted, exports all layers
- Calls `GET /api/locations/export?layers=...`
- Attaches the CSV response as a Discord file: `locations.csv`

### `/layers`

Show the current layer configuration.

- Calls `GET /api/config`
- Responds with an embed listing each layer: name, color swatch (emoji circle), location count

## Autocomplete

Layer and location name fields use Discord's autocomplete interaction:

- **Layer autocomplete:** Fetches `GET /api/config` on each autocomplete event, returns layer names. Cache for 60 seconds to avoid hammering the API.
- **Name autocomplete:** Fetches `GET /api/locations`, filters by typed prefix (case-insensitive), returns top 25 matches. Cache the full location list for 30 seconds.

## Configuration

The bot reads from environment variables (`.env` file):

```env
DISCORD_TOKEN=bot-token-from-discord-developer-portal
GUILD_ID=your-discord-guild-id
MAP_API_URL=https://your-map-worker.workers.dev
MAP_API_KEY=your-bot-api-key
```

- `DISCORD_TOKEN` — Discord bot token (from Developer Portal → Bot → Token)
- `GUILD_ID` — Discord guild ID for guild-scoped command registration (instant sync, no 1-hour global delay)
- `MAP_API_URL` — Base URL of the Map Manager worker
- `MAP_API_KEY` — The `BOT_API_KEY` secret set on the worker

## Project Structure

Lives at `discord-bot/` in the Map Manager repo root. Self-contained with its own `package.json` — an optional add-on that guild deployers can ignore if they don't need bot commands.

```
discord-bot/
├── src/
│   ├── index.js          — Bot startup, client setup, command registration
│   ├── api.js            — HTTP client wrapper (fetch + X-API-Key header)
│   └── commands/
│       ├── add.js        — /add command
│       ├── delete.js     — /delete command
│       ├── update.js     — /update command
│       ├── list.js       — /list command
│       ├── export.js     — /export command
│       └── layers.js     — /layers command
├── .env.example          — Template env file
├── package.json          — Separate from the worker's package.json
└── README.md             — Standalone setup guide for guild deployers
```

The root `.gitignore` should include `discord-bot/.env` to avoid committing secrets.

## API Client (`api.js`)

Thin wrapper around `fetch` that:

1. Prepends `MAP_API_URL` to all paths
2. Adds `X-API-Key` header to every request
3. Adds `Content-Type: application/json` for POST/PUT
4. Throws on non-2xx responses with the error message from the JSON body
5. Caches `GET /api/config` and `GET /api/locations` responses with short TTLs for autocomplete

```js
// Usage
const api = new MapApi(process.env.MAP_API_URL, process.env.MAP_API_KEY);
const { locations } = await api.getLocations({ layer: 'dockmasters' });
const { location } = await api.createLocation({ name, x, y, layer });
await api.deleteLocation(id);
```

## Discord Bot Setup (for guild deployers)

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application (or reuse the OAuth app from the map)
3. Go to **Bot** → **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, no special intents are needed
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Attach Files`, `Use Slash Commands`
6. Invite the bot to your guild using the generated URL
7. On the Map Manager worker, set the bot API key:
   ```bash
   npx wrangler secret put BOT_API_KEY
   ```
8. Configure the bot's `.env` with the token, guild ID, worker URL, and API key
9. Start the bot: `node src/index.js`

## Response Formatting

- Success: green embed with details
- Error: red embed with error message
- Lists: compact format, one location per line: `Name — (X, Y)`
- Large results: attached as `.txt` file

## Permissions

The bot uses the worker's `BOT_API_KEY` auth, which grants full editor access. Discord-side permissions (who can use the slash commands) should be configured via Discord's **Integrations** settings in Server Settings — guild admins can restrict commands to specific roles or channels.

## Error Handling

- API unreachable → "Could not connect to the map server. Is the worker URL correct?"
- 401 from API → "Authentication failed. Check the bot's API key."
- 400 from API → Show the error message from the response body
- Location not found → "No location named **X** found. Did you mean: ..."

## Future Considerations

- **Audit logging:** The worker doesn't currently log who made a change. Could add a `modified_by` field to locations, populated from a header the bot sends.
- **Notifications:** Bot could post to a channel when locations are added/removed via the web UI (would need a webhook or polling approach).
- **Bulk import:** A `/import` command that accepts a CSV file attachment, similar to the web UI's import feature.
