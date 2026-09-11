/**
 * Инициализация GameDatabase (SQLite через Drizzle ORM).
 *
 * connectionString читается из переменной окружения DATABASE_URL.
 * Локально: ./game.db
 * На сервере: /var/www/happy-tourist-server/game.db
 */
import { GameDatabase } from "@colyseus/database";
import { users } from "./schema.js";

export const db = new GameDatabase({
  connectionString: process.env.DATABASE_URL ?? "./game.db",
  schemas: { users },
});
