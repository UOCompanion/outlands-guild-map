import { SlashCommandBuilder } from 'discord.js';

const COLOR_CIRCLES = {
    '#f44336': '🔴', '#e91e63': '🔴', '#c62828': '🔴',
    '#ff9800': '🟠', '#ff5722': '🟠',
    '#ffc107': '🟡', '#ffeb3b': '🟡', '#eaff07': '🟡',
    '#4caf50': '🟢', '#8bc34a': '🟢', '#2e7d32': '🟢', '#21f387': '🟢',
    '#2196f3': '🔵', '#1565c0': '🔵', '#0720ff': '🔵',
    '#9c27b0': '🟣', '#673ab7': '🟣',
    '#795548': '🟤',
};

function colorEmoji(hex) {
    const lower = (hex || '').toLowerCase();
    return COLOR_CIRCLES[lower] || '⚪';
}

export const data = new SlashCommandBuilder()
    .setName('layers')
    .setDescription('Show configured map layers');

export async function execute(interaction, api) {
    await interaction.deferReply();

    try {
        const [layers, locations] = await Promise.all([
            api.getLayers(),
            api.getLocations(),
        ]);

        const counts = {};
        for (const loc of locations) {
            counts[loc.layer] = (counts[loc.layer] || 0) + 1;
        }

        const lines = layers.map(l => {
            const emoji = colorEmoji(l.color);
            const count = counts[l.id] || 0;
            return `${emoji} **${l.name}** — ${count} location${count !== 1 ? 's' : ''} (\`${l.id}\`)`;
        });

        await interaction.editReply({
            embeds: [{
                color: 0xffd700,
                title: 'Map Layers',
                description: lines.join('\n') || 'No layers configured.',
            }],
        });
    } catch (err) {
        await interaction.editReply({
            embeds: [{ color: 0xf44336, title: 'Error', description: err.message }],
        });
    }
}
