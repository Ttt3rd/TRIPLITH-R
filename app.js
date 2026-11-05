
const API_BASE = "https://triplith-r-game-server.ktkt8600.workers.dev";

const $ = (id) => document.getElementById(id);

const ASSET = "./assets/cards/";

const SESSION_KEYS = {
  accessCode: "triplithAccessCode",
  roomCode: "triplithRoomCode",
  playerToken: "triplithPlayerToken",
};

let snapshot = null;
let roomCode = null;
let playerToken = null;
let playerId = null;

let socket = null;
let reconnectTimer = null;
let fallbackTimer = null;

let selected = new Set();
let busy = false;
let manualLeave = false;


// ========================================
// 基本関数
// ========================================

function show(id) {
  $(id).classList.remove("hidden");
}

function hide(id) {
  $(id).classList.add("hidden");
}

function err(id, message) {
  $(id).textContent = message || "";
}

function money(value) {
  return Number(value || 0).toLocaleString("ja-JP");
}

function cardSrc(card) {
  return ASSET + (
    card === "STAR"
      ? "star.png"
      : `${card}.png`
  );
}

function backSrc(star) {
  return ASSET + (
    star
      ? "裏（スター）.png"
      : "裏（ノーマル）.png"
  );
}

function accessCode() {
  return String(
    $("accessCode").value ||
    sessionStorage.getItem(SESSION_KEYS.accessCode) ||
    ""
  ).trim();
}

function saveSession() {
  sessionStorage.setItem(
    SESSION_KEYS.accessCode,
    accessCode()
  );

  if (roomCode) {
    sessionStorage.setItem(
      SESSION_KEYS.roomCode,
      roomCode
    );
  }

  if (playerToken) {
    sessionStorage.setItem(
      SESSION_KEYS.playerToken,
      playerToken
    );
  }
}

function clearRoomSession() {
  sessionStorage.removeItem(SESSION_KEYS.roomCode);
  sessionStorage.removeItem(SESSION_KEYS.playerToken);
}

function setBusy(value) {
  busy = value;

  [
    "createRoom",
    "joinRoom",
    "addCpu",
    "startGame",
    "leaveRoom",
    "copyCode",
    "checkBtn",
    "changeBtn",
    "betBtn",
    "callBtn",
    "raiseBtn",
    "foldBtn",
    "allInBtn",
    "swapBtn",
    "backLobby",
  ].forEach((id) => {
    if ($(id)) {
      $(id).disabled = value;
    }
  });

  if (!value) {
    render();
  }
}

function getRoom() {
  return snapshot?.room || null;
}

function getMyPlayer() {
  return getRoom()?.players?.find(
    (player) => player.id === playerId
  ) || null;
}

function isMyTurn() {
  const room = getRoom();

  return (
    room?.players?.[room.currentTurn]?.id === playerId
  );
}


// ========================================
// Cloudflare API
// ========================================

async function api(path, payload = {}) {
  const response = await fetch(
    `${API_BASE}${path}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      cache: "no-store",

      body: JSON.stringify({
        accessCode: accessCode(),
        ...payload,
      }),
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      `サーバーエラー (${response.status})`
    );
  }

  return data;
}


// ========================================
// ゲーム状態
// ========================================

function setSnapshot(next) {
  if (!next?.room || !next?.view) {
    return;
  }

  snapshot = next;
  playerId = next.playerId;
  roomCode = next.room.code;

  render();
}


// ========================================
// WebSocket
// ========================================

function startSocket() {
  stopSocket(false);

  if (!roomCode || !playerToken) {
    return;
  }

  const wsUrl =
    API_BASE
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:") +
    `/api/rooms/ws?code=${encodeURIComponent(roomCode)}`;

  try {
    socket = new WebSocket(wsUrl);
  } catch {
    startFallbackPolling();
    scheduleReconnect();
    return;
  }

  const ws = socket;

  ws.addEventListener("open", () => {
    if (socket !== ws) return;

    ws.send(
      JSON.stringify({
        type: "auth",
        accessCode: accessCode(),
        playerToken,
      })
    );

    $("connection").textContent = "通信中";

    stopFallbackPolling();
  });

  ws.addEventListener("message", (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "state") {
      setSnapshot(message.data);

      $("connection").textContent = "接続済み";

      stopFallbackPolling();

    } else if (message.type === "error") {
      $("connection").textContent = "認証エラー";

      err(
        getRoom()?.status === "waiting"
          ? "waitingError"
          : "gameError",
        message.message
      );
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) {
      socket = null;
    }

    if (manualLeave || !roomCode) {
      return;
    }

    $("connection").textContent = "再接続中";

    startFallbackPolling();
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    $("connection").textContent = "通信再接続中";

    startFallbackPolling();
  });
}

function stopSocket(clearReconnect = true) {
  if (clearReconnect && reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    const old = socket;
    socket = null;

    try {
      old.close();
    } catch {
      // 接続終了時のエラーは無視
    }
  }
}

function scheduleReconnect() {
  if (
    reconnectTimer ||
    manualLeave ||
    !roomCode
  ) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (!manualLeave && roomCode) {
      startSocket();
    }
  }, 2500);
}


// ========================================
// WebSocket切断時の代替通信
// ========================================

function startFallbackPolling() {
  if (fallbackTimer || !roomCode) {
    return;
  }

  fallbackTimer = setInterval(async () => {
    if (socket?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      const result = await api(
        "/api/rooms/state",
        {
          roomCode,
          playerToken,
        }
      );

      setSnapshot(result.snapshot);

    } catch (error) {
      $("connection").textContent = "接続待機中";

      if (
        /プレイヤー認証|ルームが見つかりません/.test(
          error.message
        )
      ) {
        clearRoomSession();

        roomCode = null;
        playerToken = null;

        stopFallbackPolling();

        hide("waiting");
        hide("game");
        show("lobby");

        err(
          "lobbyError",
          "セッションが無効になりました。もう一度ルームに参加してください。"
        );
      }
    }
  }, 5000);
}

function stopFallbackPolling() {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
  }

  fallbackTimer = null;
}


// ========================================
// ルーム参加
// ========================================

async function enterRoom(
  code,
  token,
  initialSnapshot = null
) {
  manualLeave = false;

  roomCode = code;
  playerToken = token;

  if (initialSnapshot) {
    setSnapshot(initialSnapshot);

  } else {
    const result = await api(
      "/api/rooms/state",
      {
        roomCode,
        playerToken,
      }
    );

    setSnapshot(result.snapshot);
  }

  saveSession();

  startSocket();
}


// ========================================
// プレイヤー表示
// ========================================

function playerCard(player) {
  const faces = (player.hand || [])
    .map(
      (card) => `
        <img
          class="playing-card"
          src="${cardSrc(card)}"
          alt="カード"
        >
      `
    )
    .join("");

  const status =
    player.folded
      ? "FOLD"
      : player.allIn
        ? "ALL IN"
        : player.called
          ? "CALL"
          : "";

  const active =
    getRoom()?.players?.[
      getRoom().currentTurn
    ]?.id === player.id;

  return `
    <div class="player-card ${active ? "active" : ""}">
      <div class="player-head">
        <b>${escapeHtml(player.name)}</b>

        <span class="muted">
          ${money(player.score)}点 · ${status}
        </span>
      </div>

      <div class="opponent-hand">
        ${faces}
      </div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]
  );
}


// ========================================
// 待機ルーム表示
// ========================================

function renderWaiting(room) {
  hide("lobby");
  hide("game");
  show("waiting");

  $("roomCodeView").textContent = room.code;

  const seats = room.players.map(
    (player, index) => `
      <div class="seat-slot">
        <b>SEAT ${index + 1}</b>

        <span>
          ${escapeHtml(player.name)}
          ${player.isCpu ? " · CPU" : ""}
        </span>
      </div>
    `
  );

  for (
    let index = seats.length;
    index < 3;
    index++
  ) {
    seats.push(`
      <div class="seat-slot empty-seat">
        <b>SEAT ${index + 1}</b>
        <span>空席</span>
      </div>
    `);
  }

  $("waitingSeats").innerHTML = seats.join("");

  const isHost =
    room.hostPlayerId === playerId;

  $("startGame").disabled =
    !isHost ||
    room.players.length !== 3 ||
    busy;

  $("addCpu").disabled =
    !isHost ||
    room.players.length >= 3 ||
    busy;

  $("startGame").textContent =
    room.players.length === 3
      ? "ゲーム開始"
      : `ゲーム開始（${room.players.length}/3人）`;
}


// ========================================
// ゲーム画面表示
// ========================================

function renderGame(room, view) {
  hide("lobby");
  hide("waiting");
  show("game");

  $("gameRoomCode").textContent = room.code;

  $("pot").textContent = money(room.pot);

  $("currentBet").textContent =
    money(room.currentBet);

  $("phaseLabel").textContent =
    room.phase === "prebet"
      ? "BET前"
      : room.phase === "betting"
        ? "BET中"
        : room.phase === "showdown"
          ? "結果"
          : "終了";


  // ------------------------------------
  // 自分の情報
  // ------------------------------------

  const me = getMyPlayer();

  $("selfName").textContent =
    me?.name || "---";

  $("selfScore").textContent =
    money(me?.score);


  // ------------------------------------
  // 他のプレイヤー
  // ------------------------------------

  $("opponents").innerHTML =
    (view.players || [])
      .filter(
        (player) => player.id !== playerId
      )
      .map(playerCard)
      .join("");


  // ------------------------------------
  // 自分の手札
  // ------------------------------------

  // starIndexは自分のスターカードの位置。
  // 0～2ならその位置のみスター用の裏面にする。
  // -1ならスターを持っていない。

  const starIndex = Number(view.starIndex);

  const ownCards = Array.from(
    { length: 3 },
    (_, index) => {
      const isStar = starIndex === index;

      const imageSource = backSrc(isStar);

      const altText = isStar
        ? "スターカード"
        : "伏せられたカード";

      return `
        <img
          class="playing-card ${selected.has(index) ? "selected" : ""}"
          data-index="${index}"
          src="${imageSource}"
          alt="${altText}"
          title="${isStar ? "スターカード" : "伏せカード"}"
        >
      `;
    }
  ).join("");

  $("myHand").innerHTML = ownCards;

  $("myHand")
    .querySelectorAll("img")
    .forEach((image) => {
      image.addEventListener("click", () => {
        if (busy || !isMyTurn()) {
          return;
        }

        const index = Number(image.dataset.index);

        if (selected.has(index)) {
          selected.delete(index);
        } else {
          selected.add(index);
        }

        render();
      });
    });


  // ------------------------------------
  // 手番情報
  // ------------------------------------

  const activePlayer =
    room.players[room.currentTurn];

  $("turnInfo").textContent =
    room.status === "finished"
      ? "ゲーム終了"
      : `手番：${activePlayer?.name || "---"}`;


  // ------------------------------------
  // ログ
  // ------------------------------------

  const logLines =
    (room.log || []).slice(-3);

  if (room.lastResult) {
    const previous =
      room.lastResult.allTied
        ? "前回：同点（賭け点返却）"
        : `前回：${room.lastResult.winners.join("・")} の勝利`;

    const revealed =
      (room.lastResult.hands || [])
        .map((hand) =>
          `${hand.name}: ${(hand.hand || []).join(" / ")}${hand.role ? ` (${hand.role})` : ""}${hand.folded ? " [FOLD]" : ""}`
        )
        .join(" ｜ ");

    logLines.push(previous);

    if (revealed) {
      logLines.push(`公開手札：${revealed}`);
    }
  }

  $("gameLog").textContent =
    logLines.join(" ／ ");


  // ------------------------------------
  // レイズ情報
  // ------------------------------------

  $("raiseInfo").textContent =
    `レイズ ${room.raisesTotal || 0}/8 · フォールド ${
      room.foldUsed ? "使用済み" : "未使用"
    }`;


  // ------------------------------------
  // 手番判定
  // ------------------------------------

  const myTurn =
    isMyTurn() &&
    room.status === "playing" &&
    !me?.folded &&
    !me?.allIn &&
    !busy;

  $("actionStatus").textContent =
    room.status === "finished"
      ? "ゲーム終了"
      : myTurn
        ? "あなたの番です"
        : me?.folded
          ? "フォールド中"
          : me?.allIn
            ? "オールイン済み"
            : "相手の行動を待っています";


  // ------------------------------------
  // フェーズごとの操作ボタン
  // ------------------------------------

  if (room.phase === "prebet" && myTurn) {
    show("preBetActions");
    hide("betActions");

  } else if (
    room.phase === "betting" &&
    myTurn
  ) {
    hide("preBetActions");
    show("betActions");

  } else {
    hide("preBetActions");
    hide("betActions");
  }


  // ------------------------------------
  // ボタンの使用条件
  // ------------------------------------

  $("foldBtn").disabled =
    !!room.foldUsed ||
    (room.raisesTotal || 0) >= 4 ||
    busy;

  $("raiseBtn").disabled =
    (room.raisesTotal || 0) >= 8 ||
    (me?.raises || 0) >= 4 ||
    me?.score <
      (
        room.currentBet * 2 -
        (me?.contribution || 0)
      ) ||
    busy;

  $("callBtn").disabled =
    me?.score <
      (
        room.currentBet -
        (me?.contribution || 0)
      ) ||
    busy;

  $("changeBtn").disabled =
    selected.size < 1 ||
    selected.size > 3 ||
    busy;

  $("swapBtn").disabled =
    selected.size < 1 ||
    selected.size > 3 ||
    !!me?.swapped ||
    busy;

  $("changeBtn").textContent =
    `チェンジ${selected.size ? ` (${selected.size}枚)` : ""}`;

  $("swapBtn").textContent =
    `スワップ${selected.size ? ` (${selected.size}枚)` : ""}`;

  $("allInBtn").disabled =
    (me?.score || 0) <= 0 ||
    busy;

  $("checkBtn").disabled = busy;
  $("betBtn").disabled = busy;


  // ------------------------------------
  // ゲーム終了
  // ------------------------------------

  if (
    room.status === "finished" &&
    room.lastResult
  ) {
    const result = room.lastResult;

    $("turnInfo").textContent =
      result.allTied
        ? "最終結果：同点"
        : `勝者：${result.winners.join("・")}`;

    $("gameLog").textContent =
      result.hands
        .map(
          (hand) =>
            `${hand.name}: ${hand.hand.join(" / ")} ${hand.role ? `(${hand.role})` : ""}`
        )
        .join("　｜　");
  }
}


// ========================================
// 全体描画
// ========================================

function render() {
  if (!snapshot) {
    return;
  }

  const room = getRoom();

  if (!room) {
    return;
  }

  if (room.status === "waiting") {
    renderWaiting(room);
  } else {
    renderGame(room, snapshot.view);
  }
}


// ========================================
// ゲーム操作
// ========================================

async function runAction(action, extra = {}) {
  if (busy || !roomCode) {
    return;
  }

  setBusy(true);

  err("gameError", "");

  try {
    const result = await api(
      "/api/rooms/action",
      {
        roomCode,
        playerToken,
        action,
        indices: [...selected],
        ...extra,
      }
    );

    if (result.snapshot) {
      setSnapshot(result.snapshot);
    }

    selected.clear();

  } catch (error) {
    err("gameError", error.message);

  } finally {
    setBusy(false);
  }
}


// ========================================
// ルーム作成
// ========================================

$("createRoom").onclick = async () => {
  if (!accessCode()) {
    err(
      "lobbyError",
      "専用アクセスコードを入力してください。"
    );

    $("accessCode").focus();
    return;
  }

  manualLeave = false;

  setBusy(true);
  err("lobbyError", "");

  try {
    const result = await api(
      "/api/rooms/create",
      {
        name:
          $("playerName").value.trim() ||
          "Player",
      }
    );

    $("accessCode").value = accessCode();

    await enterRoom(
      result.roomCode,
      result.playerToken,
      result.snapshot
    );

  } catch (error) {
    err("lobbyError", error.message);

  } finally {
    setBusy(false);
  }
};


// ========================================
// ルーム参加
// ========================================

$("joinRoom").onclick = async () => {
  if (!accessCode()) {
    err(
      "lobbyError",
      "専用アクセスコードを入力してください。"
    );

    $("accessCode").focus();
    return;
  }

  const code =
    $("roomCode").value.trim().toUpperCase();

  if (!code) {
    err(
      "lobbyError",
      "ルームコードを入力してください。"
    );

    return;
  }

  manualLeave = false;

  setBusy(true);
  err("lobbyError", "");

  try {
    const result = await api(
      "/api/rooms/join",
      {
        roomCode: code,
        name:
          $("playerName").value.trim() ||
          "Player",
      }
    );

    $("accessCode").value = accessCode();

    await enterRoom(
      result.roomCode,
      result.playerToken,
      result.snapshot
    );

  } catch (error) {
    err("lobbyError", error.message);

  } finally {
    setBusy(false);
  }
};


// ========================================
// CPU追加
// ========================================

$("addCpu").onclick = async () => {
  setBusy(true);
  err("waitingError", "");

  try {
    const result = await api(
      "/api/rooms/cpu",
      {
        roomCode,
        playerToken,
      }
    );

    if (result.snapshot) {
      setSnapshot(result.snapshot);
    }

  } catch (error) {
    err("waitingError", error.message);

  } finally {
    setBusy(false);
  }
};


// ========================================
// ゲーム開始
// ========================================

$("startGame").onclick = async () => {
  setBusy(true);
  err("waitingError", "");

  try {
    const result = await api(
      "/api/rooms/start",
      {
        roomCode,
        playerToken,
      }
    );

    if (result.snapshot) {
      setSnapshot(result.snapshot);
    }

  } catch (error) {
    err("waitingError", error.message);

  } finally {
    setBusy(false);
  }
};


// ========================================
// ルーム退出
// ========================================

async function leaveCurrentRoom() {
  if (!roomCode || !playerToken) {
    return;
  }

  try {
    await api(
      "/api/rooms/leave",
      {
        roomCode,
        playerToken,
      }
    );
  } catch {
    // すでにルームが閉じている場合など
  }

  manualLeave = true;

  stopSocket();
  stopFallbackPolling();

  roomCode = null;
  playerToken = null;
  playerId = null;
  snapshot = null;

  selected.clear();

  clearRoomSession();

  hide("waiting");
  hide("game");
  show("lobby");

  $("connection").textContent = "未接続";
}


// ========================================
// ボタンイベント
// ========================================

$("copyCode").onclick = () => {
  if (
    roomCode &&
    navigator.clipboard?.writeText
  ) {
    navigator.clipboard.writeText(roomCode);
  }
};

$("leaveRoom").onclick =
  leaveCurrentRoom;

$("backLobby").onclick = () => {
  if (getRoom()?.status === "finished") {
    leaveCurrentRoom();
  } else {
    err(
      "gameError",
      "対戦中はルームを退出できません。"
    );
  }
};

$("checkBtn").onclick =
  () => runAction("check");

$("changeBtn").onclick =
  () => runAction("change");

$("betBtn").onclick =
  () => runAction(
    "bet",
    {
      amount: Number($("betAmount").value),
    }
  );

$("callBtn").onclick =
  () => runAction("call");

$("raiseBtn").onclick =
  () => runAction("raise");

$("foldBtn").onclick =
  () => runAction("fold");

$("allInBtn").onclick =
  () => runAction("allin");

$("swapBtn").onclick =
  () => runAction("swap");

$("rulesBtn").onclick =
  () => $("rulesDialog").showModal();

$("closeRules").onclick =
  () => $("rulesDialog").close();


// ========================================
// 再読み込み時の復帰
// ========================================

async function init() {
  $("accessCode").value =
    sessionStorage.getItem(
      SESSION_KEYS.accessCode
    ) || "";

  const savedRoomCode =
    sessionStorage.getItem(
      SESSION_KEYS.roomCode
    );

  const savedToken =
    sessionStorage.getItem(
      SESSION_KEYS.playerToken
    );

  if (
    !savedRoomCode ||
    !savedToken ||
    !accessCode()
  ) {
    return;
  }

  roomCode = savedRoomCode;
  playerToken = savedToken;

  try {
    const result = await api(
      "/api/rooms/state",
      {
        roomCode,
        playerToken,
      }
    );

    setSnapshot(result.snapshot);

    startSocket();

    $("connection").textContent = "接続済み";

  } catch {
    clearRoomSession();

    roomCode = null;
    playerToken = null;
  }
}

init();
