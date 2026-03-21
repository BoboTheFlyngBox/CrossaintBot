const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client, Intents, MessageActionRow, MessageButton, MessageAttachment } = require('discord.js');
const COMMANDS = require('./commands');
const { getMatchData, parseResponse } = require('./matchDataFromId');

dotenv.config();

const DATA_PATH = path.join(__dirname, 'data.json');
const MAX_TIME = {
  1: 13 * 60 * 1000,
  2: 15 * 60 * 1000,
  3: 17 * 60 * 1000,
  4: 20 * 60 * 1000,
  5: 25 * 60 * 1000,
  6: 30 * 60 * 1000,
};

const WEBSITE_URL = process.env.WEBSITE_URL
const WEBSITE_API_KEY = process.env.WEBSITE_API_KEY

function mkS() {
  return { settings: { leagueLimits: { ...MAX_TIME }, pendingDisplacements: {}, loggingEnabled: true }, channels: {} };
}

function ensS() {
  if(!fs.existsSync(DATA_PATH)) {
    svS(mkS());
  }
}

function migS(parsed) {
  const store = mkS();
  store.settings.leagueLimits = {
    ...store.settings.leagueLimits,
    ...(parsed.settings?.leagueLimits || {}),
  };
  for(const leagueKey of Object.keys(store.settings.leagueLimits)) {
    if(store.settings.leagueLimits[leagueKey] < 1000 * 60) {
      store.settings.leagueLimits[leagueKey] *= 1000;
    }
  }
  store.settings.pendingDisplacements = parsed.settings?.pendingDisplacements || {};
  store.settings.loggingEnabled = parsed.settings?.loggingEnabled !== false;

  if(parsed.channels) {
    store.channels = Object.fromEntries(
      Object.entries(parsed.channels).map(([channelId, channel]) => [
        channelId,
        {
          competition: channel.competition
            ? {
                ...channel.competition,
                status: channel.competition.status || 'active',
                playerCount: Number(channel.competition.playerCount || 0),
                registeredPlayers: channel.competition.registeredPlayers || {},
                initMessageId: channel.competition.initMessageId || null,
                seeds: Object.fromEntries(
                  Object.entries(channel.competition.seeds || {}).map(([seedId, seed]) => [
                    seedId,
                    {
                      ...seed,
                      editingEnabled: seed.editingEnabled !== false,
                      results: seed.results || {},
                    },
                  ]),
                ),
                pointAdjustments: channel.competition.pointAdjustments || {},
              }
            : null,
        },
      ]),
    );
    return store;
  }

  const activeWeekByChannel = parsed.settings?.activeWeekByChannel || {};
  const weeks = parsed.weeks || {};

  for(const [channelId, weekId] of Object.entries(activeWeekByChannel)) {
    const week = weeks[weekId];
    if(!week) {
      continue;
    }

    store.channels[channelId] = {
      competition: {
        leagueNumber: week.leagueNumber,
        maxTimeLimitSeconds: week.maxTimeLimitSeconds,
        status: 'active',
        startedAt: week.createdAt || new Date().toISOString(),
        endedAt: null,
        playerCount: Number(week.playerCount || 0),
        registeredPlayers: week.registeredPlayers || {},
        initMessageId: null,
        seeds: Object.fromEntries(
          Object.entries(week.seeds || {}).map(([seedId, seed]) => [
            seedId,
            {
              ...seed,
              editingEnabled: seed.editingEnabled !== false,
              results: seed.results || {},
            },
          ]),
        ),
        pointAdjustments: week.pointAdjustments || {},
      },
    };
  }

  return store;
}

function ldS() {
  ensS();
  try {
    return migS(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
  } catch(error) {
    console.error('Failed to read data store, rebuilding a clean one.', error);
    const fallback = mkS();
    svS(fallback);
    return fallback;
  }
}

function svS(store) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
}

function nn(name) {
  return String(name).trim().toLowerCase();
}

function pT(value) {
  if(!value) {
    throw new Error('Time is required.');
  }

  const match = value.trim().match(/^(\d+):(\d{2})\.(\d{3})$/);
  if(!match) {
    throw new Error('Use mm:ss.mmm for time.');
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const milliseconds = Number(match[3]);

  if(seconds > 59) {
    throw new Error('Seconds must be between 0 and 59.');
  }

  return minutes * 60 * 1000 + seconds * 1000 + milliseconds;
}

function fT(totalSeconds) {
  if(totalSeconds === null || totalSeconds === undefined) {
    return 'n/a';
  }

  const safeMilliseconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeMilliseconds / 60000);
  const seconds = Math.floor((safeMilliseconds % 60000) / 1000);
  const milliseconds = safeMilliseconds % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function gDU(value) {
  return value?.discordUsername || value?.username || 'Unknown User';
}

function gPid(value) {
  return value?.userId || value?.id || null;
}

function gIgn(value) {
  return value?.ign || gDU(value);
}

function fPN(value) {
  const ign = gIgn(value);
  const discordUsername = gDU(value);
  return ign === discordUsername ? ign : `${ign}(${discordUsername})`;
}

function mkRegMsg(c) {
  const players = gRegs(c);
  const lines = [
    `**${fCL(c)} Registration**`,
    `Status: ${c.registrationOpen ? 'open' : 'closed'}`,
  ];

  if(players.length === 0) {
    lines.push('1. [no registered players]');
    return lines.join('\n');
  }

  for(let index = 0; index < players.length; index += 1) {
    lines.push(`${index + 1}. ${fPN(players[index])}`);
  }

  return lines.join('\n');
}

async function uRegMsg(channel, c) {
  if(!channel || !c?.registrationMessageId) {
    return;
  }

  try {
    const message = await channel.messages.fetch(c.registrationMessageId);
    await message.edit(mkRegMsg(c));
  } catch(error) { 
      //ignore
  }
}

async function cRegMsg(channel, c) {
  if(!channel) {
    return;
  }

  const message = await channel.send(mkRegMsg(c));
  await message.pin().catch(() => {});
  c.registrationMessageId = message.id;
}

async function uPinMsg(channel, c) {
  if(!channel || !c?.registrationMessageId) {
    return;
  }

  try {
    const message = await channel.messages.fetch(c.registrationMessageId);
    await message.unpin().catch(() => {});
  } catch(error) {  
      //ignore
    }
}

async function dMsg(channel, messageId) {
  if(!channel || !messageId) {
    return;
  }

  try {
    const message = await channel.messages.fetch(messageId);
    await message.delete().catch(() => {});
  } catch(error) {
      //ignore
    }
}

async function dCompMsgs(channel, c) {
  if(!channel || !c) {
    return;
  }

  await dMsg(channel, c.initMessageId);
  await dMsg(channel, c.registrationMessageId);
}

function fOV(option) {
  if(!option) {
    return '';
  }

  switch(option.type) {
    case 'USER':
      return option.user?.tag || option.user?.username || option.value;
    case 'CHANNEL':
    case 'ROLE':
    case 'MENTIONABLE':
      return option.value;
    case 'BOOLEAN':
      return option.value ? 'true' : 'false';
    default:
      return String(option.value);
  }
}

function fCU(interaction) {
  const options = interaction.options?.data || [];
  if(options.length === 0) {
    return `/${interaction.commandName}`;
  }

  const formattedOptions = options
    .map((option) => `${option.name}: ${fOV(option)}`)
    .join(', ');

  return `/${interaction.commandName} ${formattedOptions}`;
}

async function logCmd(interaction, store) {
  if(!store.settings?.loggingEnabled || !interaction.guild) {
    return;
  }

  const logChannel = interaction.guild.channels.cache.find((channel) => channel.name === 'ranked-bot-logs' && channel.isText());
  if(!logChannel) {
    return;
  }

  const timestamp = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  const username = interaction.user.tag || interaction.user.username;
  const commandText = fCU(interaction);

  await logChannel.send(`User: ${username}\nTime: ${timestamp}\nCommand: ${commandText}`).catch(() => {});
}

function iA(interaction) {
  const memberRoles = interaction.member?.roles?.cache;
  return Boolean(memberRoles && memberRoles.some((role) => /^league administrator$/i.test(role.name.trim())));
}

function iCS(interaction) {
  const memberRoles = interaction.member?.roles?.cache;
  return Boolean(memberRoles && memberRoles.some((role) => /^cmd spam$/i.test(role.name.trim())));
}

function gLM(interaction) {
  const memberRoles = interaction.member?.roles?.cache;
  if(!memberRoles) {
    throw new Error('This command can only be used inside a server.');
  }

  const leagueRole = memberRoles.find((role) => /^league\s+[1-6]$/i.test(role.name.trim()));
  if(!leagueRole) {
    throw new Error('You do not have a League role.');
  }

  return Number(leagueRole.name.trim().match(/^league\s+([1-6])$/i)[1]);
}

function gLC(interaction, competition, admin) {
  if(admin) {
    return competition.leagueNumber;
  }
  return gLM(interaction);
}

function gLim(store, leagueNumber) {
  const limit = Number(store.settings.leagueLimits[String(leagueNumber)] || store.settings.leagueLimits[leagueNumber]);
  if(!limit) {
    throw new Error(`League ${leagueNumber} is not configured.`);
  }
  return limit;
}

function gCK(interaction) {
  if(!interaction.guildId || !interaction.channelId) {
    throw new Error('This command must be used in a server channel.');
  }
  return interaction.channelId;
}

function ensC(store, channelId) {
  if(!store.channels[channelId]) {
    store.channels[channelId] = { competition: null };
  }
  return store.channels[channelId];
}

function nC(competition) {
  if(!competition) {
    return null;
  }

  competition.status = competition.status || 'active';
  competition.seeds = competition.seeds || {};
  competition.pointAdjustments = competition.pointAdjustments || {};
  competition.currentSeedKey = competition.currentSeedKey || null;
  competition.registeredPlayers = competition.registeredPlayers || {};
  competition.registrationMessageId = competition.registrationMessageId || null;
  competition.initMessageId = competition.initMessageId || null;
  competition.manualPromotionCount = Number.isInteger(competition.manualPromotionCount) ? competition.manualPromotionCount : null;
  competition.manualDemotionCount = Number.isInteger(competition.manualDemotionCount) ? competition.manualDemotionCount : null;
  if(typeof competition.movementsApplied !== 'boolean') {
    competition.movementsApplied = false;
  }
  if(competition.maxTimeLimitSeconds && competition.maxTimeLimitSeconds < 1000 * 60) {
    competition.maxTimeLimitSeconds *= 1000;
  }
  if(typeof competition.registrationOpen !== 'boolean') {
    competition.registrationOpen = true;
  }

  for(const player of Object.values(competition.registeredPlayers)) {
    player.discordUsername = gDU(player);
    player.ign = gIgn(player);
  }

  for(const seed of Object.values(competition.seeds)) {
    seed.results = seed.results || {};
    seed.playerCount = Number(seed.playerCount || Object.keys(seed.results).length || 0);
    if(seed.timeLimitSeconds && seed.timeLimitSeconds < 1000 * 60) {
      seed.timeLimitSeconds *= 1000;
    }
    if(typeof seed.editingEnabled !== 'boolean') {
      seed.editingEnabled = true;
    }

    for(const entry of Object.values(seed.results)) {
      entry.discordUsername = gDU(entry);
      entry.ign = gIgn(entry);
      if(typeof entry.timeSeconds === 'number' && entry.timeSeconds < 1000 * 60) {
        entry.timeSeconds *= 1000;
      }
    }
  }

  sCR(competition);

  return competition;
}

function gComp(store, channelId) {
  const channel = ensC(store, channelId);
  return nC(channel.competition);
}

function rC(store, channelId) {
  const competition = gComp(store, channelId);
  if(!competition) {
    throw new Error('This channel does not have a competition yet. Use /nm to create one.');
  }
  return competition;
}

function rA(store, channelId) {
  const competition = rC(store, channelId);
  if(competition.status !== 'active') {
    throw new Error('This competition has ended. Reset it before starting a new one.');
  }
  return competition;
}

function gSeed(competition, seedName) {
  return competition.seeds[nn(seedName)];
}

function gCurS(competition) {
  const numericSeeds = Object.values(competition.seeds).filter((seed) => /^\d+$/.test(String(seed.name).trim()));

  if(numericSeeds.length === 0) {
    if(!competition.currentSeedKey) {
      return null;
    }

    return competition.seeds[competition.currentSeedKey] || null;
  }

  numericSeeds.sort((left, right) => Number(left.name) - Number(right.name));
  return numericSeeds[numericSeeds.length - 1];
}

function gNS(competition) {
  const numericSeeds = Object.values(competition.seeds)
    .map((seed) => String(seed.name).trim())
    .filter((name) => /^\d+$/.test(name))
    .map((name) => Number(name));

  if(numericSeeds.length === 0) {
    return '1';
  }

  return String(Math.max(...numericSeeds) + 1);
}

function gRS(competition, seedName) {
  return seedName ? gSeed(competition, seedName) : gCurS(competition);
}

function gRegs(competition) {
  return Object.values(competition.registeredPlayers || {}).sort((left, right) => {
    const leftRegisteredAt = left.registeredAt || '';
    const rightRegisteredAt = right.registeredAt || '';
    if(leftRegisteredAt !== rightRegisteredAt) {
      return leftRegisteredAt.localeCompare(rightRegisteredAt);
    }
    return fPN(left).localeCompare(fPN(right));
  });
}

function mkDR(competition) {
  return Object.fromEntries(
    gRegs(competition).map((player) => [
      player.userId,
      {
        userId: player.userId,
        username: player.discordUsername,
        discordUsername: player.discordUsername,
        ign: player.ign,
        dnf: true,
        placement: null,
        timeSeconds: null,
        submittedAt: null,
      },
    ]),
  );
}

function gRC(competition) {
  return gRegs(competition).length;
}

function sSR(competition, seed) {
  seed.results = seed.results || {};
  seed.playerCount = gRC(competition);

  for(const player of gRegs(competition)) {
    if(!seed.results[player.userId]) {
      seed.results[player.userId] = {
        userId: player.userId,
        username: player.discordUsername,
        discordUsername: player.discordUsername,
        ign: player.ign,
        dnf: true,
        placement: null,
        timeSeconds: null,
        submittedAt: null,
      };
      continue;
    }

    seed.results[player.userId].username = player.discordUsername;
    seed.results[player.userId].discordUsername = player.discordUsername;
    seed.results[player.userId].ign = player.ign;
  }
}

function sCR(competition) {
  for(const seed of Object.values(competition.seeds)) {
    sSR(competition, seed);
  }
}

function iRP(competition, userId) {
  return Boolean(competition.registeredPlayers?.[userId]);
}

function rmRP(competition, userId) {
  const registeredPlayer = competition.registeredPlayers?.[userId] || null;
  if(!registeredPlayer) {
    return null;
  }

  delete competition.registeredPlayers[userId];

  for(const seed of Object.values(competition.seeds)) {
    delete seed.results[userId];
    seed.playerCount = Math.max(0, seed.playerCount - 1);
  }

  delete competition.pointAdjustments[userId];
  return registeredPlayer;
}

function gSE(seed) {
  return Object.values(seed.results || {});
}

function gSD(competition, seed) {
  const participantCount = seed.playerCount || gRC(competition);
  const entries = gSE(seed).map((entry) =>({
    ...entry,
    effectiveTimeSeconds: entry.dnf ? seed.timeLimitSeconds : entry.timeSeconds,
  }));
  const finishers = entries
    .filter((entry) => !entry.dnf && typeof entry.timeSeconds === 'number')
    .sort((left, right) => {
      if(left.timeSeconds !== right.timeSeconds) {
        return left.timeSeconds - right.timeSeconds;
      }
      return fPN(left).localeCompare(fPN(right));
    })
    .map((entry) =>({ ...entry }));

  let currentPlacement = 0;
  let previousTimeSeconds = null;

  for(let index = 0; index < finishers.length; index += 1) {
    const entry = finishers[index];
    if(previousTimeSeconds === null || entry.timeSeconds !== previousTimeSeconds) {
      currentPlacement = index + 1;
      previousTimeSeconds = entry.timeSeconds;
    }

    entry.placement = currentPlacement;
    entry.seedPoints = participantCount - currentPlacement + 1;
  }

  const tieCounts = new Map();
  for(const entry of finishers) {
    tieCounts.set(entry.placement,(tieCounts.get(entry.placement) || 0) + 1);
  }

  for(const entry of finishers){
    entry.placementLabel = tieCounts.get(entry.placement) > 1 ? `T${entry.placement}` : `${entry.placement}`;
  }

  const dnfs = entries
    .filter((entry) => entry.dnf || typeof entry.timeSeconds !== 'number')
    .sort((left, right) => fPN(left).localeCompare(fPN(right)))
    .map((entry) => ({
      ...entry,
      placement: null,
      placementLabel: null,
      seedPoints: 0,
    }));

  return [...finishers, ...dnfs];
}

function formatPlacement(entry){
  return entry?.placementLabel || (typeof entry?.placement === 'number' ? `${entry.placement}` : 'dnf');
}

function gLB(competition){
  const competitors = new Map();

  for(const player of gRegs(competition)){
    competitors.set(player.userId,{
      userId: player.userId,
      username: player.discordUsername,
      discordUsername: player.discordUsername,
      ign: player.ign,
      computedPoints: 0,
      manualAdjustment: 0,
      totalPoints: 0,
      seedCount: 0,
      totalEffectiveTimeSeconds: 0,
      averageTimeSeconds: null,
      dnfCount: 0,
    });
  }

  for(const seed of Object.values(competition.seeds)){
    for(const entry of gSD(competition, seed)){
      if(!competitors.has(entry.userId)){
        competitors.set(entry.userId,{
          userId: entry.userId,
          username: gDU(entry),
          discordUsername: gDU(entry),
          ign: gIgn(entry),
          computedPoints: 0,
          manualAdjustment: 0,
          totalPoints: 0,
          seedCount: 0,
          totalEffectiveTimeSeconds: 0,
          averageTimeSeconds: null,
          dnfCount: 0,
        });
      }

      const competitor = competitors.get(entry.userId);
      competitor.username = gDU(entry);
      competitor.discordUsername = gDU(entry);
      competitor.ign = gIgn(entry);
      competitor.computedPoints += entry.seedPoints;
      competitor.seedCount += 1;
      competitor.totalEffectiveTimeSeconds += entry.effectiveTimeSeconds;
      if(entry.dnf){
        competitor.dnfCount += 1;
      }
    }
  }

  for(const [userId, adjustment] of Object.entries(competition.pointAdjustments ||{})){
    if(!competitors.has(userId)){
        competitors.set(userId,{
          userId,
          username: `Unknown User (${userId})`,
          discordUsername: `Unknown User (${userId})`,
          ign: `Unknown User (${userId})`,
          computedPoints: 0,
        manualAdjustment: 0,
        totalPoints: 0,
        seedCount: 0,
        totalEffectiveTimeSeconds: 0,
        averageTimeSeconds: null,
        dnfCount: 0,
      });
    }
    competitors.get(userId).manualAdjustment += adjustment;
  }

  return Array.from(competitors.values())
    .map((competitor) => ({
      ...competitor,
      averageTimeSeconds: competitor.seedCount > 0 ? competitor.totalEffectiveTimeSeconds / competitor.seedCount : null,
      totalPoints: competitor.computedPoints + competitor.manualAdjustment,
    }))
    .sort((left, right) => {
      if(left.totalPoints !== right.totalPoints){
        return right.totalPoints - left.totalPoints;
      }
      const leftAverage = left.averageTimeSeconds ?? Number.MAX_SAFE_INTEGER;
      const rightAverage = right.averageTimeSeconds ?? Number.MAX_SAFE_INTEGER;
      if(leftAverage !== rightAverage){
        return leftAverage - rightAverage;
      }
      return fPN(left).localeCompare(fPN(right));
    });
}

function gCS(competition, userId){
  return gLB(competition).find((entry) => entry.userId === userId) || null;
}

function gDS(competition){
  return Object.values(competition.seeds).reduce(
    (maxSize, seed) => Math.max(maxSize, seed.playerCount || 0),
    gRC(competition),
  );
}

function gLR(guild, leagueNumber){
  return guild.roles.cache.find((role) => role.name.trim().toLowerCase() === `league ${leagueNumber}`);
}

function gAR(guild){
  return guild.roles.cache.find((role) => role.name.trim().toLowerCase() === 'league administrator');
}

function tLB(left, right){
  if(!left || !right){
    return false;
  }
  return left.totalPoints === right.totalPoints && left.averageTimeSeconds === right.averageTimeSeconds;
}

function xTop(entries, count){
  if(count <= 0 || entries.length === 0){
    return [];
  }

  const selected = entries.slice(0, Math.min(count, entries.length));
  let boundaryIndex = selected.length - 1;

  while(boundaryIndex + 1 < entries.length && tLB(entries[boundaryIndex], entries[boundaryIndex + 1])){
    boundaryIndex += 1;
    selected.push(entries[boundaryIndex]);
  }

  return selected;
}

function xBot(entries, count){
  if(count <= 0 || entries.length === 0){
    return [];
  }

  const startIndex = Math.max(0, entries.length - count);
  const selected = entries.slice(startIndex);
  let boundaryIndex = startIndex;

  while(boundaryIndex > 0 && tLB(entries[boundaryIndex], entries[boundaryIndex - 1])){
    boundaryIndex -= 1;
    selected.unshift(entries[boundaryIndex]);
  }

  return selected;
}

function gMP(competition){
  const leaderboard = gLB(competition);
  const defaultMoveCount = Math.ceil(leaderboard.length * 0.1);
  const promotionMoveCount = Math.max(0, competition.manualPromotionCount ?? defaultMoveCount);
  const demotionMoveCount = Math.max(0, competition.manualDemotionCount ?? defaultMoveCount);
  const results = { leaderboard, promotions: [], demotions: [] };

  if(promotionMoveCount === 0 && demotionMoveCount === 0){
    return results;
  }

  const promotionPool = leaderboard;
  const basePromotions = competition.leagueNumber > 1 ? xTop(promotionPool, promotionMoveCount) : [];
  const promotedIds = new Set(basePromotions.map((entry) => entry.userId));
  const demotionPool = leaderboard.filter((entry) => !promotedIds.has(entry.userId));
  const baseDemotions = competition.leagueNumber < 6 ? xBot(demotionPool, demotionMoveCount) : [];
  const allDnfDemotions =
    competition.leagueNumber < 6
      ? demotionPool.filter((entry) => entry.seedCount > 0 && entry.dnfCount === entry.seedCount)
      : [];
  const demotionMap = new Map([...baseDemotions, ...allDnfDemotions].map((entry) => [entry.userId, entry]));

  let expanded = true;
  while(expanded){
    expanded = false;

    for(const entry of demotionPool){
      if(demotionMap.has(entry.userId)){
        continue;
      }

      for(const demotedEntry of demotionMap.values()){
        if(tLB(entry, demotedEntry)){
          demotionMap.set(entry.userId, entry);
          expanded = true;
          break;
        }
      }
    }
  }

  results.promotions = basePromotions;
  results.demotions = Array.from(demotionMap.values());
  return results;
}

async function applyLeagueMovements(interaction, competition){
  const guild = interaction.guild;

  if(!guild){
    throw new Error('League movements can only run in a server.');
  }

  const movementPlan = gMP(competition);
  const results = { promoted: [], demoted: [], skipped: [] };
  const sourceRole = gLR(guild, competition.leagueNumber);
  const promoteRole = competition.leagueNumber > 1 ? gLR(guild, competition.leagueNumber - 1) : null;
  const demoteRole = competition.leagueNumber < 6 ? gLR(guild, competition.leagueNumber + 1) : null;

  for(const entry of movementPlan.promotions){
    try{
      const member = await guild.members.fetch(entry.userId);
      if(sourceRole){
        await member.roles.remove(sourceRole).catch(() => {});
      }
      await member.roles.add(promoteRole);
      results.promoted.push(fPN(entry));
    } catch(error){
      results.skipped.push(`${fPN(entry)} (promotion failed)`);
    }
  }

  for(const entry of movementPlan.demotions){
    try{
      const member = await guild.members.fetch(entry.userId);
      if(sourceRole){
        await member.roles.remove(sourceRole).catch(() => {});
      }
      await member.roles.add(demoteRole);
      results.demoted.push(fPN(entry));
    } catch(error){
      results.skipped.push(`${fPN(entry)} (demotion failed)`);
    }
  }

  return results;
}

function fCL(competition){
  return `League ${competition.leagueNumber}`;
}

function fCS(competition){
  return competition.status === 'ended' ? 'ended' : 'active';
}

function fMV(movementPlan){
  return [
    movementPlan.promotions.length > 0
      ? `Promoting: ${movementPlan.promotions.map((entry) => fPN(entry)).join(', ')}`
      : 'Promoting: none',
    movementPlan.demotions.length > 0
      ? `Demoting: ${movementPlan.demotions.map((entry) => fPN(entry)).join(', ')}`
      : 'Demoting: none',
  ];
}

function fLB(competition){
  const movementPlan = gMP(competition);
  const leaderboard = movementPlan.leaderboard;
  const currentSeed = gCurS(competition);
  const displaySize = gDS(competition);
  const promotionCount = movementPlan.promotions.length;
  const demotionCount = movementPlan.demotions.length;
  const demotionStartRank = leaderboard.length - demotionCount + 1;
  const breakRanks = new Set();

  if(promotionCount > 0 && promotionCount < leaderboard.length){
    breakRanks.add(promotionCount);
  }
  if(demotionCount > 0 && demotionStartRank > 1 && demotionStartRank <= leaderboard.length){
    breakRanks.add(demotionStartRank - 1);
  }

  if(leaderboard.length === 0 && displaySize === 0){
    return `**${fCL(competition)}** has no submitted results yet.`;
  }

  const lines = [];

  for(let rank = 1; rank <= displaySize; rank += 1){
    const entry = leaderboard[rank - 1];
    lines.push(entry ? `${rank}. ${fPN(entry)} - ${entry.totalPoints} pts - ${fT(entry.averageTimeSeconds)}` : `${rank}. [empty]`);

    if(breakRanks.has(rank)){
      lines.push('-----');
    }
  }

  const header = [`**${fCL(competition)} Week ${competition.week} Leaderboard**`, `Status: ${fCS(competition)}`];

  if(currentSeed){
    header.push(`Current seed: ${currentSeed.name}`);
  }

  return [...header, ...lines].join('\n');
}

function fFR(competition){
  const movementPlan = gMP(competition);
  const leaderboard = movementPlan.leaderboard;

  if(leaderboard.length === 0){
    return `League ${competition.leagueNumber} results:\nNo final results recorded.`;
  }

  const promotionCount = movementPlan.promotions.length;
  const demotionCount = movementPlan.demotions.length;
  const middleStart = promotionCount;
  const middleEnd = Math.max(middleStart, leaderboard.length - demotionCount);
  const lines = [`League ${competition.leagueNumber} results:`];

  const pushSection =(entries, startIndex) =>{
    for(let i = 0; i < entries.length; i += 1){
      const entry = entries[i];
      lines.push(`${startIndex + i + 1}. ${fPN(entry)} - ${entry.totalPoints} pts - ${fT(entry.averageTimeSeconds)}`);
    }
  };

  pushSection(leaderboard.slice(0, promotionCount), 0);

  if(promotionCount > 0 && middleEnd > middleStart){
    lines.push('-----');
  }

  pushSection(leaderboard.slice(middleStart, middleEnd), middleStart);

  if(demotionCount > 0 && middleEnd < leaderboard.length){
    lines.push('-----');
  }

  pushSection(leaderboard.slice(middleEnd), middleEnd);
  lines.push(...fMV(movementPlan));

  return lines.join('\n');
}

function chunkMsg(text, maxLength = 2000){
  if(!text || text.length <= maxLength){
    return [text];
  }

  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for(const line of lines){
    const next = current ? `${current}\n${line}` : line;
    if(next.length <= maxLength){
      current = next;
      continue;
    }

    if(current){
      chunks.push(current);
    }

    if(line.length <= maxLength){
      current = line;
      continue;
    }

    for(let index = 0; index < line.length; index += maxLength){
      chunks.push(line.slice(index, index + maxLength));
    }
    current = '';
  }

  if(current){
    chunks.push(current);
  }

  return chunks;
}

function fSR(competition, seed){
  const standings = gSD(competition, seed);

  if(standings.length === 0){
    return `**${seed.name}** in ${fCL(competition)} has no submitted results yet.\nSeed time limit: ${fT(seed.timeLimitSeconds)}`;
  }

  const finishers = standings.filter((entry) => !entry.dnf);
  const dnfs = standings.filter((entry) => entry.dnf);
  const lines = [];

  for(const entry of finishers){
    lines.push(`${formatPlacement(entry)}. ${fPN(entry)} - ${entry.seedPoints} pts - ${fT(entry.timeSeconds)}`);
  }

  for(const entry of dnfs){
    lines.push(`${fPN(entry)}: dnf - ${entry.seedPoints} pts`);
  }

  return [`Seed **${seed.name}** results for ${fCL(competition)}`, `Seed time limit: ${fT(seed.timeLimitSeconds)}`, ...lines].join('\n');
}

function fMP(competition, entry, username){
  if(!entry){
    return `You do not have any points yet for **${fCL(competition)}**.`;
  }

  const adjustmentText = entry.manualAdjustment === 0 ? '0' : `${entry.manualAdjustment > 0 ? '+' : ''}${entry.manualAdjustment}`;

  return [
    `**${username}** in ${fCL(competition)}`,
    `Total points: ${entry.totalPoints}`,
    `Seed points: ${entry.computedPoints}`,
    `Manual adjustment: ${adjustmentText}`,
    `Average time: ${fT(entry.averageTimeSeconds)}`,
    `Seeds submitted: ${entry.seedCount}`,
    `DNFs: ${entry.dnfCount}`,
  ].join('\n');
}

function fPS(competition, user){
  const lines = [];
  const displayPlayer = competition.registeredPlayers?.[user.id] ||{ discordUsername: user.username, ign: user.username };

  for(const seed of Object.values(competition.seeds).sort((left, right) => left.name.localeCompare(right.name))){
    const entry = gSD(competition, seed).find((seedEntry) => seedEntry.userId === user.id);
    if(!entry){
      continue;
    }
    lines.push(entry.dnf ? `${seed.name}: dnf` : `${seed.name}: ${formatPlacement(entry)} - ${fT(entry.timeSeconds)}`);
  }

  if(lines.length === 0){
    return `${user.username} has no recorded results.`;
  }

  return [`**${fPN(displayPlayer)}** placements in ${fCL(competition)}`, `Status: ${fCS(competition)}`, ...lines].join('\n');
}

function fST(competition, user, entry){
  const placements = [];
  const displayPlayer = competition.registeredPlayers?.[user.id] || entry || { discordUsername: user.username, ign: user.username };

  for(const seed of Object.values(competition.seeds).sort((left, right) => left.name.localeCompare(right.name))){
    const seedEntry = gSD(competition, seed).find((standingEntry) => standingEntry.userId === user.id);
    if(!seedEntry){
      continue;
    }
    placements.push(seedEntry.dnf ? `${seed.name}: dnf` : `${seed.name}: ${formatPlacement(seedEntry)} - ${fT(seedEntry.timeSeconds)}`);
  }

  if(!entry && placements.length === 0){
    return `${user.username} has no recorded results in ${fCL(competition)}.`;
  }

  return [
    `**${fPN(displayPlayer)}** in ${fCL(competition)}`,
    `Total points: ${entry ? entry.totalPoints : 0}`,
    `Average time: ${fT(entry ? entry.averageTimeSeconds : null)}`,
    `DNFs: ${entry ? entry.dnfCount : 0}`,
    placements.length > 0 ? 'Placements:' : 'Placements: none',
    ...placements,
  ].join('\n');
}

function mkRB(channelId, userId){
  return [
    new MessageActionRow().addComponents(
      new MessageButton().setCustomId(`confirm_reset:${channelId}:${userId}`).setLabel('Confirm Reset').setStyle('DANGER'),
      new MessageButton().setCustomId(`cancel_reset:${channelId}:${userId}`).setLabel('Cancel').setStyle('SECONDARY'),
    ),
  ];
}

function aSR(seed, user, timeSeconds, dnf){
  const userId = gPid(user);
  if(!userId){
    throw new Error('Could not determine player id for this result.');
  }

  const existingEntry = seed.results[userId];

  seed.results[userId] ={
    userId,
    username: gDU(user),
    discordUsername: gDU(user),
    ign: gIgn(user),
    dnf,
    placement: null,
    timeSeconds,
    submittedAt: new Date().toISOString(),
  };

  return existingEntry;
}

function impM(c, seed, rows){
  const regByIgn = new Map();
  const dupIgns = [];

  for(const p of gRegs(c)){
    const key = nn(gIgn(p));
    if(regByIgn.has(key)){
      dupIgns.push(gIgn(p));
      continue;
    }
    regByIgn.set(key, p);
  }

  if(dupIgns.length > 0){
    throw new Error(`Cannot import while duplicate IGNs are registered: ${dupIgns.join(', ')}`);
  }

  seed.results = mkDR(c);
  const used = new Set();
  const matched = [];
  const missing = [];

  for(const row of rows){
    const p = regByIgn.get(nn(row.playerName));
    if(!p || used.has(p.userId)){
      missing.push(row.playerName);
      continue;
    }

    aSR(seed, p, row.dnf ? null : row.timeMs, Boolean(row.dnf));
    used.add(p.userId);
    matched.push({
      name: fPN(p),
      dnf: Boolean(row.dnf),
      timeMs: row.timeMs,
    });
  }

  seed.playerCount = gRC(c);
  return { matched, missing };
}

async function getUserDataFromDiscord(id) {
  try{
      const response=await fetch(`https://api.mcsrranked.com/users/discord.${id}`);
      if(!response.ok){
        throw new Error(`Network error: ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch(err){
      throw new Error('Could not find a Minecraft account linked to your discord account. For help linking your account run /link');
    }
}

const client = new Client({
  intents: [Intents.FLAGS.GUILDS],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if(interaction.isButton()){
    try{
      const [action, value1, value2] = interaction.customId.split(':');

      if(!action){
        return;
      }

      const channelId = value1;
      const userId = value2;

      if(!channelId || !userId){
        return;
      }

      if(interaction.user.id !== userId){
        await interaction.reply({ content: 'Only the League Administrator who started this reset can use these buttons.', ephemeral: true });
        return;
      }

      if(!iA(interaction)){
        await interaction.reply({ content: 'Only users with the League Administrator role can reset a competition.', ephemeral: true });
        return;
      }

      const store = ldS();
      const channel = ensC(store, channelId);

      if(action === 'cancel_reset'){
        await interaction.update({ content: 'Competition reset cancelled.', components: [] });
        return;
      }

      if(action === 'confirm_reset'){
        if(channel.competition){
          channel.competition.registrationOpen = false;
        }
        await dCompMsgs(interaction.channel, channel.competition);
        channel.competition = null;
        svS(store);
        await interaction.update({ content: 'The current competition has been deleted.', components: [] });
      }
    } catch(error){
      console.error('Button handling failed.', error);
      await interaction.reply({ content: `${error.message}`, ephemeral: true }).catch(() =>{});
    }

    return;
  }

  if(!interaction.isCommand()){
    return;
  }

  if(iCS(interaction)){
    return;
  }

  try{
    const store = ldS();
    const admin = iA(interaction);
    let commandLogged = false;
    const originalReply = interaction.reply.bind(interaction);

    interaction.reply = async (payload) =>{
      const response = await originalReply(payload);
      if(!commandLogged && interaction.isCommand()){
        commandLogged = true;
        await logCmd(interaction, store);
      }
      return response;
    };

    if(interaction.commandName === 'nm'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can start a competition.', ephemeral: true });
        return;
      }

      const channelId = gCK(interaction);
      const channel = ensC(store, channelId);

      if(channel.competition){
        await interaction.reply({ content: `This channel already has a ${fCS(channel.competition)} competition. Use /em or /dm first.`, ephemeral: true });
        return;
      }

      const leagueNumber = interaction.options.getInteger('league', true);
      const week = interaction.options.getInteger('week', true);
      const maxTimeLimitSeconds = gLim(store, leagueNumber);

      channel.competition = {
        leagueNumber,
        week, 
        maxTimeLimitSeconds,
        status: 'active',
        startedAt: new Date().toISOString(),
        endedAt: null,
        currentSeedKey: null,
        seeds: {},
        pointAdjustments: {},
        registeredPlayers: {},
        registrationOpen: true,
        registrationMessageId: null,
        initMessageId: null,
        manualPromotionCount: null,
        manualDemotionCount: null,
        movementsApplied: false,
      };
      await cRegMsg(interaction.channel, channel.competition);
      const initMessage = await interaction.reply({
        content: `Started the current competition for League ${leagueNumber} Registration is now open. Time limit: ${fT(maxTimeLimitSeconds)}.`,
        fetchReply: true,
      });
      channel.competition.initMessageId = initMessage.id;
      svS(store);
      return;
    }

    if(interaction.commandName === 'em'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can end a competition.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));

      if(competition.status === 'ended'){
        await interaction.reply({ content: 'This competition is already ended.', ephemeral: true });
        return;
      }

      competition.status = 'ended';
      competition.endedAt = new Date().toISOString();
      competition.movementsApplied = false;
      await uPinMsg(interaction.channel, competition);
      svS(store);

      const messages = chunkMsg(fFR(competition));
      await interaction.reply(messages[0]);
      for(let index = 1; index < messages.length; index += 1){
        await interaction.followUp(messages[index]);
      }
      return;
    }

    if(interaction.commandName === 'dm'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can reset a competition.', ephemeral: true });
        return;
      }

      const channelId = gCK(interaction);
      const competition = rC(store, channelId);

      await interaction.reply({
        content: 'Resetting will delete the current competition and all of its seeds, results, and point adjustments. Are you sure?',
        components: mkRB(channelId, interaction.user.id),
        ephemeral: true,
      });
      return;
    }
  
    if(interaction.commandName === 'ns'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can create seeds.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      const seedName = gNS(competition);
      const seedKey = nn(seedName);

      if(gRC(competition) < 1){
        await interaction.reply({ content: 'At least one player must be registered before creating a seed.', ephemeral: true });
        return;
      }

      if(competition.seeds[seedKey]){
        await interaction.reply({ content: `Seed **${competition.seeds[seedKey].name}** already exists in ${fCL(competition)}.`, ephemeral: true });
        return;
      }

      competition.seeds[seedKey] = {
        name: seedName,
        playerCount: gRC(competition),
        timeLimitSeconds: competition.maxTimeLimitSeconds,
        editingEnabled: true,
        createdAt: new Date().toISOString(),
        results: mkDR(competition),
      };
      competition.currentSeedKey = seedKey;
      svS(store);

      await interaction.reply(`Created new seed **${seedName}**.`);
      return;
    }

    if(interaction.commandName === 'import'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can import match data.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      if(!commandLogged && interaction.isCommand()){
        commandLogged = true;
        await logCmd(interaction, store);
      }

      const competition = rA(store, gCK(interaction));
      const seedName = interaction.options.getInteger('seed');
      const seed = gRS(competition, seedName);

      if(!seed){
        await interaction.editReply(
          seedName
            ? `Seed **${seedName}** does not exist in ${fCL(competition)}.`
            : `There is no current seed in ${fCL(competition)} yet.`,
        );
        return;
      }

      const matchId = interaction.options.getString('match_id', true).trim();
      const response = await getMatchData(matchId);
      const rows = parseResponse(response, seed.timeLimitSeconds);
      const result = impM(competition, seed, rows);
      svS(store);

      const lines = [
        `Imported match **${matchId}** into seed **${seed.name}**.`,
        `Matched ${result.matched.length}/${gRC(competition)} registered players.`,
      ];

      if(result.missing.length > 0){
        lines.push(`Unmatched MCSR names: ${result.missing.join(', ')}`);
      }
      
      const results = [];
      i = 1
      for (const player of result.matched){
        results.push({
          playerName: player.name.split("(")[0],
          pointsWon: player.dnf ? 0 : gRC(competition) - i + 1,
          timeMs: player.timeMs,
          placement: i,
        })
        i++
      }
      
      try {
        const request = await fetch(WEBSITE_URL + "/api/write/match", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": WEBSITE_API_KEY
        },
        body: JSON.stringify({
          "weekNumber": Number(competition.week),
          "matchNumber": Number(seed.name),
          "leagueTier": Number(competition.leagueNumber),
          "rankedMatchId": matchId,
          "results": results,
        }),
      });
        if (!request.ok) {
          throw new Error(`${request.status} error, could not import match data to website.`);
        }
      } catch (error) {
        console.log(error.stack);
        throw new Error(`${error.message} - Failed to post match ${matchId}`);
      }

      await interaction.editReply(lines.join('\n'));
      return;
    }

    if(interaction.commandName === 'link'){
      const link1 = new MessageAttachment('/home/container/Images/Profile1.png', 'link_step1.png');
      const link2 = new MessageAttachment('/home/container/Images/Profile2.png', 'link_step2.png');
      const link3 = new MessageAttachment('/home/container/Images/Profile3.png', 'link_step3.png');
      await interaction.reply({
        content: 'Link your discord by following the red arrows:',
        files: [link1, link2, link3],
        ephemeral: true,
      });

      return;
    }


    if(interaction.commandName === 'reg'){
      const competition = rA(store, gCK(interaction));
      const leagueNumber = gLC(interaction, competition, admin);

      if(competition.leagueNumber !== leagueNumber){
        await interaction.reply({ content: `This channel is running League ${competition.leagueNumber}. You are in League ${leagueNumber}.`, ephemeral: true });
        return;
      }

      if(!competition.registrationOpen){
        await interaction.reply({ content: `Registration is currently closed.`, ephemeral: true });
        return;
      }

      if(iRP(competition, interaction.user.id)){
        await interaction.reply({ content: `You are already registered.`, ephemeral: true });
        return;
      }

      const userData = await getUserDataFromDiscord(interaction.user.id);
      const ign = userData.data.nickname;

      competition.registeredPlayers[interaction.user.id] = {
        userId: interaction.user.id,
        username: interaction.user.username,
        discordUsername: interaction.user.username,
        ign: ign,
        registeredAt: new Date().toISOString(),
      };
      sCR(competition);
      await uRegMsg(interaction.channel, competition);
      svS(store);

      await interaction.reply(
        { content: `Registered **${fPN(competition.registeredPlayers[interaction.user.id])}** for ${fCL(competition)}.`, ephemeral: true },
      );
      return;
    }

    if(interaction.commandName === 'admin_reg'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can register a player.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      const targetUser = interaction.options.getUser('user', true);
      const ign = interaction.options.getString('ign', true).trim();

      if(iRP(competition, targetUser.id)){
        await interaction.reply({ content: `${targetUser.username} is already registered.`, ephemeral: true });
        return;
      }

      competition.registeredPlayers[targetUser.id] = {
        userId: targetUser.id,
        username: targetUser.username,
        discordUsername: targetUser.username,
        ign,
        registeredAt: new Date().toISOString(),
      };
      sCR(competition);
      await uRegMsg(interaction.channel, competition);
      svS(store);

      await interaction.reply({ content: `Registered **${fPN(competition.registeredPlayers[targetUser.id])}** for ${fCL(competition)}.`, ephemeral: true });
      return;
    }

    if(interaction.commandName === 'unreg'){
      const competition = rA(store, gCK(interaction));
      const registeredPlayer = competition.registeredPlayers[interaction.user.id];

      if(!registeredPlayer){
        await interaction.reply({ content: 'You are not currently registered for this competition.', ephemeral: true });
        return;
      }

      if(!competition.registrationOpen){
        await interaction.reply({ content: 'Please request to be removed by an admin.', ephemeral: true });
        return;
      }

      rmRP(competition, interaction.user.id);
      await uRegMsg(interaction.channel, competition);
      svS(store);

      await interaction.reply({ content: `Unregistered **${fPN(registeredPlayer)}** from ${fCL(competition)}.`, ephemeral: true });
      return;
    }

    if(interaction.commandName === 'remove'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can remove a player.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      const targetUser = interaction.options.getUser('user', true);
      const removedPlayer = rmRP(competition, targetUser.id);

      if(!removedPlayer){
        await interaction.reply({ content: `${targetUser.username} is not currently registered for this competition.`, ephemeral: true });
        return;
      }

      await uRegMsg(interaction.channel, competition);
      svS(store);

      await interaction.reply(`Removed **${fPN(removedPlayer)}** from ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'toggle_registration'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can change registration status.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      competition.registrationOpen = interaction.options.getBoolean('enabled', true);
      await uRegMsg(interaction.channel, competition);
      svS(store);

      await interaction.reply(`Registration is now ${competition.registrationOpen ? 'open' : 'closed'} for ${fCL(competition)}  `);
      return;
    }

    if(interaction.commandName === 'toggle_logs'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can change log status.', ephemeral: true });
        return;
      }

      store.settings.loggingEnabled = interaction.options.getBoolean('enabled', true);
      svS(store);

      await interaction.reply(`Command logging is now ${store.settings.loggingEnabled ? 'enabled' : 'disabled'}.`);
      return;
    }

    if(interaction.commandName === 'promote'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can change promotion count.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      const count = interaction.options.getInteger('count', true);

      if(count < 0){
        await interaction.reply({ content: 'Promotion count cannot be negative.', ephemeral: true });
        return;
      }

      competition.manualPromotionCount = count;
      svS(store);

      await interaction.reply(`Promotion count is now set to ${count} for ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'demote'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can change demotion count.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      const count = interaction.options.getInteger('count', true);

      if(count < 0){
        await interaction.reply({ content: 'Demotion count cannot be negative.', ephemeral: true });
        return;
      }

      competition.manualDemotionCount = count;
      svS(store);

      await interaction.reply(`Demotion count is now set to ${count} for ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'relegate'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can apply promotions and demotions.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));

      if(competition.status !== 'ended'){
        await interaction.reply({ content: 'You can only use /relegate after the match has ended.', ephemeral: true });
        return;
      }

      if(competition.movementsApplied){
        await interaction.reply({ content: 'Promotions and demotions have already been applied for this match.', ephemeral: true });
        return;
      }

      const movementResults = await applyLeagueMovements(interaction, competition);
      competition.movementsApplied = true;
      svS(store);

      const summary = [
        movementResults.promoted.length > 0 ? `Promoted: ${movementResults.promoted.join(', ')}` : 'Promoted: none',
        movementResults.demoted.length > 0 ? `Demoted: ${movementResults.demoted.join(', ')}` : 'Demoted: none',
        movementResults.skipped.length > 0 ? `Skipped: ${movementResults.skipped.join(', ')}` : null,
      ].filter(Boolean).join('\n');

      await interaction.reply(summary);
      return;
    }

    if(interaction.commandName === 'adjust'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can adjust points.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      const points = interaction.options.getInteger('points', true);
      const targetUser = interaction.options.getUser('user', true);

      if(!iRP(competition, targetUser.id)){
      await interaction.reply({ content: `${targetUser.username} is not registered for ${fCL(competition)}.`, ephemeral: true });
        return;
      }

      competition.pointAdjustments[targetUser.id] = (competition.pointAdjustments[targetUser.id] || 0) + points;
      svS(store);

      await interaction.reply(`Adjusted ${fPN(competition.registeredPlayers[targetUser.id])}'s points by ${points > 0 ? '+' : ''}${points} in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'clear'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can clear seed standings.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      const seedName = interaction.options.getInteger('seed');
      const seed = gRS(competition, seedName);

      if(!seed){
        await interaction.reply({
          content: seedName
            ? `Seed **${seedName}** does not exist in ${fCL(competition)}.`
            : `There is no current seed in ${fCL(competition)} yet.`,
          ephemeral: true,
        });
        return;
      }

      seed.results = mkDR(competition);
      svS(store);

      await interaction.reply(`Cleared all standings for seed **${seed.name}** in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'r'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can reset a player result.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      const seedName = interaction.options.getInteger('seed');
      const requestedUser = interaction.options.getUser('user');
      const targetUser = requestedUser || interaction.user;
      const seed = gRS(competition, seedName);

      if(!seed){
        await interaction.reply({
          content: seedName
            ? `Seed **${seedName}** does not exist in ${fCL(competition)}.`
            : `There is no current seed in ${fCL(competition)} yet.`,
          ephemeral: true,
        });
        return;
      }

      if(!iRP(competition, targetUser.id)){
        await interaction.reply({ content: `${targetUser.username} is not registered for ${fCL(competition)}.`, ephemeral: true });
        return;
      }

      seed.results[targetUser.id] = {
        userId: targetUser.id,
        username: gDU(competition.registeredPlayers[targetUser.id]),
        discordUsername: gDU(competition.registeredPlayers[targetUser.id]),
        ign: gIgn(competition.registeredPlayers[targetUser.id]),
        dnf: true,
        placement: null,
        timeSeconds: null,
        submittedAt: null,
      };
      svS(store);

      await interaction.reply(`Reset ${fPN(competition.registeredPlayers[targetUser.id])} to DNF for seed **${seed.name}** in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'edit'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Administrator role can edit a player seed result.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      const seedName = interaction.options.getInteger('seed');
      const targetUser = interaction.options.getUser('user', true);
      const seed = gRS(competition, seedName);

      if(!seed){
        await interaction.reply({
          content: seedName
            ? `Seed **${seedName}** does not exist in ${fCL(competition)}.`
            : `There is no current seed in ${fCL(competition)} yet.`,
          ephemeral: true,
        });
        return;
      }

      if(!iRP(competition, targetUser.id)){
        await interaction.reply({ content: `${targetUser.username} is not registered for ${fCL(competition)}.`, ephemeral: true });
        return;
      }

      sSR(competition, seed);

      const dnf = interaction.options.getBoolean('dnf') || false;
      const time = interaction.options.getString('time');

      if(!dnf && !time){
        await interaction.reply({ content: 'A completed run needs a time.', ephemeral: true });
        return;
      }
      if(dnf && time){
        await interaction.reply({ content: 'DNF entries should not include a time.', ephemeral: true });
        return;
      }

      const timeSeconds = dnf ? null : pT(time);
      if(!dnf && timeSeconds > seed.timeLimitSeconds){
        await interaction.reply({ content: `Time cannot exceed the limit of ${fT(seed.timeLimitSeconds)}.`, ephemeral: true });
        return;
      }

      aSR(
        seed,
        competition.registeredPlayers[targetUser.id] || { id: targetUser.id, discordUsername: targetUser.username, ign: targetUser.username },
        timeSeconds,
        dnf,
      );
      svS(store);

      await interaction.reply(`Updated ${fPN(competition.registeredPlayers[targetUser.id])}'s result for seed **${seed.name}** in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'lb'){
      let league = interaction.options.getInteger('league');
      let competition = "";
      if (league == null){
        league = gLM(interaction);
      }
      for (const channel of Object.keys(store.channels)){
        if (store.channels[channel]['competition'] == null) continue;
        const number = store.channels[channel]['competition']['leagueNumber'];
        if (number != league) continue;
        competition = rC(store, channel);
        break;
      }

      if (competition == ""){
        await interaction.reply("Please enter a valid league number");
      }

      const lb = fLB(competition);
      
      await interaction.reply({
        content: lb.substring(0,2000),
        ephemeral: true
      });
      if (lb.length <= 2000) return;
      await interaction.followUp({
        content: lb.substring(2001,lb.length),
        ephemeral: true
      });
      return;
    }

    if(interaction.commandName === 'stats'){
      const competition = rC(store, gCK(interaction));
      const leagueNumber = gLC(interaction, competition, admin);

      if(competition.leagueNumber !== leagueNumber){
        await interaction.reply({ content: `This channel is running League ${competition.leagueNumber}.`, ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user') || interaction.user;
      const summary = gCS(competition, targetUser.id);
      await interaction.reply(fST(competition, targetUser, summary));
      return;
    }

    if(interaction.commandName === 's'){
      const competition = rC(store, gCK(interaction));
      const seedName = interaction.options.getInteger('seed');
      const seed = gRS(competition, seedName);

      if(!seed){
        await interaction.reply({
          content: seedName
            ? `Seed **${seedName}** does not exist in ${fCL(competition)}.`
            : `There is no current seed in ${fCL(competition)} yet.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply(fSR(competition, seed));
      return;
    }

    if(interaction.commandName === 'help'){
      await interaction.reply({
        content: 'https://docs.google.com/document/d/10FpS0hHeqo5yKgIweX31PNr7h_uAD5Cm6kvbmeH4iwI/edit?usp=sharing',
        ephemeral: true,
      });
      return;
    }
  } catch(error){
    console.error('Command handling failed.', error);

    const replyPayload = {
      content: `${error.message}`,
      ephemeral: true,
    };

    if(interaction.replied || interaction.deferred){
      await interaction.followUp(replyPayload).catch(() => {});
      return;
    }

    await interaction.reply(replyPayload).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
