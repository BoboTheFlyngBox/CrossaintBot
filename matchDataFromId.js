const fs=require('fs');
const path=require('path');

const BASE_URL='https://api.mcsrranked.com/matches/';

async function getMatchData(matchId){
  try{
    const response=await fetch(`${BASE_URL}${matchId}`);
    if(!response.ok){
      throw new Error(`Network error: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch(err){
    throw new Error(`Failed to fetch match ${matchId}: ${err.message}`);
  }
}

function parseResponse(response,dnfTime){
  if(response.status === 'error'){
    if(typeof response.data === 'string'){
      throw new Error(response.data);
    }
    throw new Error('Invalid data');
  }

  const matchData = response.data;
  if(!matchData||typeof matchData==='string'){
    throw new Error('No match data');
  }

  const completionByUuid=new Map();
  for(const c of matchData.completions||[]){
    if(c&&typeof c.uuid==='string'){
      completionByUuid.set(c.uuid,c);
    }
  }

  const times = (matchData.players||[]).map((player) => {
    const completedData = completionByUuid.get(player.uuid);
    const rawTime = typeof completedData?.time === 'number' ? completedData.time:null;
    const overLimit = typeof rawTime === 'number'&&rawTime>dnfTime;
    return{
      playerName:player.nickname,
      dnf:!completedData||typeof completedData.time!=='number'||overLimit,
      timeMs:typeof rawTime==='number'&&!overLimit?rawTime:dnfTime,
    };
  });

  const basePoints=times.length;
  times.sort((a,b) => a.timeMs - b.timeMs);

  return times.map((time,index)=>({
    playerName:time.playerName,
    dnf:time.dnf,
    timeMs:time.timeMs,
    placement:index+1,
    pointsWon:time.dnf?0:basePoints-index,
  }));
}

const DNF_TIMES={
  league1: 13 * 60 * 1000,
  league2: 15 * 60 * 1000,
  league3: 17 * 60 * 1000,
  league4: 20 * 60 * 1000,
  league5: 25 * 60 * 1000,
  league6: 30 * 60 * 1000,
};

function encUser(userId){
  return encodeURIComponent(String(userId).trim());
}

async function fetchJson(url){
  const response=await fetch(url);
  if(!response.ok){
    throw new Error(`Network error: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

function normMatchList(payload){
  if(Array.isArray(payload)){
    return payload;
  }
  if(Array.isArray(payload?.data)){
    return payload.data;
  }
  if(Array.isArray(payload?.matches)){
    return payload.matches;
  }
  if(Array.isArray(payload?.data?.matches)){
    return payload.data.matches;
  }
  return [];
}

function getMatchId(match){
  return match?.id||match?.matchId||match?._id||null;
}

function getMatchDate(match){
  const value=match?.date||match?.playedAt||match?.endedAt||match?.createdAt||match?.updatedAt||null;
  const stamp=value?Date.parse(value):NaN;
  return Number.isFinite(stamp)?stamp:0;
}

function isFinishedMatch(match){
  const status=String(match?.status||match?.state||'').toLowerCase();
  if(!status){
    return true;
  }
  if(status.includes('live')||status.includes('active')||status.includes('ongoing')||status.includes('progress')){
    return false;
  }
  return true;
}

async function getRecentMatchesForUser(userId){
  const u=encUser(userId);
  const urls=[
    `https://api.mcsrranked.com/users/${u}/matches`,
    `https://api.mcsrranked.com/users/${u}/matches?count=10`,
    `https://api.mcsrranked.com/api/users/${u}/matches`,
    `https://api.mcsrranked.com/api/users/${u}/matches?count=10`,
  ];

  let lastError=null;
  for(const url of urls){
    try{
      const payload=await fetchJson(url);
      const matches=normMatchList(payload).filter((match)=>getMatchId(match)&&isFinishedMatch(match));
      if(matches.length > 0){
        matches.sort((a,b)=>getMatchDate(b)-getMatchDate(a));
        return matches;
      }
    } catch(err){
      lastError = err;
    }
  }

  if(lastError){
    throw lastError;
  }
  return [];
}

async function getSharedRecentMatchId(users){
  const cleanUsers=[...new Set((users||[]).map((user)=>String(user||'').trim()).filter(Boolean))];
  if(cleanUsers.length===0){
    throw new Error('No player IGNs were provided.');
  }

  const byId=new Map();
  for(const user of cleanUsers){
    const matches=await getRecentMatchesForUser(user);
    for(const match of matches){
      const id=getMatchId(match);
      if(!id){
        continue;
      }
      if(!byId.has(id)){
        byId.set(id,{ count:0, date:getMatchDate(match) });
      }
      const row=byId.get(id);
      row.count+=1;
      row.date=Math.max(row.date,getMatchDate(match));
    }
  }

  const ranked=[...byId.entries()].sort((left,right)=>{
    if(right[1].count!==left[1].count){
      return right[1].count-left[1].count;
    }
    return right[1].date-left[1].date;
  });

  const best=ranked[0];
  if(!best){
    throw new Error('Could not find a recent finished match.');
  }
  if(best[1].count<2&&cleanUsers.length>1){
    throw new Error('Could not find a shared recent match.');
  }
  return best[0];
}

async function main(){
  const args=process.argv.slice(2);
  const matchIdArg=args.find((a)=>a.startsWith('--matchId='))?.split('=')[1];
  const dnfTimeArg=args.find((a)=>a.startsWith('--dnfTime='))?.split('=')[1];

  if(!matchIdArg||!dnfTimeArg){
    console.error('Usage: node matchDataFromId.js --matchId=<matchId> --dnfTime=<dnfTime>');
    process.exit(1);
  }

  if(Number.isNaN(Number(dnfTimeArg))){
    console.error('Invalid dnfTime');
    process.exit(1);
  }

  const dnfTime=Number(dnfTimeArg);
  const dir=path.join(__dirname,'scripts','data');
  const filename=path.join(dir,`match_${matchIdArg}.json`);

  try{
    console.log(`Fetching match ${matchIdArg}...`);
    const response=await getMatchData(matchIdArg);
    const results=parseResponse(response,dnfTime);
    await fs.promises.mkdir(dir,{recursive:true});
    await fs.promises.writeFile(filename,JSON.stringify(results,null,2),'utf-8');
    console.log(`\nDone! Results written to ${filename}`);
  } catch(err){
    console.error(`Error on match ${matchIdArg}: ${err.message}`);
  }
}

if(require.main===module){
  main();
}

module.exports={
  BASE_URL,
  DNF_TIMES,
  getRecentMatchesForUser,
  getMatchData,
  getSharedRecentMatchId,
  parseResponse,
  main,
};