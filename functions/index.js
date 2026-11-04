const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");
const crypto = require("crypto");
initializeApp();
const db = getDatabase();

const makeDeck=()=>[-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,1,2,3,4,5,6,7,8,9,10,0,0,0,"STAR"].map(String);
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const code=()=>crypto.randomBytes(3).toString("hex").toUpperCase();
const player=(uid,name,isCpu=false)=>({uid,name,isCpu,score:10000,hand:[],folded:false,allIn:false,contribution:0,called:false,swapped:false,raises:0});
function requireAuth(req){if(!req.auth)throw new HttpsError("unauthenticated","ログインが必要です");return req.auth.uid}
function nextTurn(s,from=s.currentTurn){
  for(let n=1;n<=s.players.length;n++){const i=(from+n)%s.players.length,p=s.players[i];if(!p.folded&&!p.allIn)return i}
  return from;
}
function active(s){return s.players.filter(p=>!p.folded)}
function evaluate(hand){
  const nums=hand.map(c=>c==="STAR"?null:Number(c));
  let role="",bonus=0;
  if(hand.every(c=>c==="0")){role="TRIPLITH";bonus=1000}
  else if(hand.every(c=>c==="STAR"||c==="0")){role="SYMBOL";bonus=400}
  else if(nums.filter(x=>x!==null).some((x,i,a)=>a.some((y,j)=>j!==i&&Math.abs(x)===Math.abs(y)))){role="DOUBLES";bonus=200}
  const product=nums.reduce((v,x)=>v*(x===null?1:x),1);
  return {score:product+bonus,product,role};
}
function finishRound(s){
  s.phase="showdown";s.status="playing";
  const contenders=active(s);
  if(!contenders.length)return;
  const results=contenders.map(p=>({p,...evaluate(p.hand)})).sort((a,b)=>b.score-a.score);
  const best=results[0].score,winners=results.filter(x=>x.score===best).map(x=>x.p);
  const pot=s.players.reduce((n,p)=>n+p.contribution,0);
  // MVP settlement: split the pot among tied winners. Contributions are capped at each player's actual all-in.
  const share=Math.floor(pot/winners.length);
  winners.forEach(p=>p.score+=share);
  let remainder=pot-share*winners.length;
  winners.forEach(p=>{if(remainder>0){p.score++;remainder--}});
  s.lastResult={winners:winners.map(p=>p.name),pot,handResults:results.map(x=>({name:x.p.name,score:x.score,product:x.product,role:x.role,hand:x.p.hand}))};
  s.log.push(`${winners.map(p=>p.name).join("・")} の勝利（${pot}点）`);
  s.players.forEach(p=>{p.contribution=0;p.called=false});
  if(s.players.some(p=>p.score<=0||p.score>20000)){s.status="finished";s.phase="finished";return}
  // Begin next hand automatically.
  s.deck=shuffle(makeDeck());s.players.forEach(p=>{p.hand=[s.deck.pop(),s.deck.pop(),s.deck.pop()];p.folded=false;p.allIn=false;p.contribution=0;p.called=false;p.swapped=false;p.raises=0});
  s.pot=0;s.currentBet=0;s.raisesTotal=0;s.foldUsed=false;s.checkCount=0;s.phase="prebet";s.currentTurn=(s.currentTurn+1)%s.players.length;s.lastResult=null;
}
function settleIfReady(s){
  if(active(s).length<=1){finishRound(s);return true}
  if(s.phase==="prebet"&&s.checkCount>=active(s).length){finishRound(s);return true}
  if(s.phase==="betting"){
    const ready=active(s).every(p=>p.allIn||(p.called&&p.contribution>=s.currentBet));
    if(ready){finishRound(s);return true}
  }
  return false;
}
function doAction(s,uid,action,indices=[],amount){
  const p=s.players.find(x=>x.uid===uid);
  if(!p||p.isCpu||p.folded||p.allIn||s.players[s.currentTurn]?.uid!==uid)throw new HttpsError("failed-precondition","あなたの手番ではありません");
  if(s.phase==="prebet"){
    if(action==="check"){p.called=true;s.checkCount++;s.log.push(`${p.name}：チェック`);s.currentTurn=nextTurn(s)}
    else if(action==="change"){
      if(!indices.length||indices.length>3||new Set(indices).size!==indices.length||indices.some(i=>i<0||i>2))throw new HttpsError("invalid-argument","交換するカードを1〜3枚選択してください");
      const old=indices.map(i=>p.hand[i]);s.deck.push(...old);shuffle(s.deck);
      indices.forEach(i=>p.hand[i]=s.deck.pop());s.checkCount=0;s.log.push(`${p.name}：チェンジ（${indices.length}枚）`);s.currentTurn=nextTurn(s);
    }
    else if(action==="bet"){
      if(![100,200,400,800].includes(amount)||p.score<amount)throw new HttpsError("invalid-argument","ベット額が不正、または点数が不足しています");
      p.score-=amount;p.contribution+=amount;s.currentBet=amount;s.pot+=amount;s.phase="betting";s.checkCount=0;
      s.players.forEach(x=>x.called=x.uid===uid);s.log.push(`${p.name}：${amount}点ベット`);s.currentTurn=nextTurn(s);
    } else throw new HttpsError("invalid-argument","このフェーズではその行動はできません");
  }else if(s.phase==="betting"){
    if(action==="swap"){
      if(p.swapped||!indices.length||indices.length>3||new Set(indices).size!==indices.length||indices.some(i=>i<0||i>2))throw new HttpsError("invalid-argument","スワップは1人1回、1〜3枚です");
      indices.forEach(i=>p.hand[i]=s.deck.pop());p.swapped=true;s.log.push(`${p.name}：スワップ（${indices.length}枚）`);
      return;
    }
    if(action==="call"){
      const due=s.currentBet-p.contribution;if(due<0||p.score<due)throw new HttpsError("failed-precondition","点数が足りません。オールインを選択してください");
      p.score-=due;p.contribution+=due;s.pot+=due;p.called=true;s.log.push(`${p.name}：コール`);s.currentTurn=nextTurn(s);
    }else if(action==="raise"){
      if(s.raisesTotal>=8||p.raises>=4)throw new HttpsError("failed-precondition","レイズ上限です");
      const newBet=s.currentBet*2,due=newBet-p.contribution;if(p.score<due)throw new HttpsError("failed-precondition","レイズする点数が不足しています");
      p.score-=due;p.contribution+=due;s.pot+=due;s.currentBet=newBet;s.raises++;s.raisesTotal++;
      s.players.forEach(x=>x.called=x.uid===uid);s.log.push(`${p.name}：レイズ（${newBet}点）`);s.currentTurn=nextTurn(s);
    }else if(action==="fold"){
      if(s.foldUsed||s.raisesTotal>=4)throw new HttpsError("failed-precondition","フォールドできません");
      const penalty=Math.min(p.score,s.currentBet*2);p.score-=penalty;p.contribution+=penalty;s.pot+=penalty;p.folded=true;s.foldUsed=true;s.log.push(`${p.name}：フォールド`);s.currentTurn=nextTurn(s);
    }else if(action==="allin"){
      const amount=p.score;p.score=0;p.contribution+=amount;s.pot+=amount;p.allIn=true;p.called=true;s.log.push(`${p.name}：オールイン`);s.currentTurn=nextTurn(s);
    }else throw new HttpsError("invalid-argument","不正な行動です");
  }else throw new HttpsError("failed-precondition","現在は行動できません");
  settleIfReady(s);
}
function cpuAction(s,p){
  if(s.phase==="prebet"){
    if(Math.random()<0.18&&p.score>=100){p.score-=100;p.contribution+=100;s.pot+=100;s.currentBet=100;s.phase="betting";s.checkCount=0;s.players.forEach(x=>x.called=x.uid===p.uid);s.log.push(`${p.name}：100点ベット`);s.currentTurn=nextTurn(s)}
    else{p.called=true;s.checkCount++;s.log.push(`${p.name}：チェック`);s.currentTurn=nextTurn(s)}
  }else{
    const due=s.currentBet-p.contribution;
    if(p.score<due){const a=p.score;p.score=0;p.contribution+=a;s.pot+=a;p.allIn=true;p.called=true;s.log.push(`${p.name}：オールイン`)}
    else{p.score-=due;p.contribution+=due;s.pot+=due;p.called=true;s.log.push(`${p.name}：コール`)}
    s.currentTurn=nextTurn(s);
  }
}
function runCpu(s){
  for(let i=0;i<8&&s.status==="playing"&&s.players[s.currentTurn]?.isCpu;i++){
    const p=s.players[s.currentTurn];cpuAction(s,p);if(settleIfReady(s))break;
  }
}
function publicState(s){
  return {code:s.code,status:s.status,hostUid:s.hostUid,players:s.players.map(p=>({uid:p.uid,name:p.name,isCpu:p.isCpu,score:p.score,folded:p.folded,allIn:p.allIn,called:p.called,swapped:p.swapped,raises:p.raises,contribution:p.contribution})),phase:s.phase,currentTurn:s.currentTurn,currentBet:s.currentBet,pot:s.pot,raisesTotal:s.raisesTotal,foldUsed:s.foldUsed,log:s.log.slice(-12),lastResult:s.lastResult};
}
function views(s){
  const out={};
  for(const viewer of s.players){
    out[viewer.uid]={hasStar:viewer.hand.includes("STAR"),players:s.players.map(p=>({uid:p.uid,name:p.name,isCpu:p.isCpu,score:p.score,folded:p.folded,allIn:p.allIn,called:p.called,swapped:p.swapped,raises:p.raises,hand:p.uid===viewer.uid?[]:p.hand}))};
  }
  return out;
}
async function publish(id,s){
  await db.ref(`rooms/${id}`).update({public:publicState(s),views:views(s)});
}
async function mutateRoom(roomId,mutator){
  const r=db.ref(`rooms/${roomId}/state`);
  const result=await r.transaction(s=>{if(!s)return;mutator(s);return s},{applyLocally:false});
  if(!result.committed)throw new HttpsError("aborted","ルーム状態を更新できませんでした");
  await publish(roomId,result.snapshot.val());
  return result.snapshot.val();
}
exports.createRoom=onCall({region:"asia-northeast1"},async req=>{
  const uid=requireAuth(req),name=String(req.data.name||"Player").slice(0,16);
  let roomCode=code(),id=crypto.randomBytes(10).toString("hex");
  const s={code:roomCode,status:"waiting",hostUid:uid,players:[player(uid,name)],deck:[],phase:"waiting",currentTurn:0,currentBet:0,pot:0,raisesTotal:0,foldUsed:false,checkCount:0,log:["ルームを作成しました"],lastResult:null};
  await db.ref(`rooms/${id}/state`).set(s);await db.ref(`codes/${roomCode}`).set(id);await publish(id,s);
  return {roomId:id,code:roomCode};
});
exports.joinRoom=onCall({region:"asia-northeast1"},async req=>{
  const uid=requireAuth(req),roomCode=String(req.data.code||"").toUpperCase(),name=String(req.data.name||"Player").slice(0,16);
  const id=(await db.ref(`codes/${roomCode}`).get()).val();if(!id)throw new HttpsError("not-found","ルームが見つかりません");
  const s=await mutateRoom(id,state=>{if(state.status!=="waiting")throw new HttpsError("failed-precondition","このルームは開始済みです");if(state.players.length>=3)throw new HttpsError("resource-exhausted","満席です");if(state.players.some(p=>p.uid===uid))return;state.players.push(player(uid,name));state.log.push(`${name} が参加しました`)});
  return {roomId:id,code:s.code};
});
exports.addCpu=onCall({region:"asia-northeast1"},async req=>{
  const uid=requireAuth(req),id=req.data.roomId;
  await mutateRoom(id,s=>{if(s.hostUid!==uid||s.status!=="waiting")throw new HttpsError("permission-denied","ホストのみ追加できます");if(s.players.length>=3)throw new HttpsError("resource-exhausted","満席です");const n=s.players.filter(p=>p.isCpu).length+1;s.players.push(player(`CPU_${n}_${crypto.randomBytes(3).toString("hex")}`,`CPU ${n}`,true));s.log.push(`CPU ${n} を追加しました`)});
  return {ok:true};
});
exports.startGame=onCall({region:"asia-northeast1"},async req=>{
  const uid=requireAuth(req),id=req.data.roomId;
  const s=await mutateRoom(id,state=>{if(state.hostUid!==uid)throw new HttpsError("permission-denied","ホストのみ開始できます");if(state.players.length!==3)throw new HttpsError("failed-precondition","3席すべて埋めてください");state.deck=shuffle(makeDeck());state.players.forEach(p=>{p.hand=[state.deck.pop(),state.deck.pop(),state.deck.pop()];p.score=10000;p.folded=false;p.allIn=false;p.contribution=0;p.called=false;p.swapped=false;p.raises=0});state.status="playing";state.phase="prebet";state.currentTurn=0;state.currentBet=0;state.pot=0;state.raisesTotal=0;state.foldUsed=false;state.checkCount=0;state.log.push("ゲーム開始");runCpu(state)});
  return {ok:true};
});
exports.playerAction=onCall({region:"asia-northeast1"},async req=>{
  const uid=requireAuth(req),id=req.data.roomId,action=String(req.data.action||""),indices=Array.isArray(req.data.indices)?req.data.indices.map(Number):[];
  await mutateRoom(id,s=>{if(s.status!=="playing")throw new HttpsError("failed-precondition","ゲーム中ではありません");doAction(s,uid,action,indices,Number(req.data.amount));runCpu(s)});
  return {ok:true};
});