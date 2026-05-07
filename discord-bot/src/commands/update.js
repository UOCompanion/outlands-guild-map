import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('update')
    .setDescription('Update an existing location')
    .addStringOption(opt =>
        opt.setName('name').setDescription('Location to update').setRequired(true).setAutocomplete(true))
    .addStringOption(opt =>
        opt.setName('new_name').setDescription('New name').setRequired(false))
    .addIntegerOption(opt =>
        opt.setName('x').setDescription('New X coordinate').setRequired(false))
    .addIntegerOption(opt =>
        opt.setName('y').setDescription('New Y coordinate').setRequired(false))
    .addStringOption(opt =>
        opt.setName('layer').setDescription('New layer').setRequired(false).setAutocomplete(true));

export async function autocomplete(interaction, api) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'name') {
        if (!focused.value) { await interaction.respond([]); return; }
        const matches = await api.findLocationsByName(focused.value);
        await interaction.respond(
            matches.slice(0, 25).map(l => ({ name: `${l.name} (${l.x}, ${l.y})`, value: l.name }))
        );
    } else if (focused.name === 'layer') {
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
    const name = interaction.options.getString('name');
    const newName = interaction.options.getString('new_name');
    const x = interaction.options.getInteger('x');
    const y = interaction.options.getInteger('y');
    const layer = interaction.options.getString('layer');

    if (!newName && x === null && y === null && !layer) {
        await interaction.reply({
            embeds: [{ color: 0xff9800, title: 'Nothing to update', description: 'Provide at least one field to change: `new_name`, `x`, `y`, or `layer`.' }],
            ephemeral: true,
        });
        return;
    }

    await interaction.deferReply();

    try {
        const location = await api.findExactLocation(name);
        if (!location) {
            const matches = await api.findLocationsByName(name);
            if (matches.length > 0) {
                const list = matches.slice(0, 10).map(l => `• ${l.name}`).join('\n');
                await interaction.editReply({
                    embeds: [{
                        color: 0xff9800,
                        title: 'Multiple Matches',
                        description: `No exact match for **${name}**. Did you mean:\n${list}`,
                    }],
                });
            } else {
                await interaction.editReply({
                    embeds: [{ color: 0xf44336, title: 'Not Found', description: `No location matching **${name}** found.` }],
                });
            }
            return;
        }

        const fields = {};
        if (newName) fields.name = newName;
        if (x !== null) fields.x = x;
        if (y !== null) fields.y = y;
        if (layer) fields.layer = layer;

        const updated = await api.updateLocation(location.id, fields);

        const changes = [];
        if (newName) changes.push(`Name: ${location.name} → ${updated.name}`);
        if (x !== null) changes.push(`X: ${location.x} → ${updated.x}`);
        if (y !== null) changes.push(`Y: ${location.y} → ${updated.y}`);
        if (layer) {
            const layers = await api.getLayers(true);
            const oldLayer = layers.find(l => l.id === location.layer);
            const newLayer = layers.find(l => l.id === updated.layer);
            changes.push(`Layer: ${oldLayer?.name || location.layer} → ${newLayer?.name || updated.layer}`);
        }

        await interaction.editReply({
            embeds: [{
                color: 0x2196f3,
                title: 'Location Updated',
                description: `**${updated.name}** at (${updated.x}, ${updated.y})`,
                fields: [
                    { name: 'Changes', value: changes.join('\n') },
                ],
            }],
        });
    } catch (err) {
        await interaction.editReply({
            embeds: [{ color: 0xf44336, title: 'Error', description: err.message }],
        });
    }
}
