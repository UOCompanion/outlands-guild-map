import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a new location to the map')
    .addStringOption(opt =>
        opt.setName('layer').setDescription('Target layer').setRequired(true).setAutocomplete(true))
    .addStringOption(opt =>
        opt.setName('name').setDescription('Location name').setRequired(true))
    .addIntegerOption(opt =>
        opt.setName('x').setDescription('X coordinate').setRequired(true))
    .addIntegerOption(opt =>
        opt.setName('y').setDescription('Y coordinate').setRequired(true));

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
    const name = interaction.options.getString('name');
    const x = interaction.options.getInteger('x');
    const y = interaction.options.getInteger('y');

    await interaction.deferReply();

    try {
        const layers = await api.getLayers(true);
        const layerMeta = layers.find(l => l.id === layer);
        const layerName = layerMeta ? layerMeta.name : layer;

        const location = await api.createLocation({ name, x, y, layer });

        await interaction.editReply({
            embeds: [{
                color: 0x4caf50,
                title: 'Location Added',
                description: `**${location.name}** added to **${layerName}**`,
                fields: [
                    { name: 'Coordinates', value: `(${location.x}, ${location.y})`, inline: true },
                    { name: 'Layer', value: layerName, inline: true },
                ],
            }],
        });
    } catch (err) {
        await interaction.editReply({
            embeds: [{ color: 0xf44336, title: 'Error', description: err.message }],
        });
    }
}
