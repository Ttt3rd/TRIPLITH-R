// TRIPLITH-R Game Server
import { DurableObject } from "cloudflare:workers";

// 対戦ルームを管理するクラス
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  // SQLiteストレージへの接続確認
  async getStatus() {
    const result = this.ctx.storage.sql
      .exec("SELECT 1 AS ok")
      .one();

    return {
      status: "ok",
      database: result.ok === 1
    };
  }
}

// Worker本体
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 動作確認用API
    if (url.pathname === "/health") {
      try {
        const room = env.ROOMS.getByName("health-check");
        const result = await room.getStatus();

        return Response.json({
          server: "TRIPLITH-R",
          ...result
        });
      } catch (error) {
        return Response.json({
          server: "TRIPLITH-R",
          status: "error",
          message: error.message
        }, { status: 500 });
      }
    }

    return new Response(
      "TRIPLITH-R Game Server",
      { status: 200 }
    );
  }
};
