import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const ASSET = "./assets/cards/";
let app, auth, db, functions, uid, roomId, roomCode, roomData, myView, stopPublic, stopView;
let selected = new Set(), busy = false;

const configured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");
function show(id){$(id).classList.remove("hidden")}
function hide(id){$(id).classList.add("hidden")}
function err(id,msg){$(id).textContent=msg||""}
function call(name,data={}){return httpsCallable(functions,name)(data).then(r=>r.data)}
function money(n){return Number(n||0).toLocaleString("ja-JP")}
function cardSrc(card){return ASSET+(card==="STAR"?"star.png":card+".png")}
function backSrc(star){return ASSET+(star?"裏（スター）.png":"裏（ノーマル）.png")}
function setBusy(v){busy=v;document.querySelectorAll("button").forEach(b=>{if(!b.dataset.keepEnabled)b.disabled=v})}

async function init(){
  if(!configured){$("connection").textContent="Firebase未設定";$("lobbyError").textContent="firebase-config.js にFirebase設定を入力してください。READMEの手順を参照。";return}
  try{
    app=initializeApp(firebaseConfig);auth=getAuth(app);db=getDatabase(app);functions=getFunctions(app,"asia-northeast1");
    await signInAnonymously(auth);uid=auth.currentUser.uid;$("connection").textContent="接続済み";
  }catch(e){$("connection").textContent="接続エラー";err("lobbyError",e.message)}
}
function listen(id){
  if(stopPublic)stopPublic();if(stopView)stopView();
  roomId=id;
  stopPublic=onValue(ref(db,`rooms/${id}/public`),snap=>{roomData=snap.val();render()});
  stopView=onValue(ref(db,`rooms/${id}/views/${uid}`),snap=>{myView=snap.val();render()});
}
function currentPlayer(){return roomData?.players?.find(p=>p.uid===uid)}
function isMyTurn(){return roomData?.players?.[roomData.currentTurn]?.uid===uid}
function render(){
  if(!roomData)return;
  roomCode=roomData.code;
  if(roomData.status==="waiting"){
    hide("lobby");hide("game");show("waiting");$("roomCodeView").textContent=roomCode;
    $("waitingSeats").innerHTML=(roomData.players||[]).map((p,i)=>`<div class="seat-slot"><b>SEAT ${i+1}</b><span>${esc(p.name)}${p.isCpu?" · CPU":""}</span></div>`).join("");
    $("startGame").disabled=roomData.hostUid!==uid||roomData.players.length!==3;
    $("addCpu").disabled=roomData.hostUid!==uid||roomData.players.length>=3;
    return;
  }
  if(roomData.status==="finished"){hide("lobby");hide("waiting");show("game");}
  else{hide("lobby");hide("waiting");show("game")}
  $("gameRoomCode").textContent=roomCode;$("pot").textContent=money(roomData.pot);
  $("currentBet").textContent=money(roomData.currentBet);$("phaseLabel").textContent=roomData.phase==="prebet"?"BET前":roomData.phase==="betting"?"BET中":roomData.phase==="showdown"?"結果":"終了";
  const me=currentPlayer();$("selfName").textContent=me?.name||"---";$("selfScore").textContent=money(me?.score);
  $("opponents").innerHTML=(myView?.players||[]).filter(p=>p.uid!==uid).map(p=>playerCard(p)).join("");
  const ownCards=Array.from({length:3},(_,i)=>`<img class="playing-card ${selected.has(i)?"selected":""}" data-index="${i}" src="${backSrc(myView?.hasStar)}" alt="伏せられたカード">`).join("");
  $("myHand").innerHTML=ownCards;
  $("myHand").querySelectorAll("img").forEach(img=>img.addEventListener("click",()=>{const i=Number(img.dataset.index);selected.has(i)?selected.delete(i):selected.add(i);render()}));
  const active=roomData.players[roomData.currentTurn];
  $("turnInfo").textContent=roomData.status==="finished"?"ゲーム終了":`手番：${active?.name||"---"}`;
  $("gameLog").textContent=(roomData.log||[]).slice(-3).join("　／　");
  $("raiseInfo").textContent=`レイズ ${roomData.raisesTotal||0}/8 · フォールド ${roomData.foldUsed?"使用済み":"未使用"}`;
  const myTurn=isMyTurn()&&roomData.status==="playing"&&!me?.folded&&!me?.allIn;
  $("actionStatus").textContent=roomData.status==="finished"?"ゲーム終了":myTurn?"あなたの番です":me?.folded?"フォールド中":me?.allIn?"オールイン済み":"相手の行動を待っています";
  if(roomData.phase==="prebet"&&myTurn){show("preBetActions");hide("betActions")}else if(roomData.phase==="betting"&&myTurn){hide("preBetActions");show("betActions")}else{hide("preBetActions");hide("betActions")}
  $("foldBtn").disabled=!!roomData.foldUsed||(roomData.raisesTotal||0)>=4;
  $("raiseBtn").disabled=(roomData.raisesTotal||0)>=8||(me?.raises||0)>=4||me?.score<(roomData.currentBet*2-(me?.contribution||0));
  $("callBtn").disabled=me?.score<(roomData.currentBet-(me?.contribution||0));
  $("changeBtn").disabled=selected.size<1||selected.size>3;
  $("swapBtn").disabled=selected.size<1||selected.size>3||!!me?.swapped;
  $("changeBtn").textContent=`チェンジ${selected.size?` (${selected.size}枚)`:""}`;
  $("swapBtn").textContent=`スワップ${selected.size?` (${selected.size}枚)`:""}`;
}
function playerCard(p){
  const faces=(p.hand||[]).map(c=>`<img class="playing-card" src="${cardSrc(c)}" alt="カード">`).join("");
  const status=p.folded?"FOLD":p.allIn?"ALL IN":p.called?"CALL":"";
  return `<div class="player-card ${roomData.players[roomData.currentTurn]?.uid===p.uid?"active":""}"><div class="player-head"><b>${esc(p.name)}</b><span class="muted">${money(p.score)}点 · ${status}</span></div><div class="opponent-hand">${faces}</div></div>`;
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function runAction(action,extra={}){
  if(busy)return;setBusy(true);err("gameError","");
  try{await call("playerAction",{roomId,action,indices:[...selected],...extra});selected.clear()}
  catch(e){err("gameError",e.message)}
  finally{setBusy(false);render()}
}

$("createRoom").onclick=async()=>{try{setBusy(true);const r=await call("createRoom",{name:$("playerName").value.trim()||"Player"});listen(r.roomId)}catch(e){err("lobbyError",e.message)}finally{setBusy(false)}};
$("joinRoom").onclick=async()=>{try{setBusy(true);const r=await call("joinRoom",{code:$("roomCode").value.trim().toUpperCase(),name:$("playerName").value.trim()||"Player"});listen(r.roomId)}catch(e){err("lobbyError",e.message)}finally{setBusy(false)}};
$("addCpu").onclick=async()=>{try{setBusy(true);await call("addCpu",{roomId})}catch(e){err("waitingError",e.message)}finally{setBusy(false)}};
$("startGame").onclick=async()=>{try{setBusy(true);await call("startGame",{roomId})}catch(e){err("waitingError",e.message)}finally{setBusy(false)}};
$("copyCode").onclick=()=>navigator.clipboard?.writeText(roomCode);
$("leaveRoom").onclick=()=>{if(stopPublic)stopPublic();if(stopView)stopView();roomId=null;roomData=null;myView=null;hide("waiting");show("lobby")};
$("backLobby").onclick=()=>{if(roomData?.status==="finished"){$("leaveRoom").click()}else err("gameError","対戦中はルームを退出できません。")};
$("checkBtn").onclick=()=>runAction("check");
$("changeBtn").onclick=()=>runAction("change");
$("betBtn").onclick=()=>runAction("bet",{amount:Number($("betAmount").value)});
$("callBtn").onclick=()=>runAction("call");
$("raiseBtn").onclick=()=>runAction("raise");
$("foldBtn").onclick=()=>runAction("fold");
$("allInBtn").onclick=()=>runAction("allin");
$("swapBtn").onclick=()=>runAction("swap");
$("rulesBtn").onclick=()=>$("rulesDialog").showModal();
$("closeRules").onclick=()=>$("rulesDialog").close();
init();