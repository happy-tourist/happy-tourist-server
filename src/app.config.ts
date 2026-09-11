import {
  defineServer,
  defineRoom,
  LobbyRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
} from "colyseus";
import { auth } from "@colyseus/auth";
import { APIError } from "@colyseus/better-call";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "./db/index.js";
import { users } from "./db/schema.js";
import { MyRoom } from "./rooms/MyRoom.js";
// Side-effect: register OAuth providers (google) before listen
import "./config/auth.js";

const ALLOWED_ORIGIN =
  process.env.NODE_ENV === "production"
    ? "https://happy-tourist.github.io"
    : true; // в dev разрешаем любой origin

const themeBody = z.object({
  theme: z.enum(["light", "dark"]),
});

const server = defineServer({
  /**
   * Передаём database — этого достаточно, чтобы @colyseus/auth
   * автоматически подключил свои HTTP-маршруты и использовал
   * эту базу как user store.
   */
  database: db,

  rooms: {
    lobby: defineRoom(LobbyRoom),
    checkers: defineRoom(MyRoom).enableRealtimeListing(),
  },

  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async () => {
      return { message: "Hello World" };
    }),

    /**
     * Persist registered-user UI theme preference (SC-THEME-04 / SC-THEME-05).
     * Guest/anonymous and unauthenticated callers are rejected.
     */
    api_theme: createEndpoint(
      "/api/theme",
      {
        method: "POST",
        use: [auth.middleware()],
        body: themeBody,
      },
      async (ctx) => {
        const authUser = ctx.context.auth as {
          id?: string;
          anonymous?: boolean;
        };

        if (!authUser?.id || authUser.anonymous === true) {
          throw new APIError(403, { error: "registered_user_required" });
        }

        const { theme } = ctx.body;

        await db.drizzle
          .update(users)
          .set({ theme, updatedAt: new Date() })
          .where(eq(users.id, authUser.id));

        return { theme };
      }
    ),
  }),

  express: (app) => {
    /**
     * CORS — обязательно ПЕРВЫМ middleware.
     * Клиент на GitHub Pages и сервер на вашем домене — разные origin.
     */
    app.use((req, res, next) => {
      const origin =
        typeof ALLOWED_ORIGIN === "string"
          ? ALLOWED_ORIGIN
          : (req.headers.origin ?? "*");

      res.header("Access-Control-Allow-Origin", origin);
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization"
      );

      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });

    /**
     * Healthcheck — пригодится для проверки деплоя и мониторинга.
     */
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime() });
    });

    app.get("/hi", (_req, res) => {
      res.send("It's time to kick ass and chew bubblegum!");
    });

    /**
     * Monitor и Playground — только в dev.
     * В production они выключены, чтобы не светить внутренности.
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
      app.use("/", playground());
    }
  },
});

export default server;
