import 'dotenv/config';
import { Client, GatewayIntentBits, Collection, REST, Routes } from 'discord.js';
import { MapApi } from './api.js';

import * as add from './commands/add.js';
import * as del from './commands/delete.js';
import * as update from './commands/update.js';
import * as list from './commands/list.js';
import * as exp from './commands/export.js';
import * as layers from './commands/layers.js';

// ── Validate env ────────────────────────────────────────

const required = ['DISCORD_TOKEN', 'GUILD_ID', 'MAP_API_URL', 'MAP_API_KEY'];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`Missing required env var: ${key}`);
        process.exit(1);
    }
}

// ── Setup ───────────────────────────────────────────────

const api = new MapApi(process.env.MAP_API_URL, process.env.MAP_API_KEY);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = new Collection();
const commandModules = [add, del, update, list, exp, layers];
for (const mod of commandModules) {
    commands.set(mod.data.name, mod);
}

// ── Register slash commands ─────────────────────────────

async function registerCommands() {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const body = commandModules.map(m => m.data.toJSON());

    try {
        console.log(`Registering ${body.length} slash commands...`);
        await rest.put(
            Routes.applicationGuildCommands(client.application.id, process.env.GUILD_ID),
            { body }
        );
        console.log('Slash commands registered.');
    } catch (err) {
        console.error('Failed to register commands:', err);
    }
}

// ── Event handlers ──────────────────────────────────────

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands();

    // Verify API connectivity
    try {
        const config = await api.getConfig();
        console.log(`Connected to Map Manager — ${config.layers?.length || 0} layers configured`);
    } catch (err) {
        console.warn(`Warning: Could not reach Map Manager API: ${err.message}`);
        console.warn('Bot will start anyway — commands will fail until the API is reachable.');
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const command = commands.get(interaction.commandName);
        if (command?.autocomplete) {
            try {
                await command.autocomplete(interaction, api);
            } catch (err) {
                console.error(`Autocomplete error (${interaction.commandName}):`, err.message);
                try { await interaction.respond([]); } catch {}
            }
        }
        return;
    }

    if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction, api);
        } catch (err) {
            console.error(`Command error (${interaction.commandName}):`, err);
            const reply = {
                embeds: [{ color: 0xf44336, title: 'Error', description: err.message }],
                ephemeral: true,
            };
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(reply);
                } else {
                    await interaction.reply(reply);
                }
            } catch {}
        }
    }
});

// ── Start ───────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
