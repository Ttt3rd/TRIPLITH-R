
import { DurableObject } from "cloudflare:workers";

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CARD_VALUES = [
  ...Array.from({ length: 10 }, (_, i) => String(-(i + 1))),
  ...Array.from({ length: 10 }, (_, i) => String(i + 1)),
  "0", "0", "0", "STAR",
];

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "GameError";
    this.status = status;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function randomInt(max) {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % max;
}

function randomString(
  length,
  chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
) {
  let result = "";

  for (let i = 0; i < length; i++) {
    result += chars[randomInt(chars.length)];
  }

  return result;
}

function makeRoomCode() {
  return randomString(6, ROOM_CODE_CHARS);
}

function makeDeck() {
  return CARD_VALUES.slice();
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  return cards;
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(String(token));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));

  if (left.length !== right.length || left.length === 0) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }

  return diff === 0;
}

function cleanName(value) {
  const name = String(value ?? "Player")
    .replace(/[<>\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 16);

  return name || "Player";
}

function makePlayer(id, name, isCpu = false, tokenHash = null) {
  return {
    id,
    name: cleanName(name),
    isCpu,
    tokenHash,
    score: 10000,
    hand: [],
    folded: false,
    allIn: false,
    contribution: 0,
    called: false,
    swapped: false,
    raises: 0,
    raiseContribution: 0,
  };
}

function currentActivePlayers(state) {
  return state.players.filter((player) => !player.folded);
}

function nextTurn(state, from = state.currentTurn) {
  const count = state.players.length;

  for (let step = 1; step <= count; step++) {
    const index = (from + step) % count;
    const player = state.players[index];

    if (player && !player.folded && !player.allIn) {
      return index;
    }
  }

  return from;
}

function evaluateHand(hand) {
  const numbers = hand.map((card) =>
    card === "STAR" ? null : Number(card)
  );

  let role = "";
  let bonus = 0;

  if (hand.every((card) => card === "0")) {
    role = "TRIPLITH";
    bonus = 1000;

  } else if (
    hand.every((card) => card === "STAR" || card === "0")
  ) {
    role = "SYMBOL";
    bonus = 400;

  } else {
    const values = numbers.filter(
      (value) => value !== null
    );

    if (
      values.some((value, index) =>
        values.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            Math.abs(value) === Math.abs(other)
        )
      )
    ) {
      role = "DOUBLES";
      bonus = 200;
    }
  }

  // STARは通常の積では1として扱う。
  const product = numbers.reduce(
    (total, value) => total * (value === null ? 1 : value),
    1
  );

  return {
    value: product + bonus,
    product,
    role,
    bonus,
  };
}

function appendLog(state, message) {
  state.log.push(message);

  if (state.log.length > 30) {
    state.log.splice(0, state.log.length - 30);
  }
}

function dealNewHand(state, firstTurn) {
  state.deck = shuffle(makeDeck());

  for (const player of state.players) {
    player.hand = [
      state.deck.pop(),
      state.deck.pop(),
      state.deck.pop(),
    ];

    player.folded = false;
    player.allIn = false;
    player.contribution = 0;
    player.called = false;
    player.swapped = false;
    player.raises = 0;
    player.raiseContribution = 0;
  }

  state.pot = 0;
  state.currentBet = 0;
  state.raisesTotal = 0;
  state.foldUsed = false;
  state.checkCount = 0;
  state.phase = "prebet";
  state.currentTurn = firstTurn % state.players.length;
  state.status = "playing";
}

function finishRound(state) {
  state.phase = "showdown";

  const active = currentActivePlayers(state);

  if (!active.length) {
    throw new GameError(
      "勝負できるプレイヤーがいません。",
      500
    );
  }

  const evaluated = active.map((player) => ({
    player,
    ...evaluateHand(player.hand),
  }));

  const bestValue = Math.max(
    ...evaluated.map((entry) => entry.value)
  );

  const winners = evaluated
    .filter((entry) => entry.value === bestValue)
    .map((entry) => entry.player);

  const allActiveTied =
    winners.length === active.length;

  const allIns = state.players.filter(
    (player) => player.allIn
  );

  // オールインがある場合、最も少ないオールイン額を
  // 共通の上限として扱い、超過分を元の持ち主へ返す。
  const cap = allIns.length
    ? Math.min(
        ...allIns.map((player) => player.contribution)
      )
    : Infinity;

  let eligiblePot = 0;

  for (const player of state.players) {
    const eligible = Math.min(
      player.contribution,
      cap
    );

    const refund = player.contribution - eligible;

    player.score += refund;
    eligiblePot += eligible;
  }

  if (allActiveTied) {
    // 同点時：
    // 通常拠出分は各自に返却する。
    // レイズ増額分とフォールド者の拠出分は
    // レイズしていない勝者で分配する。

    let returnedToPlayers = 0;

    for (const player of active) {
      const eligible = Math.min(
        player.contribution,
        cap
      );

      const raisedPart = Math.min(
        player.raiseContribution || 0,
        eligible
      );

      const personalReturn =
        eligible - raisedPart;

      player.score += personalReturn;
      returnedToPlayers += personalReturn;
    }

    const pool = Math.max(
      0,
      eligiblePot - returnedToPlayers
    );

    const nonRaisingWinners = winners.filter(
      (player) => (player.raises || 0) === 0
    );

    const recipients =
      nonRaisingWinners.length
        ? nonRaisingWinners
        : winners;

    if (pool > 0 && recipients.length > 0) {
      const share = Math.floor(
        pool / recipients.length
      );

      let remainder =
        pool - share * recipients.length;

      for (const player of recipients) {
        player.score +=
          share + (remainder > 0 ? 1 : 0);

        if (remainder > 0) remainder--;
      }
    }

  } else {
    const share = Math.floor(
      eligiblePot / winners.length
    );

    let remainder =
      eligiblePot - share * winners.length;

    for (const player of winners) {
      player.score +=
        share + (remainder > 0 ? 1 : 0);

      if (remainder > 0) remainder--;
    }
  }

  const resultHands = state.players.map((player) => {
    const value = evaluateHand(player.hand);

    return {
      id: player.id,
      name: player.name,
      hand: player.hand.slice(),
      folded: player.folded,
      value: value.value,
      product: value.product,
      role: value.role,
      winner: winners.some(
        (winner) => winner.id === player.id
      ),
    };
  });

  const winnerNames = winners.map(
    (player) => player.name
  );

  state.lastResult = {
    winners: winnerNames,
    pot: eligiblePot,
    allTied: allActiveTied,
    cappedByAllIn: allIns.length > 0,
    hands: resultHands,
  };

  appendLog(
    state,
    allActiveTied
      ? `同点：${winnerNames.join("・")}（賭け点を返却）`
      : `${winnerNames.join("・")} の勝利（${eligiblePot.toLocaleString("ja-JP")}点）`
  );

  state.players.forEach((player) => {
    player.contribution = 0;
    player.called = false;
    player.raiseContribution = 0;
  });

  state.pot = 0;
  state.currentBet = 0;

  const gameOver = state.players.some(
    (player) =>
      player.score <= 0 ||
      player.score > 20000
  );

  if (gameOver) {
    state.status = "finished";
    state.phase = "finished";
    appendLog(state, "ゲーム終了");
    return;
  }

  const nextFirstTurn =
    (state.currentTurn + 1) % state.players.length;

  dealNewHand(state, nextFirstTurn);

  appendLog(state, "次のラウンドを開始しました");
}

function settleIfReady(state) {
  const active = currentActivePlayers(state);

  if (active.length <= 1) {
    finishRound(state);
    return true;
  }

  if (
    state.phase === "prebet" &&
    state.checkCount >= active.length
  ) {
    finishRound(state);
    return true;
  }

  if (state.phase === "betting") {
    const allReady = active.every(
      (player) =>
        player.allIn ||
        (
          player.called &&
          player.contribution >= state.currentBet
        )
    );

    if (allReady) {
      finishRound(state);
      return true;
    }
  }

  return false;
}

function validateIndices(indices) {
  if (
    !Array.isArray(indices) ||
    indices.length < 1 ||
    indices.length > 3
  ) {
    throw new GameError(
      "交換するカードを1〜3枚選択してください。"
    );
  }

  const clean = indices.map(Number);

  if (
    new Set(clean).size !== clean.length ||
    clean.some(
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        index > 2
    )
  ) {
    throw new GameError(
      "カードの選択が不正です。"
    );
  }

  return clean;
}

function doAction(
  state,
  playerId,
  action,
  indices = [],
  amount = 0
) {
  const player = state.players.find(
    (entry) => entry.id === playerId
  );

  if (
    !player ||
    player.isCpu ||
    player.folded ||
    player.allIn ||
    state.players[state.currentTurn]?.id !== playerId
  ) {
    throw new GameError(
      "あなたの手番ではありません。",
      409
    );
  }

  if (state.phase === "prebet") {
    if (action === "check") {
      player.called = true;
      state.checkCount++;

      appendLog(
        state,
        `${player.name}：チェック`
      );

      state.currentTurn = nextTurn(state);

    } else if (action === "change") {
      const selected = validateIndices(indices);

      const oldCards = selected.map(
        (index) => player.hand[index]
      );

      state.deck.push(...oldCards);
      shuffle(state.deck);

      selected.forEach((index) => {
        player.hand[index] = state.deck.pop();
      });

      state.checkCount = 0;

      appendLog(
        state,
        `${player.name}：チェンジ（${selected.length}枚）`
      );

      state.currentTurn = nextTurn(state);

    } else if (action === "bet") {
      const betAmount = Number(amount);

      if (
        ![100, 200, 400, 800].includes(betAmount) ||
        player.score < betAmount
      ) {
        throw new GameError(
          "ベット額が不正、または点数が不足しています。"
        );
      }

      player.score -= betAmount;

      if (player.score === 0) {
        player.allIn = true;
      }

      player.contribution += betAmount;
      state.pot += betAmount;
      state.currentBet = betAmount;
      state.phase = "betting";
      state.checkCount = 0;

      state.players.forEach((entry) => {
        entry.called = entry.id === playerId;
      });

      appendLog(
        state,
        `${player.name}：${betAmount}点ベット`
      );

      state.currentTurn = nextTurn(state);

    } else {
      throw new GameError(
        "このフェーズではその行動はできません。"
      );
    }

  } else if (state.phase === "betting") {
    if (action === "swap") {
      if (player.swapped) {
        throw new GameError(
          "スワップは1人1回までです。"
        );
      }

      const selected = validateIndices(indices);

      selected.forEach((index) => {
        player.hand[index] = state.deck.pop();
      });

      player.swapped = true;

      appendLog(
        state,
        `${player.name}：スワップ（${selected.length}枚）`
      );

      // スワップは手番を終了せず、
      // 続けてコール等を選択できる。
      return;
    }

    if (action === "call") {
      const due =
        state.currentBet - player.contribution;

      if (due < 0 || player.score < due) {
        throw new GameError(
          "点数が足りません。オールインを選択してください。",
          409
        );
      }

      player.score -= due;

      if (player.score === 0) {
        player.allIn = true;
      }

      player.contribution += due;
      state.pot += due;
      player.called = true;

      appendLog(
        state,
        `${player.name}：コール`
      );

      state.currentTurn = nextTurn(state);

    } else if (action === "raise") {
      if (
        state.raisesTotal >= 8 ||
        player.raises >= 4
      ) {
        throw new GameError("レイズ上限です。");
      }

      const previousBet = state.currentBet;
      const newBet = previousBet * 2;

      // レイズ分だけを別に記録する。
      const raiseIncrement =
        newBet - previousBet;

      const due =
        newBet - player.contribution;

      if (player.score < due) {
        throw new GameError(
          "レイズする点数が不足しています。"
        );
      }

      player.score -= due;

      if (player.score === 0) {
        player.allIn = true;
      }

      player.contribution += due;
      player.raiseContribution += raiseIncrement;

      state.pot += due;
      state.currentBet = newBet;

      player.raises++;
      state.raisesTotal++;

      state.players.forEach((entry) => {
        entry.called = entry.id === playerId;
      });

      appendLog(
        state,
        `${player.name}：レイズ（${newBet}点）`
      );

      state.currentTurn = nextTurn(state);

    } else if (action === "fold") {
      if (
        state.foldUsed ||
        state.raisesTotal >= 4
      ) {
        throw new GameError(
          "現在はフォールドできません。"
        );
      }

      const penalty = Math.min(
        player.score,
        state.currentBet * 2
      );

      player.score -= penalty;
      player.contribution += penalty;
      state.pot += penalty;
      player.folded = true;
      state.foldUsed = true;

      appendLog(
        state,
        `${player.name}：フォールド`
      );

      state.currentTurn = nextTurn(state);

    } else if (action === "allin") {
      const allInAmount = player.score;

      if (allInAmount <= 0) {
        throw new GameError(
          "オールインできる残点数がありません。"
        );
      }

      player.score = 0;
      player.contribution += allInAmount;
      state.pot += allInAmount;
      player.allIn = true;
      player.called = true;

      appendLog(
        state,
        `${player.name}：オールイン`
      );

      state.currentTurn = nextTurn(state);

    } else {
      throw new GameError("不正な行動です。");
    }

  } else {
    throw new GameError(
      "現在は行動できません。",
      409
    );
  }

  settleIfReady(state);
}

function cpuAction(state, player) {
  if (state.phase === "prebet") {
    if (Math.random() < 0.12 && player.score >= 100) {
      player.score -= 100;

      if (player.score === 0) {
        player.allIn = true;
      }

      player.contribution += 100;
      state.pot += 100;
      state.currentBet = 100;
      state.phase = "betting";
      state.checkCount = 0;

      state.players.forEach((entry) => {
        entry.called = entry.id === player.id;
      });

      appendLog(
        state,
        `${player.name}：100点ベット`
      );

    } else {
      player.called = true;
      state.checkCount++;

      appendLog(
        state,
        `${player.name}：チェック`
      );
    }

  } else if (state.phase === "betting") {
    const due =
      state.currentBet - player.contribution;

    if (player.score < due) {
      const amount = player.score;

      player.score = 0;
      player.contribution += amount;
      state.pot += amount;
      player.allIn = true;
      player.called = true;

      appendLog(
        state,
        `${player.name}：オールイン`
      );

    } else {
      player.score -= due;

      if (player.score === 0) {
        player.allIn = true;
      }

      player.contribution += due;
      state.pot += due;
      player.called = true;

      appendLog(
        state,
        `${player.name}：コール`
      );
    }
  }

  state.currentTurn = nextTurn(state);
}

function runCpu(state) {
  for (
    let count = 0;
    count < 9 && state.status === "playing";
    count++
  ) {
    const player = state.players[state.currentTurn];

    if (
      !player ||
      !player.isCpu ||
      player.folded ||
      player.allIn
    ) {
      break;
    }

    cpuAction(state, player);

    if (settleIfReady(state)) {
      continue;
    }
  }
}

function makeSnapshot(state, viewerId) {
  const viewer = state.players.find(
    (player) => player.id === viewerId
  );

  if (!viewer) {
    throw new GameError(
      "このルームのプレイヤーではありません。",
      403
    );
  }

  const publicPlayer = (player) => ({
    id: player.id,
    name: player.name,
    isCpu: player.isCpu,
    score: player.score,
    folded: player.folded,
    allIn: player.allIn,
    called: player.called,
    swapped: player.swapped,
    raises: player.raises,
    contribution: player.contribution,
  });

  return {
    playerId: viewerId,

    room: {
      code: state.code,
      status: state.status,
      hostPlayerId: state.hostPlayerId,
      players: state.players.map(publicPlayer),
      phase: state.phase,
      currentTurn: state.currentTurn,
      currentBet: state.currentBet,
      pot: state.pot,
      raisesTotal: state.raisesTotal,
      foldUsed: state.foldUsed,
      log: state.log.slice(-12),
      lastResult: state.lastResult,
    },

    view: {
      hasStar: viewer.hand.includes("STAR"),

      // スターの位置だけ本人に送信する。
      // 手札の数字は引き続き送信しない。
      starIndex: viewer.hand.indexOf("STAR"),

      players: state.players.map((player) => ({
        ...publicPlayer(player),

        hand:
          player.id === viewerId
            ? []
            : player.hand.slice(),
      })),
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (
      url.pathname === "/health" &&
      request.method === "GET"
    ) {
      try {
        const room = env.ROOMS.getByName("health-check");
        const result = await room.getStatus();

        return json(
          {
            server: "TRIPLITH-R",
            ...result,
          },
          200,
          corsHeaders
        );

      } catch (error) {
        return json(
          {
            server: "TRIPLITH-R",
            status: "error",
            message: error.message,
          },
          500,
          corsHeaders
        );
      }
    }

    if (!url.pathname.startsWith("/api/rooms/")) {
      return json(
        {
          server: "TRIPLITH-R",
          message: "TRIPLITH-R Game Server",
        },
        200,
        corsHeaders
      );
    }

    if (!env.ACCESS_CODE) {
      return json(
        {
          error:
            "サーバー側のACCESS_CODEが未設定です。CloudflareのSecretsに設定してください。",
        },
        503,
        corsHeaders
      );
    }

    // WebSocket接続
    if (url.pathname === "/api/rooms/ws") {
      if (
        request.headers.get("Upgrade")?.toLowerCase() !==
        "websocket"
      ) {
        return json(
          { error: "WebSocket接続が必要です。" },
          426,
          corsHeaders
        );
      }

      const code = String(
        url.searchParams.get("code") || ""
      ).toUpperCase();

      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
        return json(
          { error: "ルームコードが不正です。" },
          400,
          corsHeaders
        );
      }

      const room = env.ROOMS.getByName(code);

      return room.fetch(
        "https://room.internal/ws",
        {
          headers: {
            Upgrade: "websocket",
          },
        }
      );
    }

    if (request.method !== "POST") {
      return json(
        { error: "POSTで送信してください。" },
        405,
        corsHeaders
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        { error: "リクエストの形式が不正です。" },
        400,
        corsHeaders
      );
    }

    if (!safeEqual(body.accessCode, env.ACCESS_CODE)) {
      return json(
        { error: "アクセスコードが違います。" },
        403,
        corsHeaders
      );
    }

    // ルーム作成
    if (url.pathname === "/api/rooms/create") {
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = makeRoomCode();
        const room = env.ROOMS.getByName(code);

        const response = await room.fetch(
          "https://room.internal/create",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              code,
              name: cleanName(body.name),
            }),
          }
        );

        if (response.status === 409) {
          continue;
        }

        return new Response(response.body, {
          status: response.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
          },
        });
      }

      return json(
        {
          error:
            "ルームコードを確保できませんでした。もう一度お試しください。",
        },
        503,
        corsHeaders
      );
    }

    const code = String(
      body.roomCode || ""
    ).toUpperCase();

    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      return json(
        {
          error: "ルームコードは6桁で入力してください。",
        },
        400,
        corsHeaders
      );
    }

    const room = env.ROOMS.getByName(code);

    const routes = {
      "/api/rooms/join": "/join",
      "/api/rooms/state": "/state",
      "/api/rooms/start": "/start",
      "/api/rooms/cpu": "/cpu",
      "/api/rooms/action": "/action",
      "/api/rooms/leave": "/leave",
    };

    const internalPath = routes[url.pathname];

    if (!internalPath) {
      return json(
        { error: "APIが見つかりません。" },
        404,
        corsHeaders
      );
    }

    const response = await room.fetch(
      `https://room.internal${internalPath}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    return new Response(response.body, {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.env = env;
    this.clients = new Map();
  }

  async getStatus() {
    const result = this.ctx.storage.sql
      .exec("SELECT 1 AS ok")
      .one();

    return {
      status: "ok",
      database: result.ok === 1,
    };
  }

  async readState() {
    return this.ctx.storage.get("state");
  }

  async mutate(mutator) {
    let updated;

    await this.ctx.storage.transaction(async () => {
      const state = await this.ctx.storage.get("state");

      if (!state) {
        throw new GameError(
          "ルームが見つかりません。",
          404
        );
      }

      mutator(state);

      await this.ctx.storage.put("state", state);
      updated = state;
    });

    await this.broadcast(updated);

    return updated;
  }

  async verifyPlayer(body) {
    const token = String(body.playerToken || "");

    if (token.length < 20) {
      throw new GameError(
        "プレイヤー認証がありません。",
        401
      );
    }

    const tokenHash = await hashToken(token);
    const state = await this.readState();

    if (!state) {
      throw new GameError(
        "ルームが見つかりません。",
        404
      );
    }

    const player = state.players.find(
      (entry) =>
        entry.tokenHash &&
        safeEqual(entry.tokenHash, tokenHash)
    );

    if (!player) {
      throw new GameError(
        "プレイヤー認証が無効です。",
        403
      );
    }

    return { state, player };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.handleWebSocket(request);
    }

    let body = {};

    try {
      body = await request.json();
    } catch {
      // ボディなし
    }

    try {
      // ルーム作成
      if (url.pathname === "/create") {
        const token = randomString(40);
        const tokenHash = await hashToken(token);
        const playerId = crypto.randomUUID();

        const state = {
          code: String(body.code || "").toUpperCase(),
          status: "waiting",
          hostPlayerId: playerId,

          players: [
            makePlayer(
              playerId,
              body.name,
              false,
              tokenHash
            ),
          ],

          deck: [],
          phase: "waiting",
          currentTurn: 0,
          currentBet: 0,
          pot: 0,
          raisesTotal: 0,
          foldUsed: false,
          checkCount: 0,
          log: ["ルームを作成しました"],
          lastResult: null,
          createdAt: Date.now(),
        };

        let conflict = false;

        await this.ctx.storage.transaction(async () => {
          if (await this.ctx.storage.get("state")) {
            conflict = true;
            return;
          }

          await this.ctx.storage.put("state", state);
        });

        if (conflict) {
          return json(
            { error: "ROOM_CODE_CONFLICT" },
            409
          );
        }

        return json({
          roomCode: state.code,
          playerToken: token,
          snapshot: makeSnapshot(state, playerId),
        });
      }

      // ルーム参加
      if (url.pathname === "/join") {
        const token = randomString(40);
        const tokenHash = await hashToken(token);
        const playerId = crypto.randomUUID();

        const state = await this.mutate((current) => {
          if (current.status !== "waiting") {
            throw new GameError(
              "このルームは開始済みです。",
              409
            );
          }

          if (current.players.length >= 3) {
            throw new GameError(
              "このルームは満席です。",
              409
            );
          }

          current.players.push(
            makePlayer(
              playerId,
              body.name,
              false,
              tokenHash
            )
          );

          appendLog(
            current,
            `${cleanName(body.name)} が参加しました`
          );
        });

        return json({
          roomCode: state.code,
          playerToken: token,
          snapshot: makeSnapshot(state, playerId),
        });
      }

      // 状態取得
      if (url.pathname === "/state") {
        const { state, player } =
          await this.verifyPlayer(body);

        return json({
          snapshot: makeSnapshot(state, player.id),
        });
      }

      // ゲーム開始
      if (url.pathname === "/start") {
        const { player } =
          await this.verifyPlayer(body);

        const state = await this.mutate((current) => {
          if (current.hostPlayerId !== player.id) {
            throw new GameError(
              "ホストのみゲームを開始できます。",
              403
            );
          }

          if (current.status !== "waiting") {
            throw new GameError(
              "すでにゲームが始まっています。",
              409
            );
          }

          if (current.players.length !== 3) {
            throw new GameError(
              "3人揃ってから開始してください。",
              409
            );
          }

          current.players.forEach((entry) => {
            entry.score = 10000;
            entry.folded = false;
            entry.allIn = false;
            entry.contribution = 0;
            entry.called = false;
            entry.swapped = false;
            entry.raises = 0;
            entry.raiseContribution = 0;
          });

          current.lastResult = null;

          dealNewHand(current, 0);

          appendLog(current, "ゲーム開始");

          runCpu(current);
        });

        return json({
          snapshot: makeSnapshot(state, player.id),
        });
      }

      // CPU追加
      if (url.pathname === "/cpu") {
        const { player } =
          await this.verifyPlayer(body);

        const state = await this.mutate((current) => {
          if (current.hostPlayerId !== player.id) {
            throw new GameError(
              "ホストのみCPUを追加できます。",
              403
            );
          }

          if (current.status !== "waiting") {
            throw new GameError(
              "ゲーム開始後はCPUを追加できません。",
              409
            );
          }

          if (current.players.length >= 3) {
            throw new GameError(
              "すでに満席です。",
              409
            );
          }

          const number =
            current.players.filter(
              (entry) => entry.isCpu
            ).length + 1;

          current.players.push(
            makePlayer(
              `CPU_${crypto.randomUUID()}`,
              `CPU ${number}`,
              true
            )
          );

          appendLog(
            current,
            `CPU ${number} を追加しました`
          );
        });

        return json({
          snapshot: makeSnapshot(state, player.id),
        });
      }

      // プレイヤーの行動
      if (url.pathname === "/action") {
        const { player } =
          await this.verifyPlayer(body);

        const state = await this.mutate((current) => {
          if (current.status !== "playing") {
            throw new GameError(
              "ゲーム中ではありません。",
              409
            );
          }

          doAction(
            current,
            player.id,
            String(body.action || ""),
            body.indices || [],
            Number(body.amount || 0)
          );

          runCpu(current);
        });

        return json({
          snapshot: makeSnapshot(state, player.id),
        });
      }

      // 退出
      if (url.pathname === "/leave") {
        const { player } =
          await this.verifyPlayer(body);

        const state = await this.mutate((current) => {
          if (current.status === "playing") {
            throw new GameError(
              "対戦中は退出できません。",
              409
            );
          }

          current.players = current.players.filter(
            (entry) => entry.id !== player.id
          );

          if (current.hostPlayerId === player.id) {
            current.hostPlayerId =
              current.players[0]?.id || null;
          }

          if (!current.players.length) {
            current.status = "closed";
          }

          appendLog(
            current,
            `${player.name} が退出しました`
          );
        });

        return json({
          ok: true,
          status: state.status,
        });
      }

      return json(
        { error: "APIが見つかりません。" },
        404
      );

    } catch (error) {
      const status =
        error instanceof GameError
          ? error.status
          : 500;

      return json(
        {
          error:
            error.message ||
            "サーバー内部でエラーが発生しました。",
        },
        status
      );
    }
  }

  async handleWebSocket(request) {
    if (
      request.headers.get("Upgrade")?.toLowerCase() !==
      "websocket"
    ) {
      return new Response(
        "Expected Upgrade: websocket",
        { status: 426 }
      );
    }

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    server.accept();

    server.addEventListener("message", (event) => {
      this.handleSocketMessage(
        server,
        event.data
      ).catch((error) => {
        try {
          server.send(
            JSON.stringify({
              type: "error",
              message: error.message,
            })
          );
        } catch {
          // 接続終了済み
        }
      });
    });

    server.addEventListener("close", () => {
      this.clients.delete(server);
    });

    server.addEventListener("error", () => {
      this.clients.delete(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSocketMessage(socket, raw) {
    let message;

    try {
      message = JSON.parse(String(raw));
    } catch {
      throw new GameError(
        "WebSocketメッセージが不正です。"
      );
    }

    if (!this.clients.has(socket)) {
      if (
        message.type !== "auth" ||
        !safeEqual(
          message.accessCode,
          this.env.ACCESS_CODE
        )
      ) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "アクセスコードが違います。",
          })
        );

        socket.close(1008, "Unauthorized");
        return;
      }

      const tokenHash = await hashToken(
        message.playerToken || ""
      );

      const state = await this.readState();

      const player = state?.players.find(
        (entry) =>
          entry.tokenHash &&
          safeEqual(entry.tokenHash, tokenHash)
      );

      if (!player) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "プレイヤー認証が無効です。",
          })
        );

        socket.close(1008, "Unauthorized");
        return;
      }

      this.clients.set(socket, player.id);

      socket.send(
        JSON.stringify({
          type: "state",
          data: makeSnapshot(state, player.id),
        })
      );

      return;
    }

    if (message.type === "ping") {
      socket.send(
        JSON.stringify({ type: "pong" })
      );
    }
  }

  async broadcast(state = null) {
    const current = state || await this.readState();

    if (!current) return;

    for (const [socket, playerId] of this.clients) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "state",
              data: makeSnapshot(current, playerId),
            })
          );
        } else {
          this.clients.delete(socket);
        }
      } catch {
        this.clients.delete(socket);
      }
    }
  }
}
