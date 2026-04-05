# Guild Map Manager

An interactive web map for managing guild locations in UO Outlands — docks, houses, runes, and anything else your guild tracks. Built on Cloudflare Workers and protected by Discord OAuth.

Each guild deploys their own independent instance with their own Discord app, KV storage, and layer configuration.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [Discord account](https://discord.com/) with access to your guild's server

Wrangler (the Cloudflare CLI) is installed automatically as a project dependency — no global install needed. Run all Wrangler commands via `npx wrangler` or through the `npm run` scripts.

> **Wrangler version:** This project requires Wrangler v4. After cloning, run `npm install` and you'll have the right version. If you have a global Wrangler install, make sure it's v4: `npm install -g wrangler@4`

---

## Step 1 — Create a Discord Application

You need a Discord "application" so users can log in with Discord. This takes about 5 minutes.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name (e.g. `Guild Map`) → **Create**
3. On the left sidebar, go to **OAuth2**
4. Copy your **Client ID** — you'll need this for `wrangler.toml`
5. Under **Client Secret**, click **Reset Secret** → copy the value and save it somewhere safe — **you can only see it once**

### Add the redirect URI

Still on the OAuth2 page, under **Redirects**:

1. Click **Add Redirect**
2. Enter: `https://<your-worker-name>.workers.dev/auth/callback`
   - Your worker name comes from the `name = "..."` field in `wrangler.toml`
   - Example: if `name = "hook-guild-map"`, the URL is `https://hook-guild-map.workers.dev/auth/callback`
3. If you plan to test locally, also add: `http://localhost:8787/auth/callback`
4. Click **Save Changes**

> You must add the redirect URI **before** anyone tries to log in, or Discord will reject the OAuth request.

### Invite the bot to your guild

The `guilds.members.read` OAuth scope — which is how the app checks a user's roles — requires the Discord app to be present in your server as a bot.

1. In the Developer Portal, go to **OAuth2 → URL Generator**
2. Under **Scopes**, check `bot`
3. Under **Bot Permissions**, leave everything unchecked (no permissions needed)
4. Copy the generated URL at the bottom and open it in your browser
5. Select your guild from the dropdown → **Authorize**

> If you skip this step, users will get a "Failed to verify guild membership" error when logging in.

---

## Step 2 — Find Your Guild ID and Role IDs

You need these for the `DISCORD_AUTH_RULES` setting.

### Enable Developer Mode in Discord

1. Open Discord → **Settings** → **Advanced**
2. Toggle **Developer Mode** on

### Copy your Guild ID

1. Right-click your server name in the left sidebar
2. Click **Copy Server ID**

### Copy your Role ID

1. Go to your server → **Server Settings** → **Roles**
2. Right-click the role that should have map access
3. Click **Copy Role ID**

> You can add multiple roles per permission level — see the `DISCORD_AUTH_RULES` section below.

---

## Step 3 — Clone and Configure

```bash
git clone <this-repo-url>
cd outlands-guild-map
npm install
cp wrangler.toml.example wrangler.toml
```

> `wrangler.toml` is intentionally gitignored — it contains your guild's IDs and should never be committed to a public repo. `wrangler.toml.example` is the safe template that gets committed.

Open `wrangler.toml` and fill in your values:

### Worker name

```toml
name = "my-guild-map"   # → becomes my-guild-map.workers.dev
```

### Discord Client ID

```toml
[vars]
DISCORD_CLIENT_ID = "your-client-id-here"
```

### Auth rules

`DISCORD_AUTH_RULES` controls who can log in and what they can do. Each deployment is tied to **one Discord server** with two permission levels:

- **editor** — full access: add, edit, delete locations, manage layers
- **viewer** — read-only: can see the map and export, cannot make changes

```toml
DISCORD_AUTH_RULES = '''
{
    "guild_id": "YOUR_GUILD_ID",
    "editor_role_ids": ["YOUR_EDITOR_ROLE_ID"],
    "viewer_role_ids": ["YOUR_VIEWER_ROLE_ID"]
}
'''
```

**Multiple roles per level** — user needs any one of them:
```toml
DISCORD_AUTH_RULES = '''
{
    "guild_id": "YOUR_GUILD_ID",
    "editor_role_ids": ["OFFICER_ROLE_ID", "ADMIN_ROLE_ID"],
    "viewer_role_ids": ["MEMBER_ROLE_ID", "ALLY_ROLE_ID"]
}
'''
```

**Any guild member can view** — set `viewer_role_ids` to `[]`:
```toml
DISCORD_AUTH_RULES = '''
{
    "guild_id": "YOUR_GUILD_ID",
    "editor_role_ids": ["OFFICER_ROLE_ID"],
    "viewer_role_ids": []
}
'''
```

**View-only deployment** — no editors, everyone is a viewer:
```toml
DISCORD_AUTH_RULES = '''
{
    "guild_id": "YOUR_GUILD_ID",
    "editor_role_ids": [],
    "viewer_role_ids": ["MEMBER_ROLE_ID"]
}
'''
```

> Editor roles are checked first. If a user has both an editor role and a viewer role, they get editor access.

### Map layers

`MAP_LAYERS` defines your starting layers. These are seeded into KV storage on first deploy and can be changed from the UI afterward.

```toml
MAP_LAYERS = '''
[
    {
        "id": "dockmasters",
        "name": "Dockmasters",
        "color": "#2196F3",
        "icon": "greendot"
    },
    {
        "id": "guild-runes",
        "name": "Guild Runes",
        "color": "#4CAF50",
        "icon": "dot"
    },
    {
        "id": "houses",
        "name": "Houses",
        "color": "#FFC107",
        "icon": "yellowdot"
    }
]
'''
```

Each layer field:
- `id` — stable slug stored on every location (avoid changing post-deploy)
- `name` — display name in the UI
- `color` — hex color for map markers on the web map
- `icon` — icon name written into CSV exports (e.g. `dot`, `greendot`, `reddot`, `bluedot`, `yellowdot`, `orangedot`)

> **JSON must be valid** — no trailing commas. The last item in each array or object must not have a comma after it, or `MAP_LAYERS` will silently fail and fall back to hardcoded defaults.

> The `id` field is a stable slug stored on every location. Avoid changing it after you have location data — changing it won't move existing locations to the renamed layer, it will just orphan them.

---

## Step 4 — Create KV Namespaces

Cloudflare KV is the key-value store where location data, layer config, and sessions are stored.

```bash
npx wrangler kv namespace create "MAP_LOCATIONS"
npx wrangler kv namespace create "MAP_SESSIONS"
```

Each command prints output like:

```
✅ Created KV namespace "MAP_LOCATIONS" with id "abc123def456..."
```

Copy the `id` values into your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "MAP_LOCATIONS"
id = "paste-map-locations-id-here"

[[kv_namespaces]]
binding = "MAP_SESSIONS"
id = "paste-map-sessions-id-here"
```

> Each guild environment needs its own KV namespaces. If you're using named environments (multiple guilds in one `wrangler.toml`), create separate namespaces per environment — see the [Multiple Guild Environments](#multiple-guild-environments) section.

---

## Step 5 — Set Secrets

Secrets are sensitive values that never go in `wrangler.toml`. They're stored encrypted in Cloudflare and injected at runtime.

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET
```
When prompted, paste your Discord app's client secret from Step 1.

```bash
npx wrangler secret put SESSION_SECRET
```
When prompted, paste a random 32+ character string. Generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> Secrets are scoped to the Worker. If you have multiple environments, set secrets per environment — see below.

---

## Step 6 — Test Locally

Create a `.dev.vars` file in the project root (it's gitignored — never commit it):

```
DISCORD_CLIENT_SECRET=your-discord-client-secret-here
SESSION_SECRET=any-random-32-char-string-for-local-testing
```

Then start the local dev server:

```bash
npm run dev
```

The app opens at `http://localhost:8787`. Wrangler simulates KV storage locally — data written during local testing is separate from production.

Make sure `http://localhost:8787/auth/callback` is in your Discord app's redirect URIs (Step 1), then log in with a Discord account that has the required role.

> **Common mistake:** Use `npm run dev`, not `npx run dev`. `npx run` is not a valid command — `npx` runs packages directly, while `npm run` executes scripts defined in `package.json`.

---

## Step 7 — Deploy to Cloudflare

```bash
npm run deploy
```

Your app is live at `https://<name>.workers.dev`.

> First-time deploy triggers Wrangler to ask you to authenticate with your Cloudflare account if you haven't already. Follow the browser prompt.

### Passing flags to Wrangler via npm

Because `npm run` intercepts `--` flags, you need a double-dash separator to pass flags through to Wrangler:

```bash
# ✅ Correct
npm run deploy -- --env f-guild

# ❌ Wrong — npm intercepts --env and ignores it
npm run deploy --env f-guild

# Also valid — bypasses npm scripts entirely
npx wrangler deploy --env f-guild
```

---

## Step 8 — First Login and Layer Setup

1. Visit your worker URL and log in with Discord
2. Layers from `MAP_LAYERS` in `wrangler.toml` are automatically seeded on first request
3. Click **Manage** next to "Map Layers" in the sidebar to:
   - Rename layers
   - Change layer colors (color picker)
   - Set the **icon name** used in CSV exports (e.g. `dot`, `greendot`, `reddot`, `bluedot`, `yellowdot`, `orangedot`)
   - Add new layers
   - Delete unused layers
4. Changes are saved to KV immediately — future deploys won't overwrite them

---

## Importing Existing Location Data

If you have existing location data in CSV format (`x,y,0,NAME,icon,color,0`):

1. Click **Import CSV** in the sidebar
2. Select the target layer from the dropdown
3. Drop your CSV file or click to browse
4. Click **Import**

> The import will be rejected if the selected layer doesn't exist in your current config. If the layer dropdown looks wrong (e.g. shows "Layer 1 / Layer 2" placeholders instead of your real layers), your config wasn't seeded correctly — see the `MAP_LAYERS` FAQ below.

To export your current data:

1. Check the layers you want in the sidebar
2. Click **Download CSV Export**

Or via CLI:
```bash
npx wrangler kv key get --binding MAP_LOCATIONS "locations" > locations-backup.json
```

---

## Multiple Guild Environments

If you're managing deployments for multiple guilds, you can define named environments in a single `wrangler.toml` instead of maintaining separate files.

Each environment gets its own Worker name, KV namespaces, and secrets — fully isolated.

```toml
# ── Guild F ──────────────────────────────────────────────
[env.f-guild]
name = "f-guild-map"

[env.f-guild.vars]
DISCORD_CLIENT_ID = "f-guild-client-id"
DISCORD_AUTH_RULES = '''
{
    "guild_id": "F_GUILD_ID",
    "editor_role_ids": ["F_EDITOR_ROLE_ID"],
    "viewer_role_ids": ["F_VIEWER_ROLE_ID"]
}
'''
MAP_LAYERS = '''
[
    { "id": "docks", "name": "Docks", "color": "#2196F3", "icon": "dot" }
]
'''

[[env.f-guild.kv_namespaces]]
binding = "MAP_LOCATIONS"
id = "f-guild-locations-kv-id"

[[env.f-guild.kv_namespaces]]
binding = "MAP_SESSIONS"
id = "f-guild-sessions-kv-id"
```

Create KV namespaces per environment:
```bash
npx wrangler kv namespace create "MAP_LOCATIONS" --env f-guild
npx wrangler kv namespace create "MAP_SESSIONS" --env f-guild
```

Set secrets per environment:
```bash
npx wrangler secret put DISCORD_CLIENT_SECRET --env f-guild
npx wrangler secret put SESSION_SECRET --env f-guild
```

Deploy per environment (note the `--` separator):
```bash
npm run deploy -- --env f-guild
```

---

## Alliance Federation (Optional)

Guilds in the same in-game alliance can share location data across their separate map instances. There are two modes:

### Phase 1 — Direct feeds (no hub required)

Each guild exposes a public read endpoint. Other guilds pull from it directly. No shared infrastructure.

**On your side (the guild being read):**

1. Set a bearer token secret — this is the key other guilds use to read your public feed:
   ```bash
   npx wrangler secret put ALLIANCE_PUBLIC_KEY
   ```
   Generate a value: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

2. Set your display name so alliance members see a label in their map sidebar:
   ```toml
   [vars]
   GUILD_NAME = "My Guild"
   ```

3. Deploy: `npm run deploy`

4. Mark layers as alliance-visible using the **Alliance** checkbox in **Manage Layers**

5. Share your worker URL and `ALLIANCE_PUBLIC_KEY` value with allied guild officers (Discord DM between officers)

**On allied guilds' side (guilds reading your feed):**

Add to their `wrangler.toml` and redeploy:
```toml
ALLIANCE_FEEDS = '[{"label":"Your Guild","url":"https://your-map.workers.dev/api/public/locations","key":"your-alliance-public-key"}]'
```

### Phase 2 — Alliance hub (recommended for active alliances)

A shared hub worker manages alliance membership and federates location data. Alliance management (create, invite, join, leave) is done from the map UI. No URL/key coordination needed between guilds.

**Prerequisite:** Someone on the alliance sets up and deploys the [Outlands Alliance Hub](https://github.com/your-org/outlands-alliance-hub).

**Per-guild setup:**

1. Register your guild with the hub (one-time curl command — see hub README Step 8)

2. Add to `wrangler.toml`:
   ```toml
   [vars]
   ALLIANCE_HUB_URL = "https://your-alliance-hub.workers.dev"
   GUILD_NAME = "My Guild"   # displayed to other alliance members in their sidebar
   ```

3. Set your API key (the same key you used during registration):
   ```bash
   npx wrangler secret put ALLIANCE_API_KEY
   ```

4. Deploy: `npm run deploy`

5. Open your map → the **Alliance** section appears in the sidebar (editors only) → create or join an alliance from there

6. Mark layers as alliance-shared using the **Alliance** checkbox in **Manage Layers** — those layers will push to the hub automatically on every write

**What guild deployers need to know:**
- `ALLIANCE_HUB_URL` is a public var (safe to expose — the hub's read endpoints are CORS-open)
- `ALLIANCE_API_KEY` is a secret — it never reaches the browser
- `ALLIANCE_ID` does **not** need to be set in `wrangler.toml` — it's stored in KV after you create or join an alliance from the UI
- Alliance locations appear as read-only layers in your map, grouped under "Alliance" in the location list

---

## Bot Integration (Optional)

Many guilds use a Discord bot to manage locations such as dockmasters. The map worker supports a `BOT_API_KEY` secret that lets a bot write to the location API without a Discord session. When the bot updates a location on an alliance-shared layer, the change is automatically pushed to the hub and visible to all alliance members — no extra bot logic needed.

### How it works

- The bot sends `X-API-Key: <your-key>` on every request instead of a session cookie
- The worker grants the bot full editor access
- CRUD operations (`POST`, `PUT`, `DELETE` on `/api/locations`) work exactly as they do for a logged-in editor
- If the location's layer is marked `alliance_shared`, the hub push fires automatically

### Setup

**1. Generate a strong random key**

```bash
openssl rand -hex 32
```

**2. Set the secret on your worker**

```bash
npx wrangler secret put BOT_API_KEY
```

Paste the key when prompted. Redeploy (`npm run deploy`) to activate it.

**3. Share the key with your bot operator**

The bot operator adds it to their bot's configuration. It is never stored in `wrangler.toml` and never reaches the browser.

### Bot API contract

Base URL: your worker URL (e.g. `https://map.yourguild.workers.dev`)

Required header on every request:
```
X-API-Key: <your-key>
```

Standard location endpoints work unchanged:

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/api/locations` | List all locations |
| `POST` | `/api/locations` | Create a location |
| `PUT` | `/api/locations/:id` | Update a location |
| `DELETE` | `/api/locations/:id` | Delete a location |

Example — update a dockmaster location:

```bash
curl -X PUT https://map.yourguild.workers.dev/api/locations/abc123 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-bot-api-key" \
  -d '{"name":"East Dockmaster","x":4200,"y":3100,"layer":"dockmasters"}'
```

### Revoking access

Run `npx wrangler secret delete BOT_API_KEY` and redeploy. All requests using the old key will immediately receive `401 Unauthorized`.

---

## FAQ

### Do I need a separate Discord application for each guild?

**No, but it's recommended for independent guilds.**

- **Shared app** (you're deploying for all guilds): One Discord app, add every guild's redirect URI to it, add the bot to every guild. Each `wrangler.toml` environment uses the same `DISCORD_CLIENT_ID` but its own `DISCORD_AUTH_RULES`.
- **Separate apps** (guilds are self-sufficient): Each guild creates their own Discord application. Fully isolated — credentials never cross between guilds. Takes 5 minutes per guild.

### I changed `MAP_LAYERS` in `wrangler.toml` and redeployed — why didn't my layers update?

Once layers exist in KV (from either the UI or the initial seed), KV takes precedence over `MAP_LAYERS`. Use the **Manage** button in the UI to update layers after the first deploy.

To force a full reset back to your `wrangler.toml` defaults:
```bash
# Default environment
npx wrangler kv key delete --binding MAP_LOCATIONS "config"

# Named environment
npx wrangler kv key delete --binding MAP_LOCATIONS "config" --env f-guild
```
Then redeploy and reload — it will re-seed from `MAP_LAYERS`.

### Locations are missing from the map / layer toggles have no effect

This usually means locations were imported before your layer config was set up correctly — they ended up stored under a layer ID that no longer exists (e.g. `layer-1`, the hardcoded fallback). Those markers are visible on the map but can't be toggled because no checkbox corresponds to their layer.

To confirm, download your location data and check the `layer` field:
```bash
npx wrangler kv key get --binding MAP_LOCATIONS "locations" --env f-guild > locations-backup.json
```

**Option A — Re-import from original CSV files** (cleanest):
```bash
npx wrangler kv key delete --binding MAP_LOCATIONS "locations" --env f-guild
```
Then re-import each CSV through the UI to the correct layer.

**Option B — Patch the layer IDs directly** (if you no longer have the CSV files):

Open `locations-backup.json` and find all entries where `"layer"` has the wrong value (e.g. `"layer-1"`). Change them to the correct layer ID (e.g. `"f_dockmasters"`), then restore:
```bash
npx wrangler kv key put --binding MAP_LOCATIONS "locations" --path locations-backup.json --env f-guild
```

The layer ID must exactly match the `id` field of a layer in your config. Once corrected, the layer checkboxes will toggle those markers as expected.

### A user has the role but can't log in

1. Make sure the Discord bot is added to the guild (Step 1 — Invite the bot). This is the most common cause.
2. Verify the Guild ID and Role ID in `DISCORD_AUTH_RULES` are correct — right-click in Discord with Developer Mode on to re-copy them.
3. Make sure the redirect URI in the Discord app exactly matches your Worker URL, including `https://` and no trailing slash.
4. Check that `DISCORD_CLIENT_SECRET` was set correctly: `npx wrangler secret list` shows which secrets exist (not their values).

### How do I add a custom domain?

1. Set up a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) in the Cloudflare dashboard under your Worker
2. Add `https://yourdomain.com/auth/callback` as a redirect URI in your Discord app
3. Update any existing redirect URIs if the domain replaces the `.workers.dev` URL

### Where is data stored?

| KV Namespace | Key | Contents |
|---|---|---|
| `MAP_LOCATIONS` | `locations` | All map marker data |
| `MAP_LOCATIONS` | `config` | Layer definitions (name, color, icon) |
| `MAP_SESSIONS` | `session:<id>` | User session data (expires after 7 days) |

### How do I back up or restore location data?

**Backup:**
```bash
npx wrangler kv key get --binding MAP_LOCATIONS "locations" > locations-backup.json
npx wrangler kv key get --binding MAP_LOCATIONS "config" > config-backup.json
```

**Restore:**
```bash
npx wrangler kv key put --binding MAP_LOCATIONS "locations" --path locations-backup.json
npx wrangler kv key put --binding MAP_LOCATIONS "config" --path config-backup.json
```

### How do I update Wrangler?

```bash
npm install --save-dev wrangler@latest
```
