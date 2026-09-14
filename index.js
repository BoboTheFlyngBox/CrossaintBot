const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client, Intents, MessageActionRow, MessageButton, MessageAttachment } = require('discord.js');
const COMMANDS = require('./commands');
const { getMatchData, parseResponse, getRecentMatchesForUser } = require('./matchDataFromId');

dotenv.config();

const DATA_PATH = path.join(__dirname, 'data.json');
const PLAYER_DB_PATH = path.join(__dirname, 'players.json');
const TEST_API_PATH = path.join(__dirname, 'test-api-writes.json');
const MAX_TIME = {
  1: 13 * 60 * 1000,
  2: 15 * 60 * 1000,
  3: 17 * 60 * 1000,
  4: 20 * 60 * 1000,
  5: 25 * 60 * 1000,
  6: 30 * 60 * 1000,
  7: 60 * 60 * 1000,
};
const MAX_LEAGUE = 7;
const LOWEST_DEMOTABLE_LEAGUE = 6;
const LEAGUE_7_FAST_TIME = 25 * 60 * 1000;
const LEAGUE_7_AVG_TIME = 30 * 60 * 1000;
const CHAMPIONSHIPS = {
  2: { graceMs: 5 * 60 * 1000, eliminationRate: 0.12 },
  3: { graceMs: 7 * 60 * 1000, eliminationRate: 0.13 },
  4: { graceMs: 10 * 60 * 1000, eliminationRate: 0.16 },
  5: { graceMs: 15 * 60 * 1000, eliminationRate: 0.20 },
  6: { graceMs: 20 * 60 * 1000, eliminationRate: 0.26 },
};

const WEBSITE_URL = process.env.WEBSITE_URL
const WEBSITE_API_KEY = process.env.WEBSITE_API_KEY
const SIGNUP_CHANNEL = 'league-signups';
const SIGNUP_REVIEWER = 'croissantgamer';
const REPORT_REVIEWER_ID = '1180267018696536074';
const REPORT_CHANNEL_ID = '1514889621945716736';
const REPORT_EXPIRY_MS = 48 * 60 * 60 * 1000;
const DEMOTION_COOLDOWN_WEEKS = 2;
let apiWarnSink = null;

function gWebUrl(endpoint){
  if(!WEBSITE_URL){
    throw new Error('WEBSITE_URL is not configured.');
  }
  return `${WEBSITE_URL.replace(/\/+$/, '')}${endpoint}`;
}

async function parseWebResponse(response){
  const raw = await response.text();
  if(!raw){
    return null;
  }
  try{
    return JSON.parse(raw);
  }catch(error){
    return raw;
  }
}

async function pushToWeb(endpoint, payload, method='POST', timeoutMs=10000){
  if(!WEBSITE_API_KEY){
    throw new Error('WEBSITE_API_KEY is not configured.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(()=>controller.abort(), timeoutMs);

  try{
    const response = await fetch(gWebUrl(endpoint), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': WEBSITE_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const parsed = await parseWebResponse(response);

    if(!response.ok){
      const errorMessage =
        parsed?.error ||
        parsed?.message ||
        (typeof parsed === 'string' ? parsed : null) ||
        `${response.status} ${response.statusText}`;
      throw new Error(`Website API ${method} ${endpoint} failed: ${errorMessage}`);
    }

    return parsed;
  }catch(error){
    if(error.name === 'AbortError'){
      throw new Error(`Website API ${method} ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  }finally{
    clearTimeout(timeoutId);
  }
}

function qTestWrite(competition, endpoint, payload, method='POST'){
  const data = ldTestApi();
  data.writes.push({
    savedAt: new Date().toISOString(),
    endpoint,
    method,
    payload,
    competition: competition ? {
      leagueNumber: Number(competition.leagueNumber),
      week: Number(competition.week ?? competition.weekNumber ?? 0) || null,
      status: competition.status || 'active',
    } : null,
  });
  svTestApi(data);
}

async function pushComp(competition, endpoint, payload, method='POST', timeoutMs=10000){
  if(iCh(competition)){
    return { skipped: true };
  }
  if(iT(competition)){
    qTestWrite(competition, endpoint, payload, method);
    return { queued: true };
  }
  try{
    return await pushToWeb(endpoint, payload, method, timeoutMs);
  }catch(error){
    console.error('Website sync failed.', error);
    if(apiWarnSink){
      apiWarnSink(`Could not write to the website API for ${endpoint}.`);
    }
    return { apiError: error.message };
  }
}

function mkS() {
  return { settings: { leagueLimits: { ...MAX_TIME }, pendingDisplacements: {}, loggingEnabled: true, signupRequests: {}, scoreReports: {} }, channels: {} };
}

function mkTestApi(){
  return { writes: [] };
}

function ldTestApi(){
  if(!fs.existsSync(TEST_API_PATH)){
    svTestApi(mkTestApi());
  }

  try{
    const parsed = JSON.parse(fs.readFileSync(TEST_API_PATH, 'utf8'));
    return { writes: Array.isArray(parsed.writes) ? parsed.writes : [] };
  }catch(error){
    console.error('Failed to read test api store, rebuilding a clean one.', error);
    const fallback = mkTestApi();
    svTestApi(fallback);
    return fallback;
  }
}

function svTestApi(data){
  fs.writeFileSync(TEST_API_PATH, JSON.stringify(data, null, 2));
}

function ensS(){
  if(!fs.existsSync(DATA_PATH)){
    svS(mkS());
  }
}

function migS(parsed){
  const store = mkS();
  store.settings.leagueLimits = {
    ...store.settings.leagueLimits,
    ...(parsed.settings?.leagueLimits || {}),
  };
  for(const leagueKey of Object.keys(store.settings.leagueLimits)){
    if(store.settings.leagueLimits[leagueKey] < 1000 * 60){
      store.settings.leagueLimits[leagueKey] *= 1000;
    }
  }
  store.settings.pendingDisplacements = parsed.settings?.pendingDisplacements || {};
  store.settings.loggingEnabled = parsed.settings?.loggingEnabled !== false;
  store.settings.signupRequests = parsed.settings?.signupRequests || {};
  store.settings.scoreReports = parsed.settings?.scoreReports || {};

  if(parsed.channels){
    store.channels = Object.fromEntries(
      Object.entries(parsed.channels).map(([channelId, channel]) => [
        channelId,
        {
          testMode: channel.testMode === true,
          competition: channel.competition
            ? {
                ...channel.competition,
                status: channel.competition.status || 'active',
                playerCount: Number(channel.competition.playerCount || 0),
                registeredPlayers: channel.competition.registeredPlayers || {},
                initMessageId: channel.competition.initMessageId || null,
                initChannelId: channel.competition.initChannelId || null,
                infoChannelId: channel.competition.infoChannelId || null,
                registrationMessageIds: channel.competition.registrationMessageIds || [],
                hostUserId: channel.competition.hostUserId || null,
                hostDiscordUsername: channel.competition.hostDiscordUsername || null,
                hostIgn: channel.competition.hostIgn || null,
                hostUuid: channel.competition.hostUuid || null,
                testMode: channel.competition.testMode === true,
                finalMessageIds: channel.competition.finalMessageIds || [],
                finalChannelId: channel.competition.finalChannelId || null,
                leaderboardMessageIds: channel.competition.leaderboardMessageIds || [],
                registrationOpenBeforeEnd: channel.competition.registrationOpenBeforeEnd ?? null,
                seeds: Object.fromEntries(
                  Object.entries(channel.competition.seeds || {}).map(([seedId, seed]) => [
                    seedId,
                    {
                      ...seed,
                      editingEnabled: seed.editingEnabled !== false,
                      imported: seed.imported === true,
                      rankedMatchId: seed.rankedMatchId || null,
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

  for(const [channelId, weekId] of Object.entries(activeWeekByChannel)){
    const week = weeks[weekId];
    if(!week){
      continue;
    }

    store.channels[channelId] = {
      testMode: false,
      competition: {
        leagueNumber: week.leagueNumber,
        maxTimeLimitSeconds: week.maxTimeLimitSeconds,
        status: 'active',
        startedAt: week.createdAt || new Date().toISOString(),
        endedAt: null,
        playerCount: Number(week.playerCount || 0),
        registeredPlayers: week.registeredPlayers || {},
        initMessageId: null,
        initChannelId: null,
        infoChannelId: null,
        registrationMessageIds: [],
        finalMessageIds: [],
        finalChannelId: null,
        registrationOpenBeforeEnd: null,
        seeds: Object.fromEntries(
          Object.entries(week.seeds || {}).map(([seedId, seed]) => [
            seedId,
            {
              ...seed,
              editingEnabled: seed.editingEnabled !== false,
              rankedMatchId: seed.rankedMatchId || null,
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

function ldS(){
  ensS();
  try{
    return migS(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
  } catch(error){
    console.error('Failed to read data store, rebuilding a clean one.', error);
    const fallback = mkS();
    svS(fallback);
    return fallback;
  }
}

function svS(store){
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
}

function mkPdb(){
  return { players: {} };
}

function ldPdb(){
  if(!fs.existsSync(PLAYER_DB_PATH)){
    svPdb(mkPdb());
  }

  try{
    const parsed = JSON.parse(fs.readFileSync(PLAYER_DB_PATH, 'utf8'));
    return { players: parsed.players || {} };
  } catch(error){
    console.error('Failed to read player db, rebuilding a clean one.', error);
    const fallback = mkPdb();
    svPdb(fallback);
    return fallback;
  }
}

function svPdb(db){
  fs.writeFileSync(PLAYER_DB_PATH, JSON.stringify(db, null, 2));
}

function gPRec(db, userId){
  return db.players?.[userId] || null;
}

function sPRec(db, user, mcsrUsername, league){
  const existing = db.players[user.id] || {};
  db.players[user.id] = {
    ...existing,
    userId: user.id,
    discordUsername: user.username,
    league,
    highestLeague: Math.min(existing.highestLeague ?? league, league),
    bestZScores: existing.bestZScores || {},
    updatedAt: new Date().toISOString(),
  };
}

function sPRecById(db, userId, discordUsername, league){
  const existing = db.players[userId] || {};
  db.players[userId] = {
    ...existing,
    userId,
    discordUsername,
    league,
    highestLeague: Math.min(existing.highestLeague ?? league, league),
    bestZScores: existing.bestZScores || {},
    updatedAt: new Date().toISOString(),
  };
}

function sDemRec(db, userId, discordUsername, league, competition){
  sPRecById(db, userId, discordUsername, league);
  db.players[userId].lastDemotedAt = new Date().toISOString();
  db.players[userId].lastDemotedFromLeague = competition.leagueNumber;
  db.players[userId].lastDemotedWeek = Number(competition.week ?? competition.weekNumber ?? 0) || null;
  db.players[userId].updatedAt = new Date().toISOString();
}

function gSRKey(guildId, userId){
  return `${guildId}:${userId}`;
}

function hasSR(store, guildId, userId){
  return Boolean(store.settings?.signupRequests?.[gSRKey(guildId, userId)]);
}

function addSR(store, guildId, userId, payload = {}){
  store.settings.signupRequests[gSRKey(guildId, userId)] = {
    ...payload,
    createdAt: new Date().toISOString(),
  };
}

function delSR(store, guildId, userId){
  delete store.settings.signupRequests[gSRKey(guildId, userId)];
}

function gSR(store, guildId, userId){
  return store.settings?.signupRequests?.[gSRKey(guildId, userId)] || null;
}

function wait(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let storeLock = Promise.resolve();

async function withStoreLock(fn){
  const run = storeLock.then(fn, fn);
  storeLock = run.catch(()=>{});
  return run;
}

function nn(name){
  return String(name).trim().toLowerCase();
}

function pT(value){
  if(!value){
    throw new Error('Time is required.');
  }

  const match = value.trim().match(/^(\d+):(\d{2})\.(\d{3})$/);
  if(!match){
    throw new Error('Use mm:ss.mmm for time.');
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const milliseconds = Number(match[3]);

  if(seconds > 59){
    throw new Error('Seconds must be between 0 and 59.');
  }

  return minutes * 60 * 1000 + seconds * 1000 + milliseconds;
}

function fT(totalSeconds){
  if(totalSeconds === null || totalSeconds === undefined){
    return 'n/a';
  }

  const safeMilliseconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeMilliseconds / 60000);
  const seconds = Math.floor((safeMilliseconds % 60000) / 1000);
  const milliseconds = safeMilliseconds % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function gDU(value){
  return value?.discordUsername || value?.username || 'Unknown User';
}

function gPid(value){
  return value?.userId || value?.id || null;
}

function gUuid(value){
  return value?.uuid || value?.mcUuid || null;
}

function gIgn(value){
  return value?.ign || gDU(value);
}

function gElo(value){
  const raw = value?.elo ?? value?.eloRate ?? null;
  return Number.isFinite(Number(raw)) ? Number(raw) : null;
}

function gPeakElo(value){
  const raw = value?.peakElo ?? value?.highestElo ?? value?.elo ?? value?.eloRate ?? null;
  return Number.isFinite(Number(raw)) ? Number(raw) : null;
}

function eMd(value){
  return String(value ?? '').replace(/([\\*_`~|>])/g, '\\$1');
}

function fPN(value){
  const ign = eMd(gIgn(value));
  const discordUsername = eMd(gDU(value));
  return ign === discordUsername ? ign : `${ign}(${discordUsername})`;
}

function fElo(value){
  const elo = gPeakElo(value);
  return elo === null ? 'unrated' : `${elo}`;
}

function gTw(value){
  return value?.twitch ? String(value.twitch).trim() : null;
}

function fTw(value){
  const twitch = gTw(value);
  if(!twitch) {
    return null;
  }
  return /^https?:\/\//i.test(twitch) ? `<${twitch}>` : twitch;
}

function mkRegMsg(c){
  const players = gRegs(c);
  const db = ldPdb();
  const lines = [
    `**${fCL(c)} Registration**`,
    `Status: ${c.registrationOpen ? 'open' : 'closed'}`,
  ];

  if(players.length === 0){
    lines.push('1. [no registered players]');
    return lines.join('\n');
  }

  for(let index = 0; index < players.length; index += 1){
    const twitch = fTw(players[index]);
    lines.push(`${index + 1}. ${fDemPN(db, players[index], c)} (${fElo(players[index])})${twitch ? ` - twitch: ${twitch}` : ''}`);
  }

  return lines.join('\n');
}

function gRegMsgIds(c){
  return [...new Set([c?.registrationMessageId, ...(c?.registrationMessageIds || [])].filter(Boolean))];
}

async function sRegMsgs(channel, c){
  const chunks = chunkMsg(mkRegMsg(c));
  const ids = gRegMsgIds(c);
  const nextIds = [];

  for(let index = 0; index < chunks.length; index += 1){
    const oldId = ids[index];
    let message = null;

    if(oldId){
      message = await channel.messages.fetch(oldId).catch(()=>null);
    }

    if(message){
      await message.edit(chunks[index]);
    }else{
      message = await channel.send(chunks[index]);
      if(index === 0){
        await message.pin().catch(()=>{});
      }
    }

    nextIds.push(message.id);
  }

  for(let index = chunks.length; index < ids.length; index += 1){
    await dMsg(channel, ids[index]);
  }

  c.registrationMessageId = nextIds[0] || null;
  c.registrationMessageIds = nextIds;
}

async function uRegMsg(channel, c){
  if(!channel || !c){
    return;
  }

  try{
    await sRegMsgs(channel, c);
  }catch(error){
    console.error('Failed to update registration list.', error);
  }
}

async function cRegMsg(channel, c){
  if(!channel){
    return;
  }

  for(const messageId of gRegMsgIds(c)){
    await dMsg(channel, messageId);
  }
  c.registrationMessageId = null;
  c.registrationMessageIds = [];
  await sRegMsgs(channel, c);
}

function gInfoName(leagueNumber){
  return `league-${leagueNumber}-info`;
}

function gInfoCh(guild, competition){
  if(!guild || !competition){
    return null;
  }

  if(competition.infoChannelId){
    const cached = guild.channels.cache.get(competition.infoChannelId);
    if(cached?.isText?.()){
      return cached;
    }
  }

  const channel = guild.channels.cache.find((entry) => entry.name === gInfoName(competition.leagueNumber) && entry.isText());
  if(channel){
    competition.infoChannelId = channel.id;
    return channel;
  }

  return null;
}

async function uPinMsg(channel, c){
  if(!channel || !c?.registrationMessageId){
    return;
  }

  try{
    const message = await channel.messages.fetch(c.registrationMessageId);
    await message.unpin().catch(() => {});
  } catch(error){  

    }
}

async function pRegMsg(channel, c){
  if(!channel || !c?.registrationMessageId){
    return;
  }

  try{
    const message = await channel.messages.fetch(c.registrationMessageId);
    await message.pin().catch(() => {});
  } catch(error){

    }
}

async function dMsg(channel, messageId){
  if(!channel || !messageId){
    return;
  }

  try{
    const message = await channel.messages.fetch(messageId);
    await message.delete().catch(() => {});
  } catch(error){

    }
}

async function dCompMsgs(channel, c){
  if(!channel || !c){
    return;
  }

  await dMsg(channel, c.initMessageId);
  for(const messageId of gRegMsgIds(c)){
    await dMsg(channel, messageId);
  }
}

async function dCompTrackedMsgs(guild, fallbackChannel, c){
  if(!c){
    return;
  }

  const initChannel = c.initChannelId ? guild?.channels?.cache?.get(c.initChannelId) : fallbackChannel;
  const regChannel = c.infoChannelId ? guild?.channels?.cache?.get(c.infoChannelId) : fallbackChannel;

  await dMsg(initChannel || fallbackChannel, c.initMessageId);
  for(const messageId of gRegMsgIds(c)){
    await dMsg(regChannel || fallbackChannel, messageId);
  }
  for(const messageId of c.leaderboardMessageIds || []){
    await dMsg(regChannel || fallbackChannel, messageId);
  }
  for(const messageId of c.finalMessageIds || []){
    const finalChannel = c.finalChannelId ? guild?.channels?.cache?.get(c.finalChannelId) : regChannel || fallbackChannel;
    await dMsg(finalChannel || fallbackChannel, messageId);
  }
}

function fOV(option){
  if(!option){
    return '';
  }

  switch(option.type){
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

function fCU(interaction){
  const options = interaction.options?.data || [];
  if(options.length === 0){
    return `/${interaction.commandName}`;
  }

  const formattedOptions = options
    .map((option) => `${option.name}: ${fOV(option)}`)
    .join(', ');

  return `/${interaction.commandName} ${formattedOptions}`;
}

function gMid(match){
  return match?.matchId || match?.id || match?._id || null;
}

function gRMid(response, fallback = null){
  const data = response?.data || {};
  return data.matchId || data.id || data._id || fallback;
}

function gProf(payload){
  const data = payload?.data || payload ||{};
  const season = data?.statistics?.season || {};
  const rankedCompletionTime = Number(season?.completionTime?.ranked);
  const rankedCompletions = Number(season?.completions?.ranked);
  const peakEloRaw =
    data?.seasonResult?.highest
    ?? data.highestEloRate
    ?? data.peakEloRate
    ?? season?.highestElo?.ranked
    ?? season?.peakElo?.ranked
    ?? season?.bestElo?.ranked;
  const rankedAverage =
    Number.isFinite(rankedCompletionTime) && Number.isFinite(rankedCompletions) && rankedCompletions > 0
      ? rankedCompletionTime / rankedCompletions
      : null;
  return{
    uuid: data.uuid || null,
    ign: data.nickname || data.ign || null,
    elo: Number.isFinite(Number(data.eloRate)) ? Number(data.eloRate) : null,
    peakElo: Number.isFinite(Number(peakEloRaw)) ? Number(peakEloRaw) : null,
    rankedPb: Number.isFinite(Number(season?.bestTime?.ranked)) ? Number(season.bestTime.ranked) : null,
    rankedAverage,
  };
}

function fSV(label, value){
  return `${label}: ${typeof value === 'string' ? eMd(value) : value ?? 'n/a'}`;
}

function gSL(peakElo){
  const elo = Number(peakElo);
  if(!Number.isFinite(elo)) {
    return 'n/a';
  }

  const targets = [
    { league: 'League 7', value: 0 },
    { league: 'League 6', value: 766.1 },
    { league: 'League 5', value: 1050.3 },
    { league: 'League 4', value: 1215.0 },
    { league: 'League 3', value: 1405.7 },
    { league: 'League 2', value: 1588.2 },
    { league: 'League 1', value: 1967.7 },
  ];

  let best = targets[0];
  let bestDelta = Math.abs(elo - best.value);

  for(const target of targets.slice(1)) {
    const delta = Math.abs(elo - target.value);
    if(delta < bestDelta) {
      best = target;
      bestDelta = delta;
    }
  }

  return best.league;
}

function hasLeagueRole(member){
  return gMRN(member) !== null;
}

async function findSignupReviewer(guild){
  if(!guild) {
    return null;
  }

  const lower = SIGNUP_REVIEWER.toLowerCase();
  const cached = guild.members.cache.find((member) =>{
    const user = member.user;
    return user.username.toLowerCase() === lower
      || String(user.globalName || '').toLowerCase() === lower
      || String(user.tag || '').split('#')[0].toLowerCase() === lower;
  });
  if(cached) {
    return cached.user;
  }

  try{
    const fetched = await guild.members.fetch({ query: SIGNUP_REVIEWER, limit: 10 });
    const member = fetched.find((entry) =>{
      const user = entry.user;
      return user.username.toLowerCase() === lower
        || String(user.globalName || '').toLowerCase() === lower
        || String(user.tag || '').split('#')[0].toLowerCase() === lower;
    });
    return member?.user || null;
  } catch(error){
    return null;
  }
}

function mkSignupBtns(guildId, applicantId, reviewerId){
  const rows = [];
  for(let start = 1; start <= MAX_LEAGUE; start += 3){
    rows.push(
      new MessageActionRow().addComponents(
        ...[start, start + 1, start + 2]
          .filter((league)=>league <= MAX_LEAGUE)
          .map((league) =>
          new MessageButton()
            .setCustomId(`signup_pick:${guildId}:${applicantId}:${reviewerId}:${league}`)
            .setLabel(`League ${league}`)
            .setStyle('PRIMARY'),
          ),
      ),
    );
  }
  rows.push(
    new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId(`signup_deny:${guildId}:${applicantId}:${reviewerId}:0`)
        .setLabel('Deny')
        .setStyle('DANGER'),
    ),
  );
  return rows;
}

function mkSignupConfirmBtns(guildId, applicantId, reviewerId, league){
  return [
    new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId(`signup_confirm:${guildId}:${applicantId}:${reviewerId}:${league}`)
        .setLabel('Confirm')
        .setStyle('SUCCESS'),
      new MessageButton()
        .setCustomId(`signup_back:${guildId}:${applicantId}:${reviewerId}:${league}`)
        .setLabel('Back')
        .setStyle('SECONDARY'),
    ),
  ];
}

function gHost(competition){
  if(!competition?.hostUserId){
    return null;
  }
  return{
    userId: competition.hostUserId,
    discordUsername: competition.hostDiscordUsername || competition.hostUserId,
    ign: competition.hostIgn || competition.hostDiscordUsername || competition.hostUserId,
    uuid: competition.hostUuid || null,
  };
}

async function logCmd(interaction, store){
  if(!store.settings?.loggingEnabled || !interaction.guild){
    return;
  }

  const logChannel = interaction.guild.channels.cache.find((channel) => channel.name === 'ranked-bot-logs' && channel.isText());
  if(!logChannel){
    return;
  }

  const timestamp = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  const username = interaction.user.tag || interaction.user.username;
  const commandText = fCU(interaction);
  const channel = interaction.channelId ? `<#${interaction.channelId}>` : interaction.channel?.name || 'Unknown channel';

  await logChannel.send(`User: ${username}\nChannel: ${channel}\nTime: ${timestamp}\nCommand: ${commandText}`).catch(() =>{});
}

function iA(interaction){
  const memberRoles = interaction.member?.roles?.cache;
  return Boolean(memberRoles && memberRoles.some((role) => /^league helper$/i.test(role.name.trim())));
}

function gCWR(guild){
  return guild?.roles?.cache?.find((role) => /^current week$/i.test(role.name.trim())) || null;
}

function iT(competition){
  return competition?.testMode === true;
}

function iCh(competition){
  return competition?.mode === 'championship';
}

function iCS(interaction){
  const memberRoles = interaction.member?.roles?.cache;
  return Boolean(memberRoles && memberRoles.some((role) => /^cmd spam$/i.test(role.name.trim())));
}

function gMRN(member){
  const memberRoles = member?.roles?.cache;
  if(!memberRoles){
    return null;
  }

  const leagueRole = memberRoles.find((role) => /^league\s+[1-7]$/i.test(role.name.trim()));
  if(!leagueRole){
    return null;
  }

  return Number(leagueRole.name.trim().match(/^league\s+([1-7])$/i)[1]);
}

async function addCWR(guild, userId){
  const role = gCWR(guild);
  if(!guild || !role || !userId){
    return;
  }

  try{
    const member = await guild.members.fetch(userId);
    if(!member.roles.cache.has(role.id)){
      await member.roles.add(role);
    }
  } catch(error){

    }
}

async function rmCWR(guild, userId){
  const role = gCWR(guild);
  if(!guild || !role || !userId){
    return;
  }

  try{
    const member = await guild.members.fetch(userId);
    if(member.roles.cache.has(role.id)){
      await member.roles.remove(role);
    }
  } catch(error){

    }
}

async function rmAllCWR(guild, competition){
  if(!guild || !competition){
    return;
  }

  for(const player of gRegs(competition)){
    await rmCWR(guild, player.userId);
  }
}

async function addAllCWR(guild, competition){
  if(!guild || !competition){
    return;
  }

  for(const player of gRegs(competition)){
    await addCWR(guild, player.userId);
  }
}

async function sendChunks(channel, text){
  if(!channel || !text){
    return [];
  }

  const messages = chunkMsg(text);
  const ids = [];
  for(const message of messages){
    const sent = await channel.send(message);
    ids.push(sent.id);
  }
  return ids;
}

async function uLbMsg(guild, competition, forceCreate = false){
  if(!competition){
    return;
  }

  const infoChannel = gInfoCh(guild, competition);
  if(!infoChannel){
    return;
  }

  if(!forceCreate && (!competition.leaderboardMessageIds || competition.leaderboardMessageIds.length === 0)){
    return;
  }

  for(const messageId of competition.leaderboardMessageIds || []){
    await dMsg(infoChannel, messageId);
  }

  competition.leaderboardMessageIds = await sendChunks(infoChannel, fLB(competition));
}

async function clrInfo(guild, leagueNumber){
  const infoChannel = guild?.channels?.cache?.find((entry) => entry.name === gInfoName(leagueNumber) && entry.isText());
  if(!infoChannel){
    return null;
  }

  const channels = Object.values(ldS().channels ||{});
  for(const channel of channels){
    const competition = channel?.competition;
    if(!competition || competition.leagueNumber !== leagueNumber){
      continue;
    }

    for(const messageId of gRegMsgIds(competition)){
      await dMsg(infoChannel, messageId);
    }
    for(const messageId of competition.leaderboardMessageIds || []){
      await dMsg(infoChannel, messageId);
    }
    if(competition.finalChannelId === infoChannel.id){
      for(const messageId of competition.finalMessageIds || []){
        await dMsg(infoChannel, messageId);
      }
    }
  }

  return infoChannel;
}

async function gHostMatchId(competition, seed){
  const host = gHost(competition);
  if(!host){
    throw new Error('No host is set for this competition. Use /host first.');
  }

  const hostUuid = gUuid(host);
  if(!hostUuid){
    throw new Error(`The host ${fPN(host)} does not have a stored UUID.`);
  }

  const seeds = Object.values(competition.seeds)
    .filter((entry) => /^\d+$/.test(String(entry.name).trim()))
    .sort((left, right) => Number(left.name) - Number(right.name));
  const seedIndex = seeds.findIndex((entry) => nn(entry.name) === nn(seed.name));

  if(seedIndex === -1){
    throw new Error(`Seed ${seed.name} is not part of this competition.`);
  }

  const matchIndex = seeds.length - 1 - seedIndex;
  const matches = await getRecentMatchesForUser(hostUuid);
  if(matches.length <= matchIndex){
    throw new Error(`Could not find enough finished matches for host ${fPN(host)}.`);
  }

  const matchId = gMid(matches[matchIndex]);
  if(!matchId){
    throw new Error('Could not determine the selected MCSR match id.');
  }

  return matchId;
}

function gLM(interaction){
  const memberRoles = interaction.member?.roles?.cache;
  if(!memberRoles){
    throw new Error('This command can only be used inside a server.');
  }

  const leagueRole = memberRoles.find((role) => /^league\s+[1-7]$/i.test(role.name.trim()));
  if(!leagueRole){
    throw new Error('You do not have a League role.');
  }

  return Number(leagueRole.name.trim().match(/^league\s+([1-7])$/i)[1]);
}

function gLC(interaction, competition, admin){
  if(admin){
    return competition.leagueNumber;
  }
  return gLM(interaction);
}

function gLim(store, leagueNumber){
  const limit = Number(store.settings.leagueLimits[String(leagueNumber)] || store.settings.leagueLimits[leagueNumber]);
  if(!limit){
    throw new Error(`League ${leagueNumber} is not configrued.`);
  }
  return limit;
}

function gCK(interaction){
  if(!interaction.guildId || !interaction.channelId){
    throw new Error('This command must be used in a server channel.');
  }
  return interaction.channelId;
}

function ensC(store, channelId){
  if(!store.channels[channelId]){
    store.channels[channelId] = { competition: null, testMode: false };
  }
  if(typeof store.channels[channelId].testMode !== 'boolean'){
    store.channels[channelId].testMode = false;
  }
  return store.channels[channelId];
}

function nC(competition){
  if(!competition){
    return null;
  }

  competition.status = competition.status || 'active';
  competition.seeds = competition.seeds || {};
  competition.pointAdjustments = competition.pointAdjustments || {};
  competition.currentSeedKey = competition.currentSeedKey || null;
  competition.registeredPlayers = competition.registeredPlayers || {};
  competition.mode = competition.mode || 'weekly';
  if(iCh(competition)){
    const config = CHAMPIONSHIPS[competition.leagueNumber];
    competition.championship = competition.championship || {};
    competition.championship.graceMs = competition.championship.graceMs || config?.graceMs;
    competition.championship.eliminationRate = competition.championship.eliminationRate || config?.eliminationRate;
    competition.championship.originalEntrantIds = competition.championship.originalEntrantIds || [];
    competition.championship.activePlayerIds = competition.championship.activePlayerIds || [];
    competition.championship.eliminatedPlayerIds = competition.championship.eliminatedPlayerIds || [];
    competition.championship.targetFinalCount = competition.championship.targetFinalCount || null;
  }
  competition.registrationMessageId = competition.registrationMessageId || null;
  competition.registrationMessageIds = competition.registrationMessageIds || [];
  competition.initMessageId = competition.initMessageId || null;
  competition.initChannelId = competition.initChannelId || null;
  competition.infoChannelId = competition.infoChannelId || null;
  competition.hostUserId = competition.hostUserId || null;
  competition.hostDiscordUsername = competition.hostDiscordUsername || null;
  competition.hostIgn = competition.hostIgn || null;
  competition.hostUuid = competition.hostUuid || null;
  if(typeof competition.testMode !== 'boolean'){
    competition.testMode = false;
  }
  competition.finalMessageIds = competition.finalMessageIds || [];
  competition.finalChannelId = competition.finalChannelId || null;
  competition.leaderboardMessageIds = competition.leaderboardMessageIds || [];
  competition.registrationOpenBeforeEnd = competition.registrationOpenBeforeEnd ?? null;
  competition.manualPromotionCount = Number.isInteger(competition.manualPromotionCount) ? competition.manualPromotionCount : null;
  competition.manualDemotionCount = Number.isInteger(competition.manualDemotionCount) ? competition.manualDemotionCount : null;
  if(typeof competition.movementsApplied !== 'boolean'){
    competition.movementsApplied = false;
  }
  if(competition.maxTimeLimitSeconds && competition.maxTimeLimitSeconds < 1000 * 60){
    competition.maxTimeLimitSeconds *= 1000;
  }
  if(typeof competition.registrationOpen !== 'boolean'){
    competition.registrationOpen = true;
  }
  if(typeof competition.scoreReportingEnabled !== 'boolean'){
    competition.scoreReportingEnabled = false;
  }

  for(const player of Object.values(competition.registeredPlayers)){
    player.discordUsername = gDU(player);
    player.discordDisplayName = player.discordDisplayName || player.discordUsername;
    player.ign = gIgn(player);
    player.uuid = gUuid(player);
    player.elo = gElo(player);
    player.peakElo = gPeakElo(player);
    player.twitch = gTw(player);
  }

  for(const seed of Object.values(competition.seeds)){
    seed.results = seed.results || {};
    seed.playerCount = Number(seed.playerCount || Object.keys(seed.results).length || 0);
    if(seed.timeLimitSeconds && seed.timeLimitSeconds < 1000 * 60){
      seed.timeLimitSeconds *= 1000;
    }
    if(typeof seed.editingEnabled !== 'boolean'){
      seed.editingEnabled = true;
    }
    if(typeof seed.imported !== 'boolean'){
      seed.imported = false;
    }
    seed.rankedMatchId = seed.rankedMatchId || null;
    seed.entrantIds = Array.isArray(seed.entrantIds) ? seed.entrantIds : null;
    seed.eliminatedIds = Array.isArray(seed.eliminatedIds) ? seed.eliminatedIds : [];
    seed.cutoffTimeMs = Number.isFinite(seed.cutoffTimeMs) ? seed.cutoffTimeMs : null;

  for(const entry of Object.values(seed.results)){
      entry.discordUsername = gDU(entry);
      entry.ign = gIgn(entry);
      entry.uuid = gUuid(entry);
      entry.elo = gElo(entry);
      entry.twitch = gTw(entry);
      entry.played = entry.played === true || Boolean(entry.submittedAt);
      if(typeof entry.timeSeconds === 'number' && entry.timeSeconds < 1000 * 60){
        entry.timeSeconds *= 1000;
      }
    }
  }

  sCR(competition);
  recalcCh(competition);

  return competition;
}

function gComp(store, channelId){
  const channel = ensC(store, channelId);
  return nC(channel.competition);
}

function rC(store, channelId){
  const competition = gComp(store, channelId);
  if(!competition){
    throw new Error('This channel does not have a competition yet.Use /nm to create one.');
  }
  return competition;
}

function rA(store, channelId){
  const competition = rC(store, channelId);
  if(competition.status !== 'active'){
    throw new Error('This competition has ended. Reset it before starting a new one.');
  }
  return competition;
}

function gWN(competition){
  const weekNumber = Number(competition?.week ?? competition?.weekNumber);
  if(!Number.isInteger(weekNumber) || weekNumber < 1){
    throw new Error('This competition is missing a valid week number.');
  }
  return weekNumber;
}

function mkCP(competition){
  if(iCh(competition)){
    return {
      leagueTier: Number(competition.leagueNumber),
      championship: true,
    };
  }
  return {
    leagueTier: Number(competition.leagueNumber),
    weekNumber: gWN(competition),
  };
}

function rUuid(value, contextLabel){
  const uuid = gUuid(value);
  if(!uuid){
    throw new Error(`${contextLabel} is missing a Minecraft UUID.`);
  }
  return uuid;
}

function gSeed(competition, seedName){
  return competition.seeds[nn(seedName)];
}

function gCurS(competition){
  const numericSeeds = Object.values(competition.seeds).filter((seed) => /^\d+$/.test(String(seed.name).trim()));

  if(numericSeeds.length === 0){
    if(!competition.currentSeedKey){
      return null;
    }

    return competition.seeds[competition.currentSeedKey] || null;
  }

  numericSeeds.sort((left, right) => Number(left.name) - Number(right.name));
  return numericSeeds[numericSeeds.length - 1];
}

function gNS(competition){
  const numericSeeds = Object.values(competition.seeds)
    .map((seed) => String(seed.name).trim())
    .filter((name) => /^\d+$/.test(name))
    .map((name) => Number(name));

  if(numericSeeds.length === 0){
    return '1';
  }

  return String(Math.max(...numericSeeds) + 1);
}

function gRS(competition, seedName){
  return seedName ? gSeed(competition, seedName) : gCurS(competition);
}

function gRegs(competition){
  return Object.values(competition.registeredPlayers || {}).sort((left, right) =>{
    const leftElo = gPeakElo(left) ?? -1;
    const rightElo = gPeakElo(right) ?? -1;
    if(leftElo !== rightElo){
      return rightElo - leftElo;
    }
    return fPN(left).localeCompare(fPN(right));
  });
}

function gEP(competition, seed = null){
  if(!iCh(competition)){
    return gRegs(competition);
  }
  const ids = seed?.entrantIds || competition.championship?.activePlayerIds || [];
  return ids.map((id)=>competition.registeredPlayers?.[id]).filter(Boolean);
}

function mkDR(competition, seed = null){
  return Object.fromEntries(
    gEP(competition, seed).map((player) => [
      player.userId,
     {
        userId: player.userId,
        username: player.discordUsername,
        discordUsername: player.discordUsername,
        ign: player.ign,
        uuid: player.uuid || null,
        elo: gElo(player),
        twitch: gTw(player),
        dnf: true,
        sourceDnf: true,
        played: false,
        placement: null,
        timeSeconds: null,
        rawTimeSeconds: null,
        submittedAt: null,
      },
    ]),
  );
}

function gRC(competition){
  return gRegs(competition).length;
}

function sSR(competition, seed){
  seed.results = seed.results ||{};
  const players = gEP(competition, seed);
  seed.playerCount = players.length;

  for(const player of players){
    if(!seed.results[player.userId]){
      seed.results[player.userId] ={
        userId: player.userId,
        username: player.discordUsername,
        discordUsername: player.discordUsername,
        ign: player.ign,
        uuid: player.uuid || null,
        elo: gElo(player),
        twitch: gTw(player),
        dnf: true,
        sourceDnf: true,
        played: false,
        placement: null,
        timeSeconds: null,
        rawTimeSeconds: null,
        submittedAt: null,
      };
      continue;
    }

    seed.results[player.userId].username = player.discordUsername;
    seed.results[player.userId].discordUsername = player.discordUsername;
    seed.results[player.userId].ign = player.ign;
    seed.results[player.userId].uuid = player.uuid || null;
    seed.results[player.userId].elo = gElo(player);
    seed.results[player.userId].twitch = gTw(player);
    seed.results[player.userId].played = seed.results[player.userId].played === true || Boolean(seed.results[player.userId].submittedAt);
  }

  if(iCh(competition)){
    const entrantIds = new Set(players.map((player)=>player.userId));
    for(const userId of Object.keys(seed.results)){
      if(!entrantIds.has(userId)){
        delete seed.results[userId];
      }
    }
  }
}

function sCR(competition){
  for(const seed of Object.values(competition.seeds)){
    sSR(competition, seed);
  }
}

function iRP(competition, userId){
  return Boolean(competition.registeredPlayers?.[userId]);
}

function rmRP(competition, userId){
  const registeredPlayer = competition.registeredPlayers?.[userId] || null;
  if(!registeredPlayer){
    return null;
  }

  delete competition.registeredPlayers[userId];
  if(iCh(competition)){
    competition.championship.originalEntrantIds = competition.championship.originalEntrantIds.filter((id)=>id !== userId);
    competition.championship.activePlayerIds = competition.championship.activePlayerIds.filter((id)=>id !== userId);
    competition.championship.eliminatedPlayerIds = competition.championship.eliminatedPlayerIds.filter((id)=>id !== userId);
    for(const seed of Object.values(competition.seeds)){
      seed.entrantIds = (seed.entrantIds || []).filter((id)=>id !== userId);
      seed.eliminatedIds = (seed.eliminatedIds || []).filter((id)=>id !== userId);
    }
  }

  for(const seed of Object.values(competition.seeds)){
    delete seed.results[userId];
    if(!seed.imported){
      seed.playerCount = Math.max(0, seed.playerCount - 1);
    }
  }

  delete competition.pointAdjustments[userId];
  return registeredPlayer;
}

function hPlayed(competition, userId){
  return Object.values(competition.seeds || {}).some((seed)=>
    seed.imported === true && seed.results?.[userId]?.played === true,
  );
}

async function rmNoPlay(guild, competition){
  const removed = [];
  for(const player of gRegs(competition)){
    if(hPlayed(competition, player.userId)){
      continue;
    }
    if(gUuid(player)){
      await pushComp(competition, '/api/write/player/unregister', {
        ...mkCP(competition),
        uuid: rUuid(player, fPN(player)),
      }, 'PATCH');
    }
    const removedPlayer = rmRP(competition, player.userId);
    if(removedPlayer){
      removed.push(removedPlayer);
      await rmCWR(guild, player.userId);
    }
  }
  return removed;
}

async function syncImportedMatches(competition){
  for(const seed of Object.values(competition.seeds || {})){
    if(!seed.imported && !seed.rankedMatchId){
      continue;
    }
    const rankedMatchId = gRid(seed);
    if(!rankedMatchId){
      continue;
    }
    await pushComp(competition, '/api/write/match/results', mkMRP(competition, seed, rankedMatchId), 'POST');
  }
}

function gSE(seed){
  return Object.values(seed.results || {});
}

function gBonus(place){
  if(place === 1){
    return 5;
  }
  if(place === 2){
    return 3;
  }
  if(place === 3){
    return 1;
  }
  return 0;
}

function gPts(playerCount, place){
  if(typeof place !== 'number'){
    return 0;
  }

  const maxFinishers = Math.floor(playerCount / 2);
  if(maxFinishers < 1 || place > maxFinishers){
    return 1;
  }

  return Math.max(1, maxFinishers - (place - 1) + gBonus(place));
}

function gSD(competition, seed){
  const participantCount = seed.playerCount || gRC(competition);
  const entries = gSE(seed).map((entry) =>({
    ...entry,
    effectiveTimeSeconds: entry.dnf ? seed.timeLimitSeconds : entry.timeSeconds,
  }));
  const finishers = entries
    .filter((entry) => !entry.dnf && typeof entry.timeSeconds === 'number')
    .sort((left, right) =>{
      if(left.timeSeconds !== right.timeSeconds){
        return left.timeSeconds - right.timeSeconds;
      }
      return fPN(left).localeCompare(fPN(right));
    })
    .map((entry) =>({ ...entry }));

  let currentPlacement = 0;
  let previousTimeSeconds = null;

  for(let index = 0; index < finishers.length; index += 1){
    const entry = finishers[index];
    if(previousTimeSeconds === null || entry.timeSeconds !== previousTimeSeconds){
      currentPlacement = index + 1;
      previousTimeSeconds = entry.timeSeconds;
    }

    entry.placement = currentPlacement;
    entry.seedPoints = gPts(participantCount, currentPlacement);
  }

  const tieCounts = new Map();
  for(const entry of finishers){
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

function gChCfg(competition){
  const config = CHAMPIONSHIPS[competition.leagueNumber];
  if(!config){
    throw new Error(`League ${competition.leagueNumber} does not have a championship configuration.`);
  }
  return config;
}

function recalcCh(competition){
  if(!iCh(competition)){
    return;
  }

  const config = gChCfg(competition);
  const originalIds = [...new Set(competition.championship.originalEntrantIds || [])]
    .filter((id)=>competition.registeredPlayers?.[id]);
  const eliminated = new Set();
  let active = [...originalIds];
  let credit = 0;
  const seeds = Object.values(competition.seeds)
    .filter((seed)=>/^\d+$/.test(String(seed.name)))
    .sort((left, right)=>Number(left.name) - Number(right.name));

  for(const seed of seeds){
    seed.entrantIds = [...active];
    sSR(competition, seed);
    seed.eliminatedIds = [];
    if(!seed.imported){
      break;
    }

    for(const entry of gSE(seed)){
      if(typeof entry.sourceDnf !== 'boolean'){
        entry.sourceDnf = Boolean(entry.dnf);
      }
      if(entry.rawTimeSeconds === undefined){
        entry.rawTimeSeconds = entry.timeSeconds;
      }
      entry.dnf = entry.sourceDnf;
      entry.timeSeconds = entry.rawTimeSeconds;
    }
    const completedTimes = gSE(seed)
      .filter((entry)=>!entry.dnf && typeof entry.timeSeconds === 'number')
      .map((entry)=>entry.timeSeconds);
    seed.cutoffTimeMs = completedTimes.length > 0 ? Math.min(...completedTimes) + config.graceMs : null;
    if(seed.cutoffTimeMs !== null){
      seed.timeLimitSeconds = seed.cutoffTimeMs;
      for(const entry of gSE(seed)){
        if(!entry.dnf && typeof entry.timeSeconds === 'number' && entry.timeSeconds > seed.cutoffTimeMs){
          entry.dnf = true;
        }
      }
    }

    const standings = gSD(competition, seed);
    const dnfs = standings.filter((entry)=>entry.dnf);
    const finishers = standings.filter((entry)=>!entry.dnf);
    const planned = Math.round(originalIds.length * config.eliminationRate);
    const adjusted = Math.max(0, planned - credit);
    credit = Math.max(0, credit - planned);
    const desiredEliminations = Math.max(1, adjusted);
    const maxFinisherElims = Math.max(0, active.length - dnfs.length - 1);
    const finisherEliminationCount = Math.min(Math.max(0, desiredEliminations - dnfs.length), maxFinisherElims);
    const finisherElims = finisherEliminationCount > 0 ? finishers.slice(-finisherEliminationCount) : [];
    const maxEliminations = Math.max(0, active.length - 1);
    const roundEliminated = [...dnfs, ...finisherElims].slice(0, maxEliminations);

    credit += Math.max(0, roundEliminated.length - desiredEliminations);
    seed.eliminatedIds = roundEliminated.map((entry)=>entry.userId);
    for(const entry of roundEliminated){
      eliminated.add(entry.userId);
    }
    active = active.filter((id)=>!eliminated.has(id));
  }

  competition.championship.activePlayerIds = active;
  competition.championship.eliminatedPlayerIds = [...eliminated];
  competition.championship.targetFinalCount = 1;
  competition.championship.eliminationCredit = credit;
}

function iHR(competition, userId){
  return Object.values(competition.seeds || {}).some(
    (seed)=>seed.imported === true || Boolean(seed.rankedMatchId),
  );
}

function gRid(seed){
  return seed.rankedMatchId || null;
}

function mkMRP(competition, seed, rankedMatchId){
  return {
    ...mkCP(competition),
    matchNumber: Number(seed.name),
    rankedMatchId: String(rankedMatchId),
    results: gSD(competition, seed)
      .filter((entry)=>entry.played === true)
      .map((entry)=>({
        uuid: rUuid(entry, fPN(entry)),
        timeMs: entry.dnf ? null : entry.timeSeconds,
        dnf: Boolean(entry.dnf),
        placement: typeof entry.placement === 'number' ? entry.placement : null,
        pointsWon: Number(entry.seedPoints || 0),
      })),
  };
}

async function syncMovementsToWeb(competition, movementPlan){
  return await pushComp(competition, '/api/write/movements', {
    ...mkCP(competition),
    promotedUuids: movementPlan.promotions.map((entry)=>rUuid(entry, fPN(entry))),
    demotedUuids: movementPlan.demotions.map((entry)=>rUuid(entry, fPN(entry))),
  }, 'PATCH');
}

function formatPlacement(entry){
  return entry?.placementLabel || (typeof entry?.placement === 'number' ? `${entry.placement}` : 'dnf');
}

function gLB(competition){
  const competitors = new Map();
  const importedSeeds = Object.values(competition.seeds).filter((seed)=>seed.imported === true);

  for(const seed of importedSeeds){
    for(const entry of gSD(competition, seed)){
      if(!competitors.has(entry.userId)){
        const registered = competition.registeredPlayers?.[entry.userId] || entry;
        competitors.set(entry.userId,{
          userId: entry.userId,
          username: gDU(registered),
          discordUsername: gDU(registered),
          ign: gIgn(registered),
          uuid: gUuid(registered),
          elo: gElo(registered),
          computedPoints: 0,
          manualAdjustment: 0,
          totalPoints: 0,
          seedCount: 0,
          averageSeedCount: 0,
          totalEffectiveTimeSeconds: 0,
          averageTimeSeconds: null,
          dnfCount: 0,
        });
      }
      const competitor = competitors.get(entry.userId);
      const registered = competition.registeredPlayers?.[entry.userId] || entry;
      competitor.username = gDU(registered);
      competitor.discordUsername = gDU(registered);
      competitor.ign = gIgn(registered);
      competitor.uuid = gUuid(registered);
      competitor.elo = gElo(registered);
      competitor.computedPoints += entry.seedPoints;
      competitor.averageSeedCount += 1;
      competitor.totalEffectiveTimeSeconds += entry.effectiveTimeSeconds;
      if(entry.played === true){
        competitor.seedCount += 1;
      }
      if(entry.dnf){
        competitor.dnfCount += 1;
      }
    }
  }

  for(const [userId, adjustment] of Object.entries(competition.pointAdjustments ||{})){
    if(!competitors.has(userId)){
      continue;
    }
    competitors.get(userId).manualAdjustment += adjustment;
  }

  return Array.from(competitors.values())
    .map((competitor) => ({
      ...competitor,
      averageTimeSeconds: competitor.averageSeedCount > 0 ? competitor.totalEffectiveTimeSeconds / competitor.averageSeedCount : null,
      totalPoints: competitor.computedPoints + competitor.manualAdjustment,
    }))
    .filter((competitor)=>competitor.seedCount > 0)
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

function gZData(competition){
  const leaderboard = gLB(competition);
  const entries = leaderboard.filter((entry)=>typeof entry.averageTimeSeconds === 'number');
  if(entries.length === 0){
    return { mean: null, stdDev: null, scores: new Map(), entries: leaderboard };
  }

  const mean = entries.reduce((sum, entry)=>sum + entry.averageTimeSeconds, 0) / entries.length;
  const variance = entries.reduce((sum, entry)=>sum + ((entry.averageTimeSeconds - mean) ** 2), 0) / entries.length;
  const stdDev = Math.sqrt(variance);
  const scores = new Map();

  for(const entry of entries){
    const zScore = stdDev === 0 ? 0 : (mean - entry.averageTimeSeconds) / stdDev;
    scores.set(entry.userId, zScore);
  }

  return { mean, stdDev, scores, entries: leaderboard };
}

function gZ(competition, userId){
  return gZData(competition).scores.get(userId) ?? null;
}

function fZ(value){
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

function uBestZ(db, competition){
  const leagueKey = String(competition.leagueNumber);
  const { scores, entries } = gZData(competition);

  for(const entry of entries){
    const zScore = scores.get(entry.userId);
    if(typeof zScore !== 'number' || !Number.isFinite(zScore)){
      continue;
    }
    const existing = db.players[entry.userId] || {};
    const bestZScores = { ...(existing.bestZScores || {}) };
    if(typeof bestZScores[leagueKey] !== 'number' || zScore > bestZScores[leagueKey]){
      bestZScores[leagueKey] = zScore;
    }
    db.players[entry.userId] = {
      ...existing,
      userId: entry.userId,
      discordUsername: gDU(entry),
      league: existing.league ?? competition.leagueNumber,
      bestZScores,
      updatedAt: new Date().toISOString(),
    };
  }
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
  return guild.roles.cache.find((role) => role.name.trim().toLowerCase() === 'league helper');
}

function tLB(left, right){
  if(!left || !right){
    return false;
  }
  return left.totalPoints === right.totalPoints && left.averageTimeSeconds === right.averageTimeSeconds;
}

function tDem(left, right){
  return tLB(left, right) && left.seedCount === right.seedCount;
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

function xBotDem(entries, count){
  if(count <= 0 || entries.length === 0){
    return [];
  }

  const ordered = [...entries].sort((left, right)=>{
    if(left.totalPoints !== right.totalPoints){
      return left.totalPoints - right.totalPoints;
    }
    const leftAverage = left.averageTimeSeconds ?? Number.MAX_SAFE_INTEGER;
    const rightAverage = right.averageTimeSeconds ?? Number.MAX_SAFE_INTEGER;
    if(leftAverage !== rightAverage){
      return rightAverage - leftAverage;
    }
    if(left.seedCount !== right.seedCount){
      return left.seedCount - right.seedCount;
    }
    return fPN(left).localeCompare(fPN(right));
  });
  const selected = ordered.slice(0, Math.min(count, ordered.length));
  let boundaryIndex = selected.length - 1;

  while(boundaryIndex + 1 < ordered.length && tDem(ordered[boundaryIndex], ordered[boundaryIndex + 1])){
    boundaryIndex += 1;
    selected.push(ordered[boundaryIndex]);
  }

  const selectedIds = new Set(selected.map((entry)=>entry.userId));
  return entries.filter((entry)=>selectedIds.has(entry.userId));
}

function iDemProt(db, entry, competition){
  const record = db.players?.[entry.userId];
  if(!record || record.league !== competition.leagueNumber){
    return false;
  }
  const lastWeek = Number(record.lastDemotedWeek);
  const currentWeek = Number(competition.week ?? competition.weekNumber);
  return Number.isInteger(lastWeek) && Number.isInteger(currentWeek) && currentWeek - lastWeek < DEMOTION_COOLDOWN_WEEKS;
}

function fDemPN(db, entry, competition){
  const name = fPN(entry);
  return iDemProt(db, entry, competition) ? `[${name}]` : name;
}

function hL7Fast(competition, userId){
  for(const seed of Object.values(competition.seeds || {})){
    if(seed.imported !== true){
      continue;
    }
    const entry = gSD(competition, seed).find((seedEntry)=>seedEntry.userId === userId);
    if(entry && !entry.dnf && typeof entry.timeSeconds === 'number' && entry.timeSeconds < LEAGUE_7_FAST_TIME){
      return true;
    }
  }
  return false;
}

function qL7(competition, entry){
  return entry.seedCount > 0
    && (hL7Fast(competition, entry.userId)
      || (typeof entry.averageTimeSeconds === 'number' && entry.averageTimeSeconds < LEAGUE_7_AVG_TIME));
}

function gMP(competition){
  if(iCh(competition)){
    recalcCh(competition);
    const finalSeed = gCurS(competition);
    const leaderboard = finalSeed?.imported ? gSD(competition, finalSeed) : [];
    return {
      leaderboard,
      promotions: leaderboard.slice(0, 2),
      demotions: [],
    };
  }

  const leaderboard = gLB(competition);
  const db = ldPdb();
  const defaultPromotionCount = Math.round(leaderboard.length * 0.15);
  const demotionRate = competition.leagueNumber === 1 ? 0.2 : 0.15;
  const defaultDemotionCount = Math.round(leaderboard.length * demotionRate);
  const demotionCap = defaultDemotionCount;
  const promotionMoveCount = Math.max(0, competition.manualPromotionCount ?? defaultPromotionCount);
  const requestedDemotionCount = Math.max(0, competition.manualDemotionCount ?? defaultDemotionCount);
  const demotionMoveCount = Math.min(requestedDemotionCount, demotionCap);
  const results ={ leaderboard, promotions: [], demotions: [] };

  if(competition.leagueNumber === 7){
    results.promotions = leaderboard.filter((entry)=>qL7(competition, entry));
    return results;
  }

  if(promotionMoveCount === 0 && demotionMoveCount === 0){
    return results;
  }

  const promotionPool = leaderboard;
  const basePromotions = competition.leagueNumber > 1 ? xTop(promotionPool, promotionMoveCount) : [];
  const promotedIds = new Set(basePromotions.map((entry) => entry.userId));
  const demotionPool = leaderboard.filter((entry) => !promotedIds.has(entry.userId));
  const demotionCandidates = competition.leagueNumber < LOWEST_DEMOTABLE_LEAGUE ? xBotDem(demotionPool, demotionMoveCount) : [];
  const baseDemotions = demotionCandidates.filter((entry)=>!iDemProt(db, entry, competition));

  results.promotions = basePromotions;
  results.demotions = baseDemotions;
  return results;
}

async function applyLeagueMovements(interaction, competition){
  const guild = interaction.guild;
  const db = ldPdb();

  if(!guild){
    throw new Error('League movements can only run in a server.');
  }
  if(iT(competition)){
    return { promoted: [], demoted: [], skipped: ['Test mode is enabled, so role changes were skipped.'] };
  }

  const movementPlan = gMP(competition);
  const results = { promoted: [], demoted: [], skipped: [] };
  const sourceRole = gLR(guild, competition.leagueNumber);
  const promoteRole = competition.leagueNumber > 1 ? gLR(guild, competition.leagueNumber - 1) : null;
  const demoteRole = competition.leagueNumber < LOWEST_DEMOTABLE_LEAGUE ? gLR(guild, competition.leagueNumber + 1) : null;

  for(const entry of movementPlan.promotions){
    try{
      const member = await guild.members.fetch(entry.userId);
      if(sourceRole){
        await member.roles.remove(sourceRole).catch(() => {});
      }
      await member.roles.add(promoteRole);
      sPRecById(db, entry.userId, gDU(entry), competition.leagueNumber - 1);
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
      sDemRec(db, entry.userId, gDU(entry), competition.leagueNumber + 1, competition);
      results.demoted.push(fPN(entry));
    } catch(error){
      results.skipped.push(`${fPN(entry)} (demotion failed)`);
    }
  }

  svPdb(db);
  return results;
}

function fCL(competition){
  return `League ${competition.leagueNumber}${iCh(competition) ? ' Championship' : ''}${iT(competition) ? ' [TEST]' : ''}`;
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

function fChLB(competition){
  recalcCh(competition);
  const currentSeed = gCurS(competition);
  const activeIds = competition.championship.originalEntrantIds.length > 0
    ? competition.championship.activePlayerIds || []
    : gRegs(competition).map((player)=>player.userId);
  const eliminatedIds = competition.championship.eliminatedPlayerIds || [];
  const latestStandings = currentSeed?.imported ? gSD(competition, currentSeed) : [];
  const standingOrder = new Map(latestStandings.map((entry, index)=>[entry.userId, index]));
  const active = activeIds.map((id)=>competition.registeredPlayers[id]).filter(Boolean).sort((left, right)=>{
    const leftIndex = standingOrder.get(left.userId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = standingOrder.get(right.userId) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
  const eliminated = eliminatedIds.map((id)=>competition.registeredPlayers[id]).filter(Boolean);
  const lines = [
    `**${fCL(competition)}**`,
    `Status: ${fCS(competition)}`,
    `Current seed: ${currentSeed?.name || 'none'}`,
    `Remaining: ${active.length}/${competition.championship.originalEntrantIds.length}`,
  ];

  for(let index = 0; index < active.length; index += 1){
    lines.push(`${index + 1}. ${fPN(active[index])}`);
  }
  if(eliminated.length > 0){
    lines.push('-----');
    for(const player of eliminated){
      lines.push(`${fPN(player)} - eliminated`);
    }
  }
  return lines.join('\n');
}

function fChFR(competition){
  recalcCh(competition);
  const finalSeed = gCurS(competition);
  if(!finalSeed?.imported){
    return `${fCL(competition)} results:\nThe final seed has not been imported.`;
  }
  const standings = gSD(competition, finalSeed);
  const winnerId = competition.championship.activePlayerIds[0] || null;
  const winner = standings.find((entry)=>entry.userId === winnerId) || standings[0] || null;
  const runnerUp = standings.find((entry)=>entry.userId !== winner?.userId) || null;
  const lines = [`${fCL(competition)} results:`];
  for(let index = 0; index < standings.length; index += 1){
    const entry = standings[index];
    const crown = entry.userId === winnerId ? ' - Champion' : index === 1 ? ' - Second place' : '';
    lines.push(entry.dnf ? `${fPN(entry)}: dnf${crown}` : `${formatPlacement(entry)}. ${fPN(entry)} - ${fT(entry.timeSeconds)}${crown}`);
  }
  lines.push('-----');
  lines.push('Congratulations!');
  lines.push(`Winner: ${winner ? fPN(winner) : 'none'}`);
  lines.push(`Runner-up: ${runnerUp ? fPN(runnerUp) : 'none'}`);
  return lines.join('\n');
}

function fLB(competition){
  if(iCh(competition)){
    return fChLB(competition);
  }
  const movementPlan = gMP(competition);
  const leaderboard = movementPlan.leaderboard;
  const currentSeed = gCurS(competition);
  const db = ldPdb();
  const displaySize = leaderboard.length;
  const promotionCount = movementPlan.promotions.length;
  const demotionCount = movementPlan.demotions.length;
  const demotedIds = new Set(movementPlan.demotions.map((entry)=>entry.userId));
  const firstDemotionIndex = leaderboard.findIndex((entry)=>demotedIds.has(entry.userId));
  const demotionStartRank = firstDemotionIndex >= 0 ? firstDemotionIndex + 1 : null;
  const breakRanks = new Set();

  if(promotionCount > 0 && promotionCount < leaderboard.length){
    breakRanks.add(promotionCount);
  }
  if(demotionCount > 0 && demotionStartRank > 1){
    breakRanks.add(demotionStartRank - 1);
  }

  if(leaderboard.length === 0){
    return `**${fCL(competition)}** has no submitted results yet.`;
  }

  const lines = [];

  for(let rank = 1; rank <= displaySize; rank += 1){
    const entry = leaderboard[rank - 1];
    lines.push(entry ? `${rank}. ${fDemPN(db, entry, competition)} - ${entry.totalPoints} pts - ${fT(entry.averageTimeSeconds)}` : `${rank}. [empty]`);

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

function fFR(competition, movementPlan = null){
  if(iCh(competition)){
    return fChFR(competition);
  }
  movementPlan = movementPlan || gMP(competition);
  const leaderboard = movementPlan.leaderboard;
  const db = ldPdb();

  if(leaderboard.length === 0){
    return `League ${competition.leagueNumber} results:\nNo final results recorded.`;
  }

  const promotionCount = movementPlan.promotions.length;
  const demotionCount = movementPlan.demotions.length;
  const demotedIds = new Set(movementPlan.demotions.map((entry)=>entry.userId));
  const middleStart = promotionCount;
  const firstDemotionIndex = leaderboard.findIndex((entry)=>demotedIds.has(entry.userId));
  const middleEnd = firstDemotionIndex >= 0 ? Math.max(middleStart, firstDemotionIndex) : leaderboard.length;
  const lines = [`League ${competition.leagueNumber} results:`];

  const pushSection =(entries, startIndex) =>{
    for(let i = 0; i < entries.length; i += 1){
      const entry = entries[i];
      lines.push(`${startIndex + i + 1}. ${fDemPN(db, entry, competition)} - ${entry.totalPoints} pts - ${fT(entry.averageTimeSeconds)}`);
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
    lines.push(iCh(competition)
      ? `${formatPlacement(entry)}. ${fPN(entry)} - ${fT(entry.timeSeconds)}`
      : `${formatPlacement(entry)}. ${fPN(entry)} - ${entry.seedPoints} pts - ${fT(entry.timeSeconds)}`);
  }

  for(const entry of dnfs){
    lines.push(iCh(competition) ? `${fPN(entry)}: dnf` : `${fPN(entry)}: dnf - ${entry.seedPoints} pts`);
  }

  if(iCh(competition) && seed.eliminatedIds?.length){
    lines.push('-----');
    lines.push(`Eliminated: ${seed.eliminatedIds.map((id)=>fPN(competition.registeredPlayers[id] || { discordUsername: id, ign: id })).join(', ')}`);
  }

  const limitLabel = iCh(competition)
    ? `Cutoff: ${seed.cutoffTimeMs === null ? `first completion + ${fT(gChCfg(competition).graceMs)}` : fT(seed.cutoffTimeMs)}`
    : `Seed time limit: ${fT(seed.timeLimitSeconds)}`;
  return [`Seed **${seed.name}** results for ${fCL(competition)}`, limitLabel, ...lines].join('\n');
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
  const summary = gCS(competition, user.id);

  if(!summary){
    return `${user.username} has no recorded results.`;
  }

  for(const seed of Object.values(competition.seeds).sort((left, right) => left.name.localeCompare(right.name))){
    if(!seed.imported){
      continue;
    }
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
  if(iCh(competition)){
    recalcCh(competition);
    const player = competition.registeredPlayers?.[user.id] || { discordUsername: user.username, ign: user.username };
    const active = competition.championship.activePlayerIds.includes(user.id);
    const eliminated = competition.championship.eliminatedPlayerIds.includes(user.id);
    const lines = [`**${fPN(player)}** in ${fCL(competition)}`, `Status: ${eliminated ? 'eliminated' : active ? 'active' : 'registered'}`];
    for(const seed of Object.values(competition.seeds).sort((left, right)=>Number(left.name) - Number(right.name))){
      if(!seed.imported){
        continue;
      }
      const seedEntry = gSD(competition, seed).find((standingEntry)=>standingEntry.userId === user.id);
      if(seedEntry && seedEntry.played === true){
        lines.push(seedEntry.dnf ? `${seed.name}: dnf` : `${seed.name}: ${formatPlacement(seedEntry)} - ${fT(seedEntry.timeSeconds)}`);
      }
    }
    return lines.join('\n');
  }
  const placements = [];
  const displayPlayer = competition.registeredPlayers?.[user.id] || entry || { discordUsername: user.username, ign: user.username };
  const zScore = gZ(competition, user.id);

  for(const seed of Object.values(competition.seeds).sort((left, right) => left.name.localeCompare(right.name))){
    if(!seed.imported || !entry){
      continue;
    }
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
    `Z-Score: ${fZ(zScore)}`,
    placements.length > 0 ? 'Placements:' : 'Placements: none',
    ...placements,
  ].join('\n');
}

function fZLb(db, league){
  const leagueKey = String(league);
  const entries = Object.values(db.players || {})
    .map((player)=>({
      userId: player.userId,
      discordUsername: player.discordUsername,
      zScore: player.bestZScores?.[leagueKey],
    }))
    .filter((player)=>typeof player.zScore === 'number' && Number.isFinite(player.zScore))
    .sort((left, right)=>{
      if(right.zScore !== left.zScore){
        return right.zScore - left.zScore;
      }
      return eMd(left.discordUsername || '').localeCompare(eMd(right.discordUsername || ''));
    })
    .slice(0, 10);

  if(entries.length === 0){
    return `No saved z-scores for League ${league}.`;
  }

  return entries.map((player, index)=>`${index + 1}. ${eMd(player.discordUsername || player.userId)} ${fZ(player.zScore)}`).join('\n');
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
    uuid: gUuid(user),
    elo: gElo(user),
    twitch: gTw(user),
    dnf,
    sourceDnf: dnf,
    played: true,
    placement: null,
    timeSeconds,
    rawTimeSeconds: timeSeconds,
    submittedAt: new Date().toISOString(),
  };

  return existingEntry;
}

function impM(c, seed, rows){
  const regByUuid = new Map();
  const regByIgn = new Map();

  for(const p of gEP(c, seed)){
    const key = gUuid(p);
    if(key){
      regByUuid.set(nn(key), p);
    }
    const ign = gIgn(p);
    if(ign){
      regByIgn.set(nn(ign), p);
    }
  }

  seed.results = mkDR(c, seed);
  const used = new Set();
  const matched = [];
  const missing = [];

  for(const row of rows){
    const p = regByUuid.get(nn(row.playerUuid)) || regByIgn.get(nn(row.playerName));
    if(!p || used.has(p.userId)){
      missing.push(row.playerName);
      continue;
    }

    // Get registrations then use UUID
    if(nn(gUuid(p)) !== nn(row.playerUuid)){
      p.uuid = row.playerUuid;
      if(c.registeredPlayers?.[p.userId]){
        c.registeredPlayers[p.userId].uuid = row.playerUuid;
      }
    }
    aSR(seed, p, row.dnf ? null : row.timeMs, Boolean(row.dnf));
    used.add(p.userId);
    matched.push({
      name: fPN(p),
      dnf: Boolean(row.dnf),
      timeMs: row.timeMs,
    });
  }

  seed.playerCount = gEP(c, seed).length;
  return { matched, missing };
}

async function getUserDataFromDiscord(id){
  try{
      const response=await fetch(`https://api.mcsrranked.com/users/discord.${id}`);
      if(!response.ok){
        throw new Error(`Network error: ${response.status} ${response.statusText}`);
      }
      const profile = gProf(await response.json());
      if(!profile.uuid || !profile.ign){
        throw new Error('Linked account is missing UUID or nickname data.');
      }
      return profile;
    } catch(err){
      throw new Error('Could not find a Minecraft account linked to your discord account. For help linking your account run /link');
    }
}

async function getUserDataFromIdentifier(identifier){
  try{
      const response=await fetch(`https://api.mcsrranked.com/users/${encodeURIComponent(String(identifier).trim())}`);
      if(!response.ok){
        throw new Error(`Network error: ${response.status} ${response.statusText}`);
      }
      const profile = gProf(await response.json());
      if(!profile.uuid || !profile.ign){
        throw new Error('Linked account is missing UUID or nickname data.');
      }
      return profile;
    } catch(err){
      throw new Error(`Could not find the MCSR account "${identifier}".`);
    }
}

function gDiscordConnection(data){
  const connections = data?.connections || {};
  const direct = connections.discord || connections.Discord || null;
  if(direct?.id){
    return { id: String(direct.id), name: direct.name || null };
  }
  for(const [type, connection] of Object.entries(connections)){
    if((nn(type) === 'discord' || nn(connection?.name) === 'discord') && connection?.id){
      return { id: String(connection.id), name: nn(type) === 'discord' ? connection.name || null : null };
    }
  }
  return null;
}

async function getForceImportPlayer(identifier){
  const response = await fetch(`https://api.mcsrranked.com/users/${encodeURIComponent(String(identifier).trim())}`);
  if(!response.ok){
    throw new Error(`MCSR profile lookup failed for ${identifier}: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const data = payload?.data || payload || {};
  const profile = gProf(payload);
  const discord = gDiscordConnection(data);
  if(!profile.uuid || !profile.ign){
    throw new Error(`MCSR profile lookup for ${identifier} did not return a UUID and nickname.`);
  }
  if(!discord?.id){
    throw new Error(`${profile.ign} does not have a Discord account linked on MCSR Ranked.`);
  }
  return { ...profile, discordId: discord.id, discordUsername: discord.name };
}

function gReports(store){
  store.settings.scoreReports = store.settings.scoreReports || {};
  return store.settings.scoreReports;
}

function newReportId(){
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function reportPair(userId1, userId2){
  return [userId1, userId2].sort().join(':');
}

function isOpenReport(report){
  return ['awaiting_submissions', 'awaiting_confirmation', 'awaiting_review'].includes(report?.status);
}

function expireReports(store){
  const now = Date.now();
  let changed = false;
  for(const report of Object.values(gReports(store))){
    if(['awaiting_submissions', 'awaiting_confirmation'].includes(report.status) && now - Date.parse(report.createdAt) >= REPORT_EXPIRY_MS){
      report.status = 'expired';
      report.closedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

function findOpenReport(store, guildId, channelId, userId1, userId2){
  const pair = reportPair(userId1, userId2);
  return Object.values(gReports(store)).find((report)=>
    isOpenReport(report)
    && report.guildId === guildId
    && report.channelId === channelId
    && report.pairKey === pair,
  ) || null;
}

function playerScore(reporterId, opponentId, score){
  const [ownWins, opponentWins] = String(score).split('-').map(Number);
  if(![ownWins, opponentWins].includes(2) || ownWins === opponentWins || Math.max(ownWins, opponentWins) !== 2 || Math.min(ownWins, opponentWins) > 1){
    throw new Error('Score must be a valid best-of-three result.');
  }
  const reporterWon = ownWins === 2;
  return {
    winnerId: reporterWon ? reporterId : opponentId,
    loserId: reporterWon ? opponentId : reporterId,
    winnerScore: 2,
    loserScore: reporterWon ? opponentWins : ownWins,
  };
}

function sameScore(left, right){
  return left.winnerId === right.winnerId
    && left.loserId === right.loserId
    && left.winnerScore === right.winnerScore
    && left.loserScore === right.loserScore;
}

function reportPlayer(report, userId){
  return report.players?.[userId] || { userId, username: userId };
}

function reportPlayerName(report, userId){
  const player = reportPlayer(report, userId);
  return eMd(player.displayName || player.username);
}

function reportResult(report){
  const winner = reportPlayerName(report, report.winnerId);
  const loser = reportPlayerName(report, report.loserId);
  return `${winner} beat ${loser} with a score of ${report.winnerScore}-${report.loserScore}.`;
}

function submittedResult(report, submission){
  const winner = reportPlayerName(report, submission.winnerId);
  const loser = reportPlayerName(report, submission.loserId);
  return `${winner} beat ${loser} ${submission.winnerScore}-${submission.loserScore}`;
}

function pendingReportRows(report){
  return [new MessageActionRow().addComponents(
    new MessageButton().setCustomId(`score_cancel:${report.id}`).setLabel('Cancel Report').setStyle('SECONDARY'),
    new MessageButton().setCustomId(`score_dispute:${report.id}`).setLabel('Dispute').setStyle('DANGER'),
  )];
}

function disputeReportRows(report){
  return [new MessageActionRow().addComponents(
    new MessageButton().setCustomId(`score_dispute:${report.id}`).setLabel('Dispute').setStyle('DANGER'),
  )];
}

function confirmReportRows(report){
  return [new MessageActionRow().addComponents(
    new MessageButton().setCustomId(`score_confirm:${report.id}`).setLabel('Confirm').setStyle('SUCCESS'),
    new MessageButton().setCustomId(`score_dispute:${report.id}`).setLabel('Dispute').setStyle('DANGER'),
  )];
}

function reviewReportRows(report){
  return [new MessageActionRow().addComponents(
    new MessageButton().setCustomId(`score_approve:${report.id}`).setLabel('Approve').setStyle('SUCCESS'),
    new MessageButton().setCustomId(`score_reject:${report.id}`).setLabel('Reject').setStyle('DANGER'),
  )];
}

async function reportUsers(report){
  return Promise.all(Object.keys(report.players).map((userId)=>client.users.fetch(userId).catch(()=>null)));
}

async function notifyReportPlayers(report, content){
  const users = await reportUsers(report);
  await Promise.all(users.filter(Boolean).map((user)=>user.send(content).catch(()=>null)));
}

async function sendReportReview(report){
  const reviewer = await client.users.fetch(REPORT_REVIEWER_ID);
  const lines = report.adminReport
    ? ['**ADMIN REPORT**', `Submitted by: ${eMd(report.adminDisplayName || report.adminUsername)} (<@${report.adminId}>)`]
    : ['**PLAYER-CONFIRMED REPORT**'];
  lines.push(reportResult(report));
  lines.push(`League: ${report.leagueNumber ?? 'n/a'}`);
  if(report.week){
    lines.push(`Week: ${report.week}`);
  }
  const message = await reviewer.send({ content: lines.join('\n'), components: reviewReportRows(report) });
  report.reviewMessageId = message.id;
  report.reviewSentAt = new Date().toISOString();
}

async function handleScoreButton(interaction){
  await withStoreLock(async()=>{
    const [, reportId] = interaction.customId.split(':');
    const store = ldS();
    if(expireReports(store)){
      svS(store);
    }
    const report = gReports(store)[reportId];
    if(!report){
      await interaction.reply({ content: 'This score report no longer exists.', ephemeral: true });
      return;
    }

    const action = interaction.customId.split(':')[0];
    const participant = Boolean(report.players?.[interaction.user.id]);
    if(action === 'score_cancel'){
      if(interaction.user.id !== report.reporterId || !['awaiting_submissions', 'awaiting_confirmation'].includes(report.status)){
        await interaction.reply({ content: 'This report cannot be cancelled by you.', ephemeral: true });
        return;
      }
      report.status = 'cancelled';
      report.closedAt = new Date().toISOString();
      report.closedBy = interaction.user.id;
      svS(store);
      await interaction.update({ content: 'Score report cancelled.', components: [] });
      await notifyReportPlayers(report, 'The score report was cancelled. Both players may submit a corrected report.');
      return;
    }

    if(action === 'score_dispute'){
      if(!participant || !['awaiting_submissions', 'awaiting_confirmation'].includes(report.status)){
        await interaction.reply({ content: 'This report cannot be disputed by you.', ephemeral: true });
        return;
      }
      report.status = 'disputed';
      report.closedAt = new Date().toISOString();
      report.closedBy = interaction.user.id;
      svS(store);
      await interaction.update({ content: 'Score report disputed.', components: [] });
      await notifyReportPlayers(report, 'The score report was disputed and closed. Both players must submit a new corrected report.');
      return;
    }

    if(action === 'score_confirm'){
      if(!participant || report.status !== 'awaiting_confirmation'){
        await interaction.reply({ content: 'This report is not awaiting your confirmation.', ephemeral: true });
        return;
      }
      report.confirmations[interaction.user.id] = true;
      const confirmed = Object.keys(report.players).every((userId)=>report.confirmations[userId] === true);
      if(!confirmed){
        svS(store);
        await interaction.update({ content: `Confirmed: ${reportResult(report)} Waiting for the other player.`, components: [] });
        return;
      }
      report.status = 'awaiting_review';
      report.confirmedAt = new Date().toISOString();
      svS(store);
      try{
        await sendReportReview(report);
      }catch(error){
        report.status = 'awaiting_confirmation';
        report.confirmations[interaction.user.id] = false;
        svS(store);
        await interaction.reply({ content: 'Could not send this report to the reviewer. Please try again later.', ephemeral: true });
        return;
      }
      svS(store);
      await interaction.update({ content: `Confirmed: ${reportResult(report)} The report was sent for review.`, components: [] });
      await notifyReportPlayers(report, 'Both players confirmed the score. It has been sent for review.');
      return;
    }

    if(action === 'score_approve' || action === 'score_reject'){
      if(interaction.user.id !== REPORT_REVIEWER_ID){
        await interaction.reply({ content: 'Only the configured reviewer can use these buttons.', ephemeral: true });
        return;
      }
      if(report.status !== 'awaiting_review'){
        await interaction.reply({ content: 'This report has already been reviewed.', ephemeral: true });
        return;
      }
      if(action === 'score_reject'){
        report.status = 'rejected';
        report.reviewedAt = new Date().toISOString();
        report.reviewerId = interaction.user.id;
        svS(store);
        await interaction.update({ content: `${interaction.message.content}\n\n**Rejected**`, components: [] });
        await notifyReportPlayers(report, 'Your score report was rejected. Nothing was posted.');
        return;
      }

      const guild = client.guilds.cache.get(report.guildId) || await client.guilds.fetch(report.guildId).catch(()=>null);
      let channel = guild?.channels.cache.get(REPORT_CHANNEL_ID) || null;
      if(!channel && guild){
        channel = await guild.channels.fetch(REPORT_CHANNEL_ID).catch(()=>null);
      }
      if(!channel?.isText?.()){
        await interaction.reply({ content: `Could not find report channel ${REPORT_CHANNEL_ID} in the report server.`, ephemeral: true });
        return;
      }
      const posted = await channel.send(reportResult(report));
      report.status = 'approved';
      report.reviewedAt = new Date().toISOString();
      report.reviewerId = interaction.user.id;
      report.resultChannelId = channel.id;
      report.resultMessageId = posted.id;
      svS(store);
      await interaction.update({ content: `${interaction.message.content}\n\n**Approved**`, components: [] });
      await notifyReportPlayers(report, `Your score report was approved and posted in <#${REPORT_CHANNEL_ID}>.`);
    }
  });
}

const client = new Client({
  intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILD_MESSAGES],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  setInterval(()=>{
    withStoreLock(async()=>{
      const store = ldS();
      if(expireReports(store)){
        svS(store);
      }
    }).catch((error)=>console.error('Score report expiry check failed.', error));
  }, 60 * 60 * 1000);
});

client.on('messageCreate', async(message)=>{
  try{
    if(!message.guild || !message.channel){
      return;
    }
    if(message.author?.bot){
      return;
    }
    if(message.channel.name !== SIGNUP_CHANNEL){
      return;
    }
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(()=>null);
    if(!member){
      return;
    }
    if(gAR(message.guild) && member.roles.cache.has(gAR(message.guild).id)){
      return;
    }
    await message.delete().catch(()=>{});
  }catch(error){
    console.error('Failed to moderate signup channel message.', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if(interaction.isButton()){
    try{
      const parts = interaction.customId.split(':');
      const action = parts[0];

      if(!action){
        return;
      }

      if(action.startsWith('score_')){
        await handleScoreButton(interaction);
        return;
      }

      if(action.startsWith('import_')){
        const [, , userId] = parts;
        if(interaction.user.id !== userId){
          await interaction.reply({ content: 'Only the League Helper who used /import can choose this option.', ephemeral: true });
        }
        return;
      }

      if(action.startsWith('signup_')){
        const [, guildId, applicantId, reviewerId, leagueValue] = parts;
        const league = Number(leagueValue);
        const store = ldS();
        const db = ldPdb();

        if(interaction.user.id !== reviewerId){
          await interaction.reply({ content: 'Only the reviewer can use these signup buttons.', ephemeral: true });
          return;
        }

        if(action === 'signup_pick'){
          await interaction.update({
            content: `Place <@${applicantId}> into League ${league}?`,
            components: mkSignupConfirmBtns(guildId, applicantId, reviewerId, league),
          });
          return;
        }

        if(action === 'signup_back'){
          await interaction.update({
            content: `Select a league for <@${applicantId}>.`,
            components: mkSignupBtns(guildId, applicantId, reviewerId),
          });
          return;
        }

        if(action === 'signup_deny'){
          delSR(store, guildId, applicantId);
          svS(store);
          const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          const applicant = guild ? await guild.members.fetch(applicantId).catch(() => null) : null;
          await applicant?.user?.send('Your league signup request was denied.').catch(() => {});
          await interaction.update({ content: `Denied the signup request for <@${applicantId}>.`, components: [] });
          return;
        }

        if(action === 'signup_confirm'){
          const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if(!guild){
            await interaction.reply({ content: 'Could not find the server for this signup.', ephemeral: true });
            return;
          }

          const applicant = await guild.members.fetch(applicantId).catch(() => null);
          if(!applicant){
            await interaction.reply({ content: 'Could not find the applicant in that server.', ephemeral: true });
            return;
          }

          const targetRole = gLR(guild, league);
          if(!targetRole){
            await interaction.reply({ content: `Could not find the League ${league} role.`, ephemeral: true });
            return;
          }

          const currentLeague = gMRN(applicant);
          if(currentLeague){
            const currentRole = gLR(guild, currentLeague);
            if(currentRole){
              await applicant.roles.remove(currentRole).catch(() => {});
            }
          }

          await applicant.roles.add(targetRole);
          const pending = gSR(store, guildId, applicantId);
          delSR(store, guildId, applicantId);
          sPRec(db, applicant.user, null, league);
          svS(store);
          svPdb(db);
          await interaction.update({ content: `Placed ${applicant.user.username} into League ${league}.`, components: [] });
          await applicant.user.send(`Welcome to ranked leagues! You have been placed into League ${league}. Please read all of the information carefully at <https://mscl.pages.dev/rules/organization/>. Best of luck, and enjoy competing!`).catch(() => {});
          return;
        }

        return;
      }

      const [, value1, value2] = parts;

      const channelId = value1;
      const userId = value2;

      if(!channelId || !userId){
        return;
      }

      if(interaction.user.id !== userId){
        await interaction.reply({ content: 'Only the League Helper who started this reset can use these buttons.', ephemeral: true });
        return;
      }

      if(!iA(interaction)){
        await interaction.reply({ content: 'Only users with the League Helper role can reset a competition.', ephemeral: true });
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
          if(!iT(channel.competition)){
            await rmAllCWR(interaction.guild, channel.competition);
          }
        }
        await dCompTrackedMsgs(interaction.guild, interaction.channel, channel.competition);
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
    let store;
    const admin = iA(interaction);
    let commandLogged = false;
    const originalReply = interaction.reply.bind(interaction);
    const originalFollowUp = interaction.followUp.bind(interaction);
    const originalEditReply = interaction.editReply.bind(interaction);
    const originalDeferReply = interaction.deferReply.bind(interaction);
    const normPayload = (payload, useEphemeral = true) =>{
      if(typeof payload === 'string'){
        return useEphemeral ?{ content: payload, ephemeral: true } : { content: payload };
      }
      if(!payload){
        return useEphemeral ? { ephemeral: true } : payload;
      }
      if(typeof payload !== 'object'){
        return payload;
      }
      if(useEphemeral){
        return { ...payload, ephemeral: true };
      }
      return payload;
    };
    let autoDeferred = false;
    let apiWarnShown = false;
    const apiWarns = [];
    const autoDefer = setTimeout(async () =>{
      if(interaction.deferred || interaction.replied){
        return;
      }
      autoDeferred = true;
      await originalDeferReply({ ephemeral: true }).catch(() => {});
    }, 1500);

    const markLogged = async () =>{
      if(!commandLogged && interaction.isCommand()){
        commandLogged = true;
        await logCmd(interaction, store);
      }
    };
    const addApiWarn = (payload)=>{
      if(apiWarnShown || apiWarns.length === 0){
        return payload;
      }
      apiWarnShown = true;
      const warning = `Website API warning: ${apiWarns.join(' ')}`;
      if(typeof payload === 'string'){
        return `${payload}\n\n${warning}`;
      }
      if(!payload){
        return { content: warning };
      }
      if(typeof payload !== 'object'){
        return payload;
      }
      return {
        ...payload,
        content: payload.content ? `${payload.content}\n\n${warning}` : warning,
      };
    };

    interaction.reply = async (payload) =>{
      clearTimeout(autoDefer);
      const safePayload = normPayload(addApiWarn(payload), true);
      const response = interaction.deferred && !interaction.replied
        ? await originalEditReply(safePayload)
        : await originalReply(safePayload);
      await markLogged();
      return response;
    };

    interaction.followUp = async (payload) =>{
      const safePayload = normPayload(addApiWarn(payload), true);
      return originalFollowUp(safePayload);
    };

    interaction.editReply = async (payload) =>{
      clearTimeout(autoDefer);
      const response = await originalEditReply(normPayload(addApiWarn(payload), true));
      await markLogged();
      return response;
    };

    interaction.deferReply = async (payload) =>{
      clearTimeout(autoDefer);
      autoDeferred = true;
      if(interaction.deferred || interaction.replied){
        return null;
      }
      return originalDeferReply(normPayload(payload, true));
    };

    const finish = async (payload) =>{
      if(interaction.deferred && !interaction.replied){
        return interaction.editReply(payload);
      }
      return interaction.reply(payload);
    };

    await withStoreLock(async()=>{
    store = ldS();
    apiWarnSink = (message)=>{
      if(!apiWarns.includes(message)){
        apiWarns.push(message);
      }
    };

    if(interaction.commandName === 'nm'){
      await interaction.deferReply();

      if(!admin){
        await interaction.editReply({ content: 'Only users with the League Helper role can start a competition.' });
        return;
      }

      const channelId = gCK(interaction);
      const channel = ensC(store, channelId);

      if(channel.competition){
        await interaction.editReply({ content: `This channel already has a ${fCS(channel.competition)} competition. Use /em or /dm first.` });
        return;
      }

      const leagueNumber = interaction.options.getInteger('league', true);
      const week = interaction.options.getInteger('week', true);
      const maxTimeLimitSeconds = gLim(store, leagueNumber);
      const infoChannel = await clrInfo(interaction.guild, leagueNumber);

      if(!infoChannel){
        await interaction.editReply({ content: `Could not find #${gInfoName(leagueNumber)}.` });
        return;
      }

      if(channel.testMode !== true && (!WEBSITE_URL || !WEBSITE_API_KEY)){
        await interaction.editReply({ content: 'Website API is not configured.' });
        return;
      }
      const newCompetition = {
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
        registrationOpen: false,
        scoreReportingEnabled: false,
        registrationMessageId: null,
        registrationMessageIds: [],
        initMessageId: null,
        initChannelId: interaction.channelId,
        infoChannelId: infoChannel.id,
        hostUserId: null,
        hostDiscordUsername: null,
        hostIgn: null,
        hostUuid: null,
        testMode: channel.testMode === true,
        finalMessageIds: [],
        finalChannelId: null,
        leaderboardMessageIds: [],
        registrationOpenBeforeEnd: null,
        manualPromotionCount: null,
        manualDemotionCount: null,
        movementsApplied: false,
      };
      await pushComp(newCompetition, '/api/write/competition', {
        leagueTier: leagueNumber,
        weekNumber: week,
        maxTimeLimitMs: maxTimeLimitSeconds,
        startingTime: Date.now(),
      }, 'POST');
      channel.competition = newCompetition;
      await cRegMsg(infoChannel, channel.competition);
      const initMessage = await interaction.editReply({
        content: `Started the current competition for League ${leagueNumber}. Registration is now closed. Time limit: ${fT(maxTimeLimitSeconds)}.`,
        fetchReply: true,
      });
      channel.competition.initMessageId = initMessage.id;
      svS(store);
      await markLogged();
      return;
    }

    if(interaction.commandName === 'championship'){
      await interaction.deferReply();
      if(!admin){
        await interaction.editReply({ content: 'Only users with the League Helper role can start a championship.' });
        return;
      }

      const channelId = gCK(interaction);
      const channel = ensC(store, channelId);
      if(channel.competition){
        await interaction.editReply({ content: `This channel already has a ${fCS(channel.competition)} competition. Use /em or /dm first.` });
        return;
      }

      const leagueNumber = interaction.options.getInteger('league', true);
      const config = CHAMPIONSHIPS[leagueNumber];
      if(!config){
        await interaction.editReply({ content: 'Championships are currently available for Leagues 2 through 6.' });
        return;
      }
      const infoChannel = await clrInfo(interaction.guild, leagueNumber);
      if(!infoChannel){
        await interaction.editReply({ content: `Could not find #${gInfoName(leagueNumber)}.` });
        return;
      }

      channel.competition = {
        mode: 'championship',
        leagueNumber,
        week: null,
        maxTimeLimitSeconds: config.graceMs,
        status: 'active',
        startedAt: new Date().toISOString(),
        endedAt: null,
        currentSeedKey: null,
        seeds: {},
        pointAdjustments: {},
        registeredPlayers: {},
        registrationOpen: false,
        scoreReportingEnabled: false,
        registrationMessageId: null,
        registrationMessageIds: [],
        initMessageId: null,
        initChannelId: interaction.channelId,
        infoChannelId: infoChannel.id,
        hostUserId: null,
        hostDiscordUsername: null,
        hostIgn: null,
        hostUuid: null,
        testMode: channel.testMode === true,
        finalMessageIds: [],
        finalChannelId: null,
        leaderboardMessageIds: [],
        registrationOpenBeforeEnd: null,
        manualPromotionCount: null,
        manualDemotionCount: null,
        movementsApplied: false,
        championship: {
          ...config,
          originalEntrantIds: [],
          activePlayerIds: [],
          eliminatedPlayerIds: [],
          targetFinalCount: null,
          eliminationCredit: 0,
        },
      };
      await cRegMsg(infoChannel, channel.competition);
      const initMessage = await interaction.editReply({
        content: `Started the League ${leagueNumber} Championship. Registration is closed. Seeds continue until one runner remains. The first-completion cutoff is +${fT(config.graceMs)}.`,
        fetchReply: true,
      });
      channel.competition.initMessageId = initMessage.id;
      svS(store);
      await markLogged();
      return;
    }

    if(interaction.commandName === 'em'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can end a competition.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));

      if(competition.status === 'ended'){
        await interaction.reply({ content: 'This competition is already ended.', ephemeral: true });
        return;
      }
      if(iCh(competition)){
        recalcCh(competition);
        if(competition.championship.activePlayerIds.length !== 1){
          await interaction.reply({ content: `The championship can only end when one runner remains. There are currently ${competition.championship.activePlayerIds.length}.`, ephemeral: true });
          return;
        }
      }

      const finalMovementPlan = iCh(competition) ? null : gMP(competition);

      await pushComp(competition, '/api/write/competition/status', {
        ...mkCP(competition),
        status: 'ended',
      }, 'PATCH');

      const removedNoPlay = await rmNoPlay(interaction.guild, competition);

      if(!iCh(competition)){
        const db = ldPdb();
        uBestZ(db, competition);
        svPdb(db);
      }

      competition.status = 'ended';
      competition.endedAt = new Date().toISOString();
      competition.registrationOpenBeforeEnd = competition.registrationOpen;
      competition.registrationOpen = false;
      competition.movementsApplied = false;
      if(!iT(competition)){
        await rmAllCWR(interaction.guild, competition);
      }
      const infoChannel = gInfoCh(interaction.guild, competition);
      await uPinMsg(infoChannel || interaction.channel, competition);

      const finalText = fFR(competition, finalMovementPlan);
      if(infoChannel){
        competition.finalMessageIds = await sendChunks(infoChannel, finalText);
        competition.finalChannelId = infoChannel.id;
        svS(store);
        await interaction.reply(`Ended ${fCL(competition)}. Final results were posted in #${infoChannel.name}.${removedNoPlay.length > 0 ? ` Removed ${removedNoPlay.length} player(s) who did not play any seeds.` : ''}`);
      } else{
        const messages = chunkMsg(finalText);
        const first = await interaction.reply({ content: messages[0], fetchReply: true });
        const ids = [first.id];
        for(let index = 1; index < messages.length; index += 1){
          const followUp = await interaction.followUp({ content: messages[index], fetchReply: true });
          ids.push(followUp.id);
        }
        competition.finalMessageIds = ids;
        competition.finalChannelId = interaction.channelId;
        svS(store);
      }
      return;
    }

    if(interaction.commandName === 'unend'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can undo ending a competition.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      if(competition.status !== 'ended'){
        await interaction.reply({ content: 'This competition is not currently ended.', ephemeral: true });
        return;
      }

      await pushComp(competition, '/api/write/competition/status', {
        ...mkCP(competition),
        status: 'active',
      }, 'PATCH');

      const finalChannel = competition.finalChannelId ? interaction.guild.channels.cache.get(competition.finalChannelId) : null;
      for(const messageId of competition.finalMessageIds || []){
        await dMsg(finalChannel || interaction.channel, messageId);
      }

      competition.status = 'active';
      competition.endedAt = null;
      competition.movementsApplied = false;
      competition.registrationOpen = competition.registrationOpenBeforeEnd ?? false;
      competition.registrationOpenBeforeEnd = null;
      competition.finalMessageIds = [];
      competition.finalChannelId = null;

      if(!iT(competition)){
        await addAllCWR(interaction.guild, competition);
      }
      const infoChannel = gInfoCh(interaction.guild, competition);
      await pRegMsg(infoChannel || interaction.channel, competition);
      svS(store);

      await interaction.reply({ content: `${fCL(competition)} has been reopened.`, ephemeral: true });
      return;
    }

    if(interaction.commandName === 'dm'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can reset a competition.', ephemeral: true });
        return;
      }
	  await interaction.deferReply(); 
      const channelId = gCK(interaction);
      const competition = rC(store, channelId);
	
      await interaction.editReply({
        content: 'Resetting will delete the current competition and all of its data Are you sure?',
        components: mkRB(channelId, interaction.user.id),
        ephemeral: true,
      });
      return;
    }
  
    if(interaction.commandName === 'ns'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can create seeds.', ephemeral: true });
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
      if(iCh(competition)){
        const config = gChCfg(competition);
        const previousSeed = gCurS(competition);
        if(previousSeed && !previousSeed.imported){
          await interaction.reply({ content: `Import Seed ${previousSeed.name} before creating the next championship seed.`, ephemeral: true });
          return;
        }
        if(Number(seedName) === 1){
          const minimumEntrants = 2;
          if(gRC(competition) < minimumEntrants){
            await interaction.reply({ content: `This championship needs at least ${minimumEntrants} registered runners.`, ephemeral: true });
            return;
          }
          competition.championship.originalEntrantIds = gRegs(competition).map((player)=>player.userId);
          competition.championship.activePlayerIds = [...competition.championship.originalEntrantIds];
          competition.championship.targetFinalCount = 1;
        }else{
          recalcCh(competition);
        }
        if(competition.championship.activePlayerIds.length === 1){
          await interaction.reply({ content: `The championship has ended. ${fPN(competition.registeredPlayers[competition.championship.activePlayerIds[0]])} is the winner, so no new seed can be created.`, ephemeral: true });
          return;
        }
        if(competition.championship.activePlayerIds.length < 1){
          await interaction.reply({ content: 'No runners remain for the next seed.', ephemeral: true });
          return;
        }
      }

      await pushComp(competition, '/api/write/match/create', {
        ...mkCP(competition),
        matchNumber: Number(seedName),
      }, 'POST');

      competition.seeds[seedKey] = {
        name: seedName,
        playerCount: iCh(competition) ? competition.championship.activePlayerIds.length : gRC(competition),
        timeLimitSeconds: competition.maxTimeLimitSeconds,
        editingEnabled: true,
        imported: false,
        rankedMatchId: null,
        createdAt: new Date().toISOString(),
        entrantIds: iCh(competition) ? [...competition.championship.activePlayerIds] : null,
        eliminatedIds: [],
        cutoffTimeMs: null,
        results: null,
      };
      competition.seeds[seedKey].results = mkDR(competition, competition.seeds[seedKey]);
      competition.currentSeedKey = seedKey;
      if(iCh(competition) && Number(seedName) === 1){
        competition.registrationOpen = false;
        const infoChannel = gInfoCh(interaction.guild, competition);
        await uRegMsg(infoChannel || interaction.channel, competition);
      }
      svS(store);

      await interaction.reply(`Created new seed **${seedName}**.`);
      return;
    }

    if(interaction.commandName === 'remove_seed'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can remove championship seeds.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      if(!iCh(competition)){
        await interaction.reply({ content: 'This command can only be used for a championship.', ephemeral: true });
        return;
      }

      const latestSeed = gCurS(competition);
      if(!latestSeed){
        await interaction.reply({ content: 'This championship does not have a seed to remove.', ephemeral: true });
        return;
      }

      delete competition.seeds[nn(latestSeed.name)];
      const newLatestSeed = gCurS(competition);
      competition.currentSeedKey = newLatestSeed ? nn(newLatestSeed.name) : null;
      recalcCh(competition);
      await uLbMsg(interaction.guild, competition);
      svS(store);

      await interaction.reply({ content: `Removed championship Seed ${latestSeed.name}.`, ephemeral: true });
      return;
    }

    if(interaction.commandName === 'import'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can import match data.', ephemeral: true });
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

      const requestedMatchId = interaction.options.getString('match_id')?.trim() || await gHostMatchId(competition, seed);
      const duplicateSeed = Object.values(competition.seeds || {}).find((otherSeed)=
        otherSeed !== seed && gRid(otherSeed) && String(gRid(otherSeed)) === String(requestedMatchId),
      );
      if(duplicateSeed){
        const buttons = new MessageActionRow().addComponents(
          new MessageButton()
            .setCustomId(`import_continue:${interaction.id}:${interaction.user.id}`)
            .setLabel('Continue')
            .setStyle('DANGER'),
          new MessageButton()
            .setCustomId(`import_cancel:${interaction.id}:${interaction.user.id}`)
            .setLabel('Cancel')
            .setStyle('SECONDARY'),
        );
        const warning = `This match id has already been imported for seed ${duplicateSeed.name}.`;
        const warningMessage = await interaction.editReply({ content: warning, components: [buttons] });
        let confirmation;
        try{
          confirmation = await warningMessage.awaitMessageComponent({
            filter: (buttonInteraction)=>buttonInteraction.user.id === interaction.user.id,
            time: 60 * 1000,
          });
        }catch(error){
          await interaction.editReply({ content: `${warning}\nImport cancelled because no option was selected.`, components: [] });
          return;
        }
        if(confirmation.customId.startsWith('import_cancel:')){
          await confirmation.update({ content: `${warning}\nImport cancelled.`, components: [] });
          return;
        }
        await confirmation.update({ content: `${warning}\nContinuing import...`, components: [] });
      }
      const response = await getMatchData(requestedMatchId);
      const matchId = gRMid(response, requestedMatchId);
      const rows = parseResponse(response, seed.timeLimitSeconds);
      const previousResults = JSON.parse(JSON.stringify(seed.results || {}));
      const previousImported = seed.imported;
      const previousRankedMatchId = seed.rankedMatchId || null;
      const result = impM(competition, seed, rows);
      seed.rankedMatchId = String(matchId);
      seed.imported = true;
      recalcCh(competition);

      const lines = [
        `Imported match **${matchId}** into seed **${seed.name}**.`,
        `Matched ${result.matched.length}/${gEP(competition, seed).length} seed entrants.`,
      ];

      if(result.missing.length > 0){
        lines.push(`Unmatched MCSR names: ${result.missing.join(', ')}`);
      }
      
      if(iT(competition)){
        await pushComp(competition, '/api/write/match/results', mkMRP(competition, seed, matchId), 'POST');
        lines.push('Test mode is enabled, so the website API was not updated.');
      }else{
        try{
          await pushComp(competition, '/api/write/match/results', mkMRP(competition, seed, matchId), 'POST');
        }catch(error){
          seed.results = previousResults;
          seed.imported = previousImported;
          seed.rankedMatchId = previousRankedMatchId;
          console.log(error.stack);
          throw new Error(`${error.message} - Failed to post match ${matchId}`);
        }
      }

      await uLbMsg(interaction.guild, competition, true);
      svS(store);
      await interaction.editReply(lines.join('\n'));
      return;
    }

    if(interaction.commandName === 'forceinput'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can force-import match data.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      if(!commandLogged && interaction.isCommand()){
        commandLogged = true;
        await logCmd(interaction, store);
      }

      const competition = rA(store, gCK(interaction));
      const seedName = interaction.options.getInteger('seed_number', true);
      const seed = gRS(competition, seedName);
      if(!seed){
        await interaction.editReply(`Seed **${seedName}** does not exist in ${fCL(competition)}.`);
        return;
      }

      const requestedMatchId = interaction.options.getString('match_id', true).trim();
      const response = await getMatchData(requestedMatchId);
      const matchId = gRMid(response, requestedMatchId);
      const rows = parseResponse(response, seed.timeLimitSeconds);
      if(rows.length === 0){
        throw new Error(`Match ${matchId} did not contain any players.`);
      }

      const registeredUuids = new Set(
        Object.values(competition.registeredPlayers || {}).map((player)=>nn(gUuid(player))).filter(Boolean),
      );
      const profilesToAdd = [];
      for(const row of rows){
        if(registeredUuids.has(nn(row.playerUuid))){
          continue;
        }
        const profile = await getForceImportPlayer(row.playerUuid || row.playerName);
        const existing = competition.registeredPlayers?.[profile.discordId];
        if(existing && nn(gUuid(existing)) !== nn(profile.uuid)){
          throw new Error(`Discord account ${profile.discordId} is already registered as ${fPN(existing)}, not ${profile.ign}.`);
        }
        if(!existing){
          profilesToAdd.push(profile);
        }
        registeredUuids.add(nn(profile.uuid));
      }

      const addedIds = [];
      for(const profile of profilesToAdd){
        const discordUser = await client.users.fetch(profile.discordId).catch(()=>null);
        const guildMember = await interaction.guild.members.fetch(profile.discordId).catch(()=>null);
        const discordUsername = discordUser?.username || profile.discordUsername || profile.discordId;
        competition.registeredPlayers[profile.discordId] = {
          userId: profile.discordId,
          username: discordUsername,
          discordUsername,
          discordDisplayName: guildMember?.displayName || discordUsername,
          ign: profile.ign,
          uuid: profile.uuid,
          elo: profile.elo,
          peakElo: profile.peakElo,
          twitch: null,
          registeredAt: new Date().toISOString(),
          forceImported: true,
        };
        if(iCh(competition)){
          if(!competition.championship.originalEntrantIds.includes(profile.discordId)){
            competition.championship.originalEntrantIds.push(profile.discordId);
          }
          if(!competition.championship.activePlayerIds.includes(profile.discordId)){
            competition.championship.activePlayerIds.push(profile.discordId);
          }
          seed.entrantIds = seed.entrantIds || [];
          if(!seed.entrantIds.includes(profile.discordId)){
            seed.entrantIds.push(profile.discordId);
          }
        }
        await pushComp(competition, '/api/write/player', {
          ...mkCP(competition),
          uuid: profile.uuid,
          ign: profile.ign,
          ...(profile.elo !== null ? { elo: profile.elo } : {}),
        }, 'POST');
        addedIds.push(profile.discordId);
      }

      sCR(competition);
      const result = impM(competition, seed, rows);
      if(result.missing.length > 0){
        throw new Error(`Could not match every player after registration: ${result.missing.join(', ')}`);
      }
      seed.rankedMatchId = String(matchId);
      seed.imported = true;
      recalcCh(competition);
      await pushComp(competition, '/api/write/match/results', mkMRP(competition, seed, matchId), 'POST');

      if(!iT(competition)){
        for(const userId of addedIds){
          await addCWR(interaction.guild, userId);
        }
      }
      const infoChannel = gInfoCh(interaction.guild, competition);
      await uRegMsg(infoChannel || interaction.channel, competition);
      await uLbMsg(interaction.guild, competition, true);
      svS(store);

      await interaction.editReply([
        `Force-imported match **${matchId}** into seed **${seed.name}**.`,
        `Imported ${result.matched.length}/${rows.length} players.`,
        `Automatically registered ${addedIds.length} player${addedIds.length === 1 ? '' : 's'}.`,
      ].join('\n'));
      return;
    }

    if(interaction.commandName === 'refresh'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can refresh imported match data.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const competition = rA(store, gCK(interaction));
      const seeds = Object.values(competition.seeds || {})
        .filter((seed)=>seed.imported === true)
        .sort((left, right)=>Number(left.name) - Number(right.name));

      if(seeds.length === 0){
        await interaction.editReply('There are no imported seeds to refresh.');
        return;
      }

      const refreshed = [];
      const failed = [];

      for(const seed of seeds){
        const matchId = gRid(seed);
        if(!matchId){
          failed.push(`Seed ${seed.name}: no saved match ID`);
          continue;
        }

        try{
          const response = await getMatchData(matchId);
          const actualMatchId = gRMid(response, matchId);
          const rows = parseResponse(response, seed.timeLimitSeconds);
          const result = impM(competition, seed, rows);
          seed.rankedMatchId = String(actualMatchId);
          seed.imported = true;
          recalcCh(competition);
          await pushComp(competition, '/api/write/match/results', mkMRP(competition, seed, actualMatchId), 'POST');
          refreshed.push(`Seed ${seed.name}: ${result.matched.length}/${gEP(competition, seed).length}`);
        }catch(error){
          failed.push(`Seed ${seed.name}: ${error.message}`);
        }
      }

      recalcCh(competition);
      await uLbMsg(interaction.guild, competition, true);
      svS(store);

      const lines = [`Refreshed ${refreshed.length}/${seeds.length} imported seed(s).`];
      if(refreshed.length > 0){
        lines.push(`Matched entrants: ${refreshed.join(', ')}`);
      }
      if(failed.length > 0){
        lines.push(`Problems: ${failed.join('; ')}`);
      }
      if(iT(competition)){
        lines.push('Test mode is enabled, so refreshed website payloads were saved locally instead.');
      }
      await interaction.editReply(lines.join('\n'));
      return;
    }

    if(interaction.commandName === 'host'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can set the host.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      const targetUser = interaction.user;
      const userData = await getUserDataFromDiscord(targetUser.id);

      competition.hostUserId = targetUser.id;
      competition.hostDiscordUsername = targetUser.username;
      competition.hostIgn = userData.ign;
      competition.hostUuid = userData.uuid;
      svS(store);
      await interaction.reply({ content: `Host set to **${userData.ign}(${targetUser.username})**.`, ephemeral: true });
      return;
    }

    if(interaction.commandName === 'signup'){
      await interaction.deferReply();
      const db = ldPdb();

      if(interaction.channel?.name !== SIGNUP_CHANNEL){
        await interaction.editReply({ content: `This command can only be used in #${SIGNUP_CHANNEL}.` });
        return;
      }

      const member = interaction.member;
      if(hasLeagueRole(member)){
        await interaction.editReply({ content: 'You already have a league role.' });
        return;
      }

      const existingPlayer = gPRec(db, interaction.user.id);
      if(existingPlayer){
        const targetRole = gLR(interaction.guild, existingPlayer.league);
        if(!targetRole){
          await interaction.editReply({ content: `Could not find the stored League ${existingPlayer.league} role.` });
          return;
        }
        const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if(!guildMember){
          await interaction.editReply({ content: 'Could not find your server member record.' });
          return;
        }
        await guildMember.roles.add(targetRole).catch(() => {});
        await interaction.editReply({ content: `You have already been placed before, so you were automatically assigned to League ${existingPlayer.league}.` });
        return;
      }

      if(hasSR(store, interaction.guildId, interaction.user.id)){
        await interaction.editReply({ content: 'You have already sent a request.' });
        return;
      }

      const reviewer = await findSignupReviewer(interaction.guild);
      if(!reviewer){
        await interaction.editReply({ content: `Could not find ${SIGNUP_REVIEWER} in this server.` });
        return;
      }

      const profile = await getUserDataFromDiscord(interaction.user.id);
      const lines = [
        `Discord: ${interaction.user.username}`,
        fSV('MCSR username', profile.ign),
        fSV('Current elo', profile.elo),
        fSV('Peak elo', profile.peakElo),
        fSV('Suggested League', gSL(profile.peakElo)),
        fSV('Ranked average', profile.rankedAverage === null ? 'n/a' : fT(profile.rankedAverage)),
        fSV('Ranked PB', profile.rankedPb === null ? 'n/a' : fT(profile.rankedPb)),
        `Profile: <https://mcsrranked.com/profile/${profile.ign}>`,
      ];

      await reviewer.send({
        content: lines.join('\n'),
        components: mkSignupBtns(interaction.guildId, interaction.user.id, reviewer.id),
      });
      addSR(store, interaction.guildId, interaction.user.id);
      svS(store);

      await interaction.editReply({ content: 'Your request has been sent for review.' });
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
      await interaction.deferReply();
      const competition = rA(store, gCK(interaction));
      const leagueNumber = gLC(interaction, competition, admin);

      if(competition.leagueNumber !== leagueNumber){
        await interaction.editReply({ content: `This channel is running League ${competition.leagueNumber}. You are in League ${leagueNumber}.` });
        return;
      }

      if(!competition.registrationOpen){
        await interaction.editReply({ content: `Registration is currently closed.` });
        return;
      }

      if(iRP(competition, interaction.user.id)){
        await interaction.editReply({ content: `You are already registered.` });
        return;
      }
      if(iCh(competition) && gCurS(competition)){
        await interaction.editReply({ content: 'Championship registration is locked after Seed 1 is created.' });
        return;
      }

      const userData = await getUserDataFromDiscord(interaction.user.id);
      const twitch = interaction.options.getString('twitch')?.trim() || null;

      await pushComp(competition, '/api/write/player', {
        ...mkCP(competition),
        uuid: userData.uuid,
        ign: userData.ign,
        ...(userData.elo !== null ? { elo: userData.elo } : {}),
      }, 'POST');

      competition.registeredPlayers[interaction.user.id] ={
        userId: interaction.user.id,
        username: interaction.user.username,
        discordUsername: interaction.user.username,
        discordDisplayName: interaction.member?.displayName || interaction.user.username,
        ign: userData.ign,
        uuid: userData.uuid,
        elo: userData.elo,
        peakElo: userData.peakElo,
        twitch,
        registeredAt: new Date().toISOString(),
      };
      sCR(competition);
      if(!iT(competition)){
        await addCWR(interaction.guild, interaction.user.id);
      }
      const infoChannel = gInfoCh(interaction.guild, competition);
      await uRegMsg(infoChannel || interaction.channel, competition);
      await uLbMsg(interaction.guild, competition);
      svS(store);

      await interaction.editReply(
        { content: `Registered **${fPN(competition.registeredPlayers[interaction.user.id])}** for ${fCL(competition)}.` },
      );
      return;
    }

    if(interaction.commandName === 'admin_reg'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can register a player.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const competition = rA(store, gCK(interaction));
      const targetUser = interaction.options.getUser('user', true);
      const mcUsername = interaction.options.getString('mc_username')?.trim() || null;

      if(iRP(competition, targetUser.id)){
        await interaction.editReply({ content: `${targetUser.username} is already registered.` });
        return;
      }
      if(iCh(competition) && gCurS(competition)){
        await interaction.editReply({ content: 'Championship registration is locked after Seed 1 is created.' });
        return;
      }

      const userData = mcUsername
        ? await getUserDataFromIdentifier(mcUsername)
        : await getUserDataFromDiscord(targetUser.id);
      const twitch = interaction.options.getString('twitch')?.trim() || null;

      await pushComp(competition, '/api/write/player', {
        ...mkCP(competition),
        uuid: userData.uuid,
        ign: userData.ign,
        ...(userData.elo !== null ? { elo: userData.elo } : {}),
      }, 'POST');

      competition.registeredPlayers[targetUser.id] = {
        userId: targetUser.id,
        username: targetUser.username,
        discordUsername: targetUser.username,
        discordDisplayName: interaction.guild.members.cache.get(targetUser.id)?.displayName || targetUser.username,
        ign: userData.ign,
        uuid: userData.uuid,
        elo: userData.elo,
        peakElo: userData.peakElo,
        twitch,
        registeredAt: new Date().toISOString(),
      };
      sCR(competition);
      if(!iT(competition)){
        await addCWR(interaction.guild, targetUser.id);
      }
      const infoChannel = gInfoCh(interaction.guild, competition);
      await uRegMsg(infoChannel || interaction.channel, competition);
      await uLbMsg(interaction.guild, competition);
      svS(store);

      await interaction.editReply({ content: `Registered **${fPN(competition.registeredPlayers[targetUser.id])}** for ${fCL(competition)}.` });
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

      if(iHR(competition, interaction.user.id)){
        await interaction.reply({ content: 'You cannot unregister after match results have been imported for this competition.', ephemeral: true });
        return;
      }

      await pushComp(competition, '/api/write/player/unregister', {
        ...mkCP(competition),
        uuid: rUuid(registeredPlayer, fPN(registeredPlayer)),
      }, 'PATCH');

      rmRP(competition, interaction.user.id);
      if(!iT(competition)){
        await rmCWR(interaction.guild, interaction.user.id);
      }
      const infoChannel = gInfoCh(interaction.guild, competition);
      await uRegMsg(infoChannel || interaction.channel, competition);
      await uLbMsg(interaction.guild, competition);
      svS(store);

      await interaction.reply({ content: `Unregistered **${fPN(registeredPlayer)}** from ${fCL(competition)}.`, ephemeral: true });
      return;
    }

    if(interaction.commandName === 'remove'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can remove a player.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      const targetUser = interaction.options.getUser('user', true);
      const removedPlayer = competition.registeredPlayers[targetUser.id] || null;

      if(!removedPlayer){
        await interaction.reply({ content: `${targetUser.username} is not currently registered for this competition.`, ephemeral: true });
        return;
      }

      await pushComp(competition, '/api/write/player/unregister', {
        ...mkCP(competition),
        uuid: rUuid(removedPlayer, fPN(removedPlayer)),
      }, 'PATCH');

      rmRP(competition, targetUser.id);
      recalcCh(competition);

      await syncImportedMatches(competition);

      if(!iT(competition)){
        await rmCWR(interaction.guild, targetUser.id);
      }
      const infoChannel = gInfoCh(interaction.guild, competition);
      await uRegMsg(infoChannel || interaction.channel, competition);
      await uLbMsg(interaction.guild, competition);
      svS(store);

      await interaction.reply(`Removed **${fPN(removedPlayer)}** from ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'toggle_registration'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can change registration status.', ephemeral: true });
        return;
      }

      const competition = rA(store, gCK(interaction));
      const enabled = interaction.options.getBoolean('enabled', true);
      if(iCh(competition) && enabled && gCurS(competition)){
        await interaction.reply({ content: 'Championship registration cannot reopen after Seed 1 is created.', ephemeral: true });
        return;
      }
      competition.registrationOpen = enabled;
      const infoChannel = gInfoCh(interaction.guild, competition);
      await uRegMsg(infoChannel || interaction.channel, competition);
      svS(store);

      await interaction.reply(`Registration is now ${competition.registrationOpen ? 'open' : 'closed'} for ${fCL(competition)}  `);
      return;
    }

    if(interaction.commandName === 'toggle_report'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can change score reporting.', ephemeral: true });
        return;
      }
      const competition = rA(store, gCK(interaction));
      competition.scoreReportingEnabled = interaction.options.getBoolean('enabled', true);
      svS(store);
      await interaction.reply(`Player score reporting is now ${competition.scoreReportingEnabled ? 'enabled' : 'disabled'} for ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'report_score'){
      const competition = rA(store, gCK(interaction));
      const opponent = interaction.options.getUser('opponent', true);
      const score = interaction.options.getString('score', true);
      if(!competition.scoreReportingEnabled){
        await interaction.reply('Player score reporting is currently disabled for this competition.');
        return;
      }
      if(opponent.id === interaction.user.id){
        await interaction.reply('You cannot report a score against yourself.');
        return;
      }
      if(opponent.bot){
        await interaction.reply('You cannot report a score against a bot.');
        return;
      }
      if(!iRP(competition, interaction.user.id) || !iRP(competition, opponent.id)){
        await interaction.reply('Both players must be registered for this competition to report a score.');
        return;
      }

      expireReports(store);
      const submission = playerScore(interaction.user.id, opponent.id, score);
      const existing = findOpenReport(store, interaction.guildId, interaction.channelId, interaction.user.id, opponent.id);
      if(existing){
        if(existing.status !== 'awaiting_submissions'){
          await interaction.reply('This matchup already has a report awaiting confirmation or review. Use the buttons in your DMs.');
          return;
        }
        if(existing.submissions[interaction.user.id]){
          await interaction.reply('You already submitted a score for this report. Cancel it from your DMs if it is incorrect.');
          return;
        }
        existing.submissions[interaction.user.id] = submission;
        const otherSubmission = Object.entries(existing.submissions).find(([userId])=>userId !== interaction.user.id)?.[1];
        if(!sameScore(submission, otherSubmission)){
          existing.status = 'disputed';
          existing.closedAt = new Date().toISOString();
          svS(store);
          const claims = Object.entries(existing.submissions).map(([userId, claim])=>
            `${reportPlayerName(existing, userId)} reported: ${submittedResult(existing, claim)}`,
          );
          const conflict = `The submitted scores do not match.\n${claims.join('\n')}\nBoth players must submit a new corrected report.`;
          await notifyReportPlayers(existing, conflict);
          await interaction.reply(conflict);
          return;
        }

        existing.winnerId = submission.winnerId;
        existing.loserId = submission.loserId;
        existing.winnerScore = submission.winnerScore;
        existing.loserScore = submission.loserScore;
        existing.confirmations = Object.fromEntries(Object.keys(existing.players).map((userId)=>[userId, false]));
        existing.status = 'awaiting_confirmation';
        svS(store);
        const users = await reportUsers(existing);
        const confirmationText = `Confirm this result: ${reportResult(existing)}`;
        const delivered = await Promise.all(users.filter(Boolean).map((user)=>user.send({ content: confirmationText, components: confirmReportRows(existing) }).then(()=>true).catch(()=>false)));
        if(delivered.includes(false) || delivered.length !== 2){
          existing.status = 'cancelled';
          existing.closedAt = new Date().toISOString();
          svS(store);
          await interaction.reply('Could not DM both players, so the report was cancelled. Both players must allow DMs from this server.');
          return;
        }
        await interaction.reply('The scores match. Both players were sent confirmation buttons.');
        return;
      }

      const report = {
        id: newReportId(),
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        leagueNumber: competition.leagueNumber,
        week: competition.week || null,
        pairKey: reportPair(interaction.user.id, opponent.id),
        reporterId: interaction.user.id,
        players: {
          [interaction.user.id]: {
            userId: interaction.user.id,
            username: interaction.user.username,
            displayName: interaction.member?.displayName || interaction.user.username,
          },
          [opponent.id]: {
            userId: opponent.id,
            username: opponent.username,
            displayName: interaction.guild.members.cache.get(opponent.id)?.displayName || opponent.username,
          },
        },
        submissions: { [interaction.user.id]: submission },
        confirmations: {},
        status: 'awaiting_submissions',
        adminReport: false,
        createdAt: new Date().toISOString(),
      };
      gReports(store)[report.id] = report;
      svS(store);
      const reporterDm = interaction.user.send({
        content: `Score submitted: ${submittedResult(report, submission)}. Waiting for ${reportPlayerName(report, opponent.id)} to submit the matching score.`,
        components: pendingReportRows(report),
      }).then(()=>true).catch(()=>false);
      const opponentDm = opponent.send({
        content: `${reportPlayerName(report, interaction.user.id)} reported: ${submittedResult(report, submission)}. Use /report_score in the competition channel with your score, or dispute this report.`,
        components: disputeReportRows(report),
      }).then(()=>true).catch(()=>false);
      const delivered = await Promise.all([reporterDm, opponentDm]);
      if(delivered.includes(false)){
        report.status = 'cancelled';
        report.closedAt = new Date().toISOString();
        svS(store);
        await interaction.reply('Could not DM both players, so the report was cancelled. Both players must allow DMs from this server.');
        return;
      }
      await interaction.reply('Score submitted. Your opponent must submit the matching score before confirmation.');
      return;
    }

    if(interaction.commandName === 'admin_report_score'){
      if(!admin){
        await interaction.reply('Only users with the League Helper role can submit admin score reports.');
        return;
      }
      const winner = interaction.options.getUser('winner', true);
      const loser = interaction.options.getUser('loser', true);
      const score = interaction.options.getString('score', true);
      if(winner.id === loser.id || winner.bot || loser.bot){
        await interaction.reply('Winner and loser must be two different non-bot users.');
        return;
      }
      expireReports(store);
      const pairKey = reportPair(winner.id, loser.id);
      const superseded = Object.values(gReports(store)).filter((report)=>report.guildId === interaction.guildId && report.pairKey === pairKey && isOpenReport(report));
      const competition = gComp(store, gCK(interaction));
      const [winnerScore, loserScore] = score.split('-').map(Number);
      const report = {
        id: newReportId(),
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        leagueNumber: competition?.leagueNumber || null,
        week: competition?.week || null,
        pairKey,
        reporterId: interaction.user.id,
        players: {
          [winner.id]: {
            userId: winner.id,
            username: winner.username,
            displayName: interaction.guild.members.cache.get(winner.id)?.displayName || winner.username,
          },
          [loser.id]: {
            userId: loser.id,
            username: loser.username,
            displayName: interaction.guild.members.cache.get(loser.id)?.displayName || loser.username,
          },
        },
        submissions: {},
        confirmations: {},
        winnerId: winner.id,
        loserId: loser.id,
        winnerScore,
        loserScore,
        status: 'awaiting_review',
        adminReport: true,
        adminId: interaction.user.id,
        adminUsername: interaction.user.username,
        adminDisplayName: interaction.member?.displayName || interaction.user.username,
        createdAt: new Date().toISOString(),
      };
      gReports(store)[report.id] = report;
      svS(store);
      try{
        await sendReportReview(report);
      }catch(error){
        report.status = 'review_delivery_failed';
        report.closedAt = new Date().toISOString();
        svS(store);
        await interaction.reply('Could not DM the configured score reviewer.');
        return;
      }
      for(const pendingReport of superseded){
        pendingReport.status = 'superseded_by_admin';
        pendingReport.closedAt = new Date().toISOString();
        await notifyReportPlayers(pendingReport, 'Your pending score report was superseded by a League Helper report.');
      }
      svS(store);
      await interaction.reply('Admin score report sent to the reviewer.');
      return;
    }

    if(interaction.commandName === 'toggle_logs'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can change log status.', ephemeral: true });
        return;
      }

      store.settings.loggingEnabled = interaction.options.getBoolean('enabled', true);
      svS(store);

      await interaction.reply(`Command logging is now ${store.settings.loggingEnabled ? 'enabled' : 'disabled'}.`);
      return;
    }

    if(interaction.commandName === 'fill'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can fill the player database.', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      const db = ldPdb();
      const members = await interaction.guild.members.fetch({ time: 120000 });
      let count = 0;

      for(const member of members.values()){
        const league = gMRN(member);
        if(!league){
          continue;
        }

        sPRecById(db, member.user.id, member.user.username, league);
        count += 1;

        if(count % 10 === 0){
          svPdb(db);
          await wait(500);
        }
      }

      svPdb(db);
      await interaction.editReply({ content: `Filled the player database with ${count} league players.` });
      return;
    }

    if(interaction.commandName === 'test'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can change test mode.', ephemeral: true });
        return;
      }

      const channel = ensC(store, gCK(interaction));
      const enabled = interaction.options.getBoolean('enabled', true);
      channel.testMode = enabled;
      if(channel.competition){
        channel.competition.testMode = enabled;
      }
      svS(store);

      if(channel.competition){
        await interaction.reply({ content: `Test mode is now ${enabled ? 'enabled' : 'disabled'} for ${fCL(channel.competition)}.${enabled ? ` Skipped website payloads will be saved to ${TEST_API_PATH}.` : ''}`, ephemeral: true });
        return;
      }

      await interaction.reply({ content: `Test mode is now ${enabled ? 'enabled' : 'disabled'} for this channel.${enabled ? ` The next competition created here will save skipped website payloads to ${TEST_API_PATH}.` : ''}`, ephemeral: true });
      return;
    }

    if(interaction.commandName === 'promote'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can change promotion count.', ephemeral: true });
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
        await interaction.reply({ content: 'Only users with the League Helper role can change demotion count.', ephemeral: true });
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

      const cap = Math.round(gLB(competition).length * (competition.leagueNumber === 1 ? 0.2 : 0.15));
      await interaction.reply(`Demotion count is now set to ${count} for ${fCL(competition)}.${count > cap ? ` Current cap is ${cap}, so only ${cap} can be demoted unless there is a cutoff tie.` : ''}`);
      return;
    }

    if(interaction.commandName === 'p'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can promote a player.', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      const targetUser = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(targetUser.id);
      const currentLeague = gMRN(member);

      if(!currentLeague){
        await interaction.editReply({ content: `${targetUser.username} does not have a League role.` });
        return;
      }
      if(currentLeague <= 1){
        await interaction.editReply({ content: `${targetUser.username} is already in League 1.` });
        return;
      }

      const sourceRole = gLR(interaction.guild, currentLeague);
      const targetRole = gLR(interaction.guild, currentLeague - 1);
      if(!sourceRole || !targetRole){
        await interaction.editReply({ content: 'Could not find the required League roles in this server.' });
        return;
      }
      const competition = gComp(store, gCK(interaction));
      if(iT(competition)){
        await interaction.editReply({ content: `Test mode is enabled for ${fCL(competition)}. Manual role changes are disabled.` });
        return;
      }

      const userData = await getUserDataFromDiscord(targetUser.id);
      await pushComp(competition, '/api/write/player/league', {
        uuid: userData.uuid,
        leagueTier: currentLeague - 1,
      }, 'PATCH');

      try{
        await member.roles.remove(sourceRole);
        await member.roles.add(targetRole);
      } catch(error){
        await pushComp(competition, '/api/write/player/league', {
          uuid: userData.uuid,
          leagueTier: currentLeague,
        }, 'PATCH').catch(()=>{});
        throw error;
      }
      {
        const db = ldPdb();
        sPRecById(db, targetUser.id, targetUser.username, currentLeague - 1);
        svPdb(db);
      }
      await interaction.editReply({ content: `Promoted ${targetUser.username} to League ${currentLeague - 1}.` });
      return;
    }

    if(interaction.commandName === 'd'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can demote a player.', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      const targetUser = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(targetUser.id);
      const currentLeague = gMRN(member);

      if(!currentLeague){
        await interaction.editReply({ content: `${targetUser.username} does not have a League role.` });
        return;
      }
      if(currentLeague >= LOWEST_DEMOTABLE_LEAGUE){
        await interaction.editReply({ content: `${targetUser.username} cannot be demoted lower.` });
        return;
      }

      const sourceRole = gLR(interaction.guild, currentLeague);
      const targetRole = gLR(interaction.guild, currentLeague + 1);
      if(!sourceRole || !targetRole){
        await interaction.editReply({ content: 'Could not find the required League roles in this server.' });
        return;
      }
      const competition = gComp(store, gCK(interaction));
      if(iT(competition)){
        await interaction.editReply({ content: `Test mode is enabled for ${fCL(competition)}. Manual role changes are disabled.` });
        return;
      }

      const userData = await getUserDataFromDiscord(targetUser.id);
      await pushComp(competition, '/api/write/player/league', {
        uuid: userData.uuid,
        leagueTier: currentLeague + 1,
      }, 'PATCH');

      try{
        await member.roles.remove(sourceRole);
        await member.roles.add(targetRole);
      } catch(error){
        await pushComp(competition, '/api/write/player/league', {
          uuid: userData.uuid,
          leagueTier: currentLeague,
        }, 'PATCH').catch(()=>{});
        throw error;
      }
      {
        const db = ldPdb();
        sDemRec(db, targetUser.id, targetUser.username, currentLeague + 1, competition || { leagueNumber: currentLeague, week: null });
        svPdb(db);
      }
      await interaction.editReply({ content: `Demoted ${targetUser.username} to League ${currentLeague + 1}.` });
      return;
    }

    if(interaction.commandName === 'relegate'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can apply promotions and demotions.', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      const competition = rC(store, gCK(interaction));

      if(competition.status !== 'ended'){
        await interaction.editReply({ content: 'You can only use /relegate after the match has ended.' });
        return;
      }

      if(competition.movementsApplied){
        await interaction.editReply({ content: 'Promotions and demotions have already been applied for this match.' });
        return;
      }

      const movementPlan = gMP(competition);
      await syncMovementsToWeb(competition, movementPlan);

      const movementResults = await applyLeagueMovements(interaction, competition);
      competition.movementsApplied = true;
      svS(store);

      const summary = [
        movementResults.promoted.length > 0 ? `Promoted: ${movementResults.promoted.join(', ')}` : 'Promoted: none',
        movementResults.demoted.length > 0 ? `Demoted: ${movementResults.demoted.join(', ')}` : 'Demoted: none',
        movementResults.skipped.length > 0 ? `Skipped: ${movementResults.skipped.join(', ')}` : null,
      ].filter(Boolean).join('\n');

      await interaction.editReply(summary);
      return;
    }

    if(interaction.commandName === 'adjust'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can adjust points.', ephemeral: true });
        return;
      }

      const competition = rC(store, gCK(interaction));
      const points = interaction.options.getInteger('points', true);
      const targetUser = interaction.options.getUser('user', true);

      if(!iRP(competition, targetUser.id)){
      await interaction.reply({ content: `${targetUser.username} is not registered for ${fCL(competition)}.`, ephemeral: true });
        return;
      }

      const nextAdjustment = (competition.pointAdjustments[targetUser.id] || 0) + points;
      await pushComp(competition, '/api/write/adjustment', {
        ...mkCP(competition),
        uuid: rUuid(competition.registeredPlayers[targetUser.id], fPN(competition.registeredPlayers[targetUser.id])),
        manualAdjustmentPoints: nextAdjustment,
      }, 'PATCH');

      competition.pointAdjustments[targetUser.id] = nextAdjustment;
      await uLbMsg(interaction.guild, competition);
      svS(store);

      await interaction.reply(`Adjusted ${fPN(competition.registeredPlayers[targetUser.id])}'s points by ${points > 0 ? '+' : ''}${points} in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'clear'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can clear seed standings.', ephemeral: true });
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

      await pushComp(competition, '/api/write/match/clear', {
        ...mkCP(competition),
        matchNumber: Number(seed.name),
      }, 'PATCH');

      seed.results = mkDR(competition, seed);
      seed.imported = false;
      seed.rankedMatchId = null;
      recalcCh(competition);
      await uLbMsg(interaction.guild, competition);
      svS(store);

      await interaction.reply(`Cleared all standings for seed **${seed.name}** in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'r'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can reset a player result.', ephemeral: true });
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
      if(iCh(competition) && !seed.entrantIds?.includes(targetUser.id)){
        await interaction.reply({ content: `${targetUser.username} was not an entrant in championship Seed ${seed.name}.`, ephemeral: true });
        return;
      }

      const previousEntry = seed.results[targetUser.id]
        ? JSON.parse(JSON.stringify(seed.results[targetUser.id]))
        : null;
      const previousRankedMatchId = seed.rankedMatchId || null;
      seed.results[targetUser.id] = {
        userId: targetUser.id,
        username: gDU(competition.registeredPlayers[targetUser.id]),
        discordUsername: gDU(competition.registeredPlayers[targetUser.id]),
        ign: gIgn(competition.registeredPlayers[targetUser.id]),
        uuid: gUuid(competition.registeredPlayers[targetUser.id]),
        elo: gElo(competition.registeredPlayers[targetUser.id]),
        twitch: gTw(competition.registeredPlayers[targetUser.id]),
        dnf: true,
        sourceDnf: true,
        played: true,
        placement: null,
        timeSeconds: null,
        rawTimeSeconds: null,
        submittedAt: null,
      };
      recalcCh(competition);
      if(seed.imported){
        seed.rankedMatchId = gRid(seed);
        try{
          await pushComp(competition, '/api/write/match/results', mkMRP(competition, seed, seed.rankedMatchId), 'POST');
        } catch(error){
          if(previousEntry){
            seed.results[targetUser.id] = previousEntry;
          }else{
            delete seed.results[targetUser.id];
          }
          seed.rankedMatchId = previousRankedMatchId;
          throw error;
        }
      }
      if(seed.imported){
        await uLbMsg(interaction.guild, competition);
      }
      svS(store);

      await interaction.reply(`Reset ${fPN(competition.registeredPlayers[targetUser.id])} to DNF for seed **${seed.name}** in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'edit'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can edit a player seed result.', ephemeral: true });
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
      if(iCh(competition) && !seed.entrantIds?.includes(targetUser.id)){
        await interaction.reply({ content: `${targetUser.username} was not an entrant in championship Seed ${seed.name}.`, ephemeral: true });
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
      if(!dnf && !iCh(competition) && timeSeconds > seed.timeLimitSeconds){
        await interaction.reply({ content: `Time cannot exceed the limit of ${fT(seed.timeLimitSeconds)}.`, ephemeral: true });
        return;
      }

      const previousEntry = seed.results[targetUser.id]
        ? JSON.parse(JSON.stringify(seed.results[targetUser.id]))
        : null;
      const previousRankedMatchId = seed.rankedMatchId || null;
      aSR(
        seed,
        competition.registeredPlayers[targetUser.id] || { id: targetUser.id, discordUsername: targetUser.username, ign: targetUser.username },
        timeSeconds,
        dnf,
      );
      recalcCh(competition);
      if(seed.imported){
        seed.rankedMatchId = gRid(seed);
        try{
          await pushComp(competition, '/api/write/match/results', mkMRP(competition, seed, seed.rankedMatchId), 'POST');
        } catch(error){
          if(previousEntry){
            seed.results[targetUser.id] = previousEntry;
          }else{
            delete seed.results[targetUser.id];
          }
          seed.rankedMatchId = previousRankedMatchId;
          throw error;
        }
      }
      if(seed.imported){
        await uLbMsg(interaction.guild, competition);
      }
      svS(store);

      await interaction.reply(`Updated ${fPN(competition.registeredPlayers[targetUser.id])}'s result for seed **${seed.name}** in ${fCL(competition)}.`);
      return;
    }

    if(interaction.commandName === 'lb'){
      let league = interaction.options.getInteger('league');
      let competition = gComp(store, gCK(interaction));
      if (league == null){
        league = gLM(interaction);
      }
      if(!competition || competition.leagueNumber != league){
        competition = null;
        for (const channel of Object.keys(store.channels)){
          if (store.channels[channel]['competition'] == null) continue;
          const number = store.channels[channel]['competition']['leagueNumber'];
          if (number != league) continue;
          competition = rC(store, channel);
          break;
        }
      }

      if (competition == null){
        await interaction.reply("Please enter a valid league number");
        return;
      }

      const lb = chunkMsg(fLB(competition));
      await interaction.reply({
        content: lb[0],
        ephemeral: true,
      })
      for (let index = 1; index < lb.length; index++){
        await interaction.followUp({
          content: lb[index],
          ephemeral: true,
        });
      }
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

    if(interaction.commandName === 'zscores'){
      const league = interaction.options.getInteger('league') || gLM(interaction);
      const db = ldPdb();
      await interaction.reply(fZLb(db, league));
      return;
    }

    if(interaction.commandName === 'zreset'){
      if(!admin){
        await interaction.reply({ content: 'Only users with the League Helper role can reset z-scores.', ephemeral: true });
        return;
      }

      const db = ldPdb();
      for(const player of Object.values(db.players || {})){
        player.bestZScores = {};
        player.updatedAt = new Date().toISOString();
      }
      svPdb(db);
      await interaction.reply('Reset all saved z-scores.');
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

    if(interaction.commandName === 'players'){
      const competition = rC(store, gCK(interaction));
      const players = gRegs(competition);
      if(players.length === 0){
        await interaction.reply('There are no registered players.');
        return;
      }

      const members = await interaction.guild.members.fetch({
        user: players.map((player)=>player.userId),
      }).catch(()=>interaction.guild.members.cache);
      const chunks = chunkMsg(players.map((player)=>{
        const member = members.get(player.userId) || interaction.guild.members.cache.get(player.userId);
        return eMd(member?.displayName || player.discordDisplayName || gDU(player));
      }).join('\n'));
      await interaction.reply(chunks[0]);
      for(let index = 1; index < chunks.length; index += 1){
        await interaction.followUp(chunks[index]);
      }
      return;
    }

    if(interaction.commandName === 'list'){
      const competition = rC(store, gCK(interaction));
      const players = gRegs(competition);

      if(players.length === 0){
        await interaction.reply('There are no registered players to export.');
        return;
      }

      const content = JSON.stringify(
        players.map((player)=>({
          ign: gIgn(player),
          twitch_username: gTw(player) || '',
          display_name: gIgn(player),
        })),
        null,
        2,
      );
      const filename = `mcrl_${competition.leagueNumber}_${competition.week || 'current'}.ranked`;
      const file = new MessageAttachment(Buffer.from(content, 'utf8'), filename);

      await interaction.reply({
        content: `Exported ${players.length} players.`,
        files: [file],
      });
      return;
    }
    });
    apiWarnSink = null;
  } catch(error){
    apiWarnSink = null;
    console.error('Command handling failed.', error);

    const replyPayload = {
      content: `${error.message}`,
      ephemeral: true,
    };

    if(interaction.deferred && !interaction.replied){
      await interaction.editReply(replyPayload).catch(() => {});
      return;
    }

    if(interaction.replied){
      await interaction.followUp(replyPayload).catch(() => {});
      return;
    }

    await interaction.reply(replyPayload).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
