const dotenv = require('dotenv');
const { Client, Intents } = require('discord.js');
const COMMANDS = require('./commands');

dotenv.config();

if (!process.env.DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN is required in .env to deploy commands.');
}

const client = new Client({
  intents: [Intents.FLAGS.GUILDS],
});

client.once('ready', async () => {
  try {
    if (process.env.GUILD_ID) {
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      await guild.commands.set(COMMANDS);
      console.log(`Registered ${COMMANDS.length} guild command(s) in ${guild.name}.`);
    } else {
      await client.application.commands.set(COMMANDS);
      console.log(`Registered ${COMMANDS.length} global command(s).`);
    }
  } catch (error) {
    console.error('Failed to deploy commands.', error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);