# Map Manager Discord Bot

A Discord bot that provides slash-command access to the [Guild Map Manager](../README.md). No local database — the bot calls the Map Manager Worker API directly, so changes from the bot appear on the web map instantly and vice versa.

**This is an optional add-on.** The web map works fine without it.

## Prerequisites

- Node.js 18+
- A deployed Map Manager worker with `BOT_API_KEY` set
- A Discord bot token

## Setup

### 1. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application (or reuse the one from the web map)
3. Go to **Bot** → click **Reset Token** → copy the token
4. No privileged intents are needed

### 2. Invite the bot to your guild

1. Go to **OAuth2 → URL Generator**
2. Scopes: `bot`, `applications.commands`
3. Bot Permissions: `Send Messages`, `Attach Files`, `Use Slash Commands`
4. Open the generated URL and authorize for your guild

### 3. Set the bot API key on your worker

If you haven't already:

```bash
npx wrangler secret put BOT_API_KEY
# (or with --env flag for named environments)
```

### 4. Configure the bot

```bash
cd discord-bot
npm install
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your-bot-token
GUILD_ID=your-discord-guild-id
MAP_API_URL=https://your-map-worker.workers.dev
MAP_API_KEY=the-same-key-you-set-as-BOT_API_KEY
```

### 5. Start the bot

```bash
npm start
```

You should see:
```
Logged in as YourBot#1234
Registering 6 slash commands...
Slash commands registered.
Connected to Map Manager — 5 layers configured
```

## Commands

| Command | Description |
|---------|-------------|
| `/add <layer> <name> <x> <y>` | Add a new location |
| `/delete <name>` | Delete a location by name |
| `/update <name> [new_name] [x] [y] [layer]` | Update a location |
| `/list [layer] [search]` | List locations (with optional filters) |
| `/export [layer]` | Download locations as CSV |
| `/layers` | Show configured layers with location counts |

All layer and location name fields support **autocomplete** — start typing and the bot will suggest matches.

## Running as a service

The bot needs to stay running. On a VPS, use a process manager:

```bash
# With pm2
npm install -g pm2
pm2 start src/index.js --name map-bot
pm2 save
pm2 startup

# With systemd (create /etc/systemd/system/map-bot.service)
[Unit]
Description=Map Manager Discord Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/discord-bot
ExecStart=/usr/bin/node src/index.js
Restart=always
EnvironmentFile=/path/to/discord-bot/.env

[Install]
WantedBy=multi-user.target
```

## Permissions

The bot has full editor access via `BOT_API_KEY`. To restrict which Discord users can use the commands, go to **Server Settings → Integrations → (your bot)** and configure command permissions per role or channel.
