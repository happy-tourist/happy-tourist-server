/**
 * Расширение встроенных таблиц Colyseus.
 *
 * Встроенная таблица colyseus_users используется модулем @colyseus/auth.
 * Мы добавляем свои поля: displayName, rating, gamesPlayed, gamesWon.
 *
 * ВАЖНО: встроенные маршруты /auth/register и /auth/login
 * заполняют только стандартные колонки. Поэтому все наши поля
 * имеют .default(...), иначе регистрация упадёт с NOT NULL.
 */
import { tables } from "@colyseus/database";
import { text, integer } from "drizzle-orm/sqlite-core";

export const users = tables.sqlite.users("colyseus_users", {
  displayName: text("display_name"),
  rating: integer("rating").notNull().default(1000),
  gamesPlayed: integer("games_played").notNull().default(0),
  gamesWon: integer("games_won").notNull().default(0),
});