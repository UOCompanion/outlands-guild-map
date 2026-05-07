import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('list')
    .setDescription('List locations, optionally filtered by layer or name')
    .addStringOption(opt =>
        opt.setName('layer').setDescription('Filter by layer').setRequired(false).setAutocomplete(true))
    .addStringOption(opt =>
        opt.setName('search').setDescription('Search by name').setRequired(false));

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

function naturalSort(a, b) {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export async function execute(interaction, api) {
    const layer = interaction.options.getString('layer');
    const search = interaction.options.getString('search');

    await interaction.deferReply();

    try {
        let locations = await api.getLocations(layer);

        if (search) {
            const lower = search.toLowerCase();
            locations = locations.filter(l => l.name.toLowerCase().includes(lower));
        }

        locations.sort(naturalSort);

        if (locations.length === 0) {
            const desc = layer ? `No locations found on layer **${layer}**` : 'No locations found';
            await interaction.editReply({
                embeds: [{ color: 0xff9800, title: 'No Results', description: search ? `${desc} matching **${search}**` : desc }],
            });
            return;
        }

        const layers = await api.getLayers(true);
        const layerMap = Object.fromEntries(layers.map(l => [l.id, l.name]));

        const lines = locations.map(l => {
            const ln = layerMap[l.layer] || l.layer;
            return `${l.name} — (${l.x}, ${l.y}) [${ln}]`;
        });

        const header = layer ? `Locations on ${layerMap[layer] || layer}` : 'All Locations';
        const body = lines.join('\n');

        // Discord embed description limit is 4096 chars
        if (body.length <= 3800) {
            await interaction.editReply({
                embeds: [{
                    color: 0x2196f3,
                    title: `${header} (${locations.length})`,
                    description: body,
                }],
            });
        } else {
            const file = new AttachmentBuilder(Buffer.from(body, 'utf-8'), { name: 'locations.txt' });
            await interaction.editReply({
                content: `**${header}** — ${locations.length} locations (attached as file)`,
                files: [file],
            });
        }
    } catch (err) {
        await interaction.editReply({
            embeds: [{ color: 0xf44336, title: 'Error', description: err.message }],
        });
    }
}
