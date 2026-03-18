const dotenv = require('dotenv');
const { Client, Intents } = require('discord.js');

dotenv.config();

if (!process.env.DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN is required in .env to clear commands.');
}

const scope = (process.argv[2] || 'both').toLowerCase();
const validScopes = new Set(['global', 'guild', 'both']);

if (!validScopes.has(scope)) {
  throw new Error("Scope must be 'global', 'guild', or 'both'.");
}

const client = new Client({
  intents: [Intents.FLAGS.GUILDS],
});

client.once('ready', async () => {
  try {
    if (scope === 'global' || scope === 'both') {
      await client.application.commands.set([]);
      console.log('Cleared global commands.');
    }

    if (scope === 'guild' || scope === 'both') {
      if (!process.env.GUILD_ID) {
        console.log('Skipped clearing guild commands.');
      } else {
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        await guild.commands.set([]);
        console.log(`Cleared guild commands in ${guild.name}.`);
      }
    }
  } catch (error) {
    console.error('Failed to clear commands.', error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);