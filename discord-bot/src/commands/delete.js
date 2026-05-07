import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete a location from the map')
    .addStringOption(opt =>
        opt.setName('name').setDescription('Location name').setRequired(true).setAutocomplete(true));

export async function autocomplete(interaction, api) {
    const focused = interaction.options.getFocused();
    if (!focused) {
        await interaction.respond([]);
        return;
    }
    const matches = await api.findLocationsByName(focused);
    await interaction.respond(
        matches.slice(0, 25).map(l => ({ name: `${l.name} (${l.x}, ${l.y})`, value: l.name }))
    );
}

export async function execute(interaction, api) {
    const name = interaction.options.getString('name');

    await interaction.deferReply();

    try {
        const matches = await api.findLocationsByName(name);

        if (matches.length === 0) {
            await interaction.editReply({
                embeds: [{ color: 0xf44336, title: 'Not Found', description: `No location matching **${name}** found.` }],
            });
            return;
        }

        if (matches.length > 1) {
            const exact = matches.filter(l => l.name.toLowerCase() === name.toLowerCase());
            if (exact.length !== 1) {
                const list = matches.slice(0, 10).map(l => `• ${l.name} (${l.x}, ${l.y})`).join('\n');
                const suffix = matches.length > 10 ? `\n…and ${matches.length - 10} more` : '';
                await interaction.editReply({
                    embeds: [{
                        color: 0xff9800,
                        title: 'Multiple Matches',
                        description: `Found ${matches.length} locations matching **${name}**. Be more specific:\n${list}${suffix}`,
                    }],
                });
                return;
            }
            matches.length = 0;
            matches.push(exact[0]);
        }

        const location = matches[0];
        await api.deleteLocation(location.id);

        const layers = await api.getLayers(true);
        const layerMeta = layers.find(l => l.id === location.layer);
        const layerName = layerMeta ? layerMeta.name : location.layer;

        await interaction.editReply({
            embeds: [{
                color: 0xf44336,
                title: 'Location Deleted',
                description: `**${location.name}** removed from **${layerName}**`,
                fields: [
                    { name: 'Coordinates', value: `(${location.x}, ${location.y})`, inline: true },
                ],
            }],
        });
    } catch (err) {
        await interaction.editReply({
            embeds: [{ color: 0xf44336, title: 'Error', description: err.message }],
        });
    }
}
