import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export locations as CSV')
    .addStringOption(opt =>
        opt.setName('layer').setDescription('Export a specific layer (omit for all)').setRequired(false).setAutocomplete(true));

export async function autocomplete(interaction, api) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'layer') {
        const layers = await api.getLayers(true);
        const filtered = layers.filter(l =>
            l.name.toLowerCase().includes(focused.value.toLowerCase())
        );
        await interaction.respond(
            filtered.slice(0, 25).map(l => ({ name: l.name, value: l.id }))
        );
    }
}

export async function execute(interaction, api) {
    const layer = interaction.options.getString('layer');

    await interaction.deferReply();

    try {
        const layers = await api.getLayers(true);
        const layerIds = layer ? layer : layers.map(l => l.id).join(',');
        const csv = await api.exportLocations(layerIds);

        if (!csv || csv.trim().length === 0) {
            await interaction.editReply({
                embeds: [{ color: 0xff9800, title: 'Empty Export', description: 'No locations to export.' }],
            });
            return;
        }

        const lineCount = csv.trim().split('\n').length;
        const layerName = layer
            ? (layers.find(l => l.id === layer)?.name || layer)
            : 'all layers';

        const file = new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: 'locations.csv' });
        await interaction.editReply({
            content: `Exported **${lineCount}** locations from **${layerName}**`,
            files: [file],
        });
    } catch (err) {
        await interaction.editReply({
            embeds: [{ color: 0xf44336, title: 'Error', description: err.message }],
        });
    }
}
