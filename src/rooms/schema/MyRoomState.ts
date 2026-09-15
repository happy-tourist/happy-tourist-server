import { schema, t, type SchemaType } from "@colyseus/schema";

/** One tourist token on a board side. */
export const Piece = schema(
  {
    side: t.string(), // "N"|"E"|"S"|"W"
    row: t.uint8(),
    col: t.uint8(),
  },
  "Piece",
);
export type Piece = SchemaType<typeof Piece>;

/**
 * Seated player: unique tourist kind + exactly four pieces (one per side).
 * Key of `pieces` map = side letter (N|E|S|W).
 * Connectivity: online by default; offline + reconnectUntil during grace.
 * `ready`: one-shot ready-to-start mark (game/start).
 */
export const Seat = schema(
  {
    touristId: t.uint8(), // 1…4
    pieces: t.map(Piece),
    connected: t.boolean().default(true),
    /** Unix ms deadline while offline in grace; `0` when online. */
    reconnectUntil: t.number().default(0),
    /** Ready-to-start while phase is waiting (underfilled table). */
    ready: t.boolean().default(false),
  },
  "Seat",
);
export type Seat = SchemaType<typeof Seat>;

/** Start phase: waiting → countdown → playing. */
export type StartPhase = "waiting" | "countdown" | "playing";

export const MyRoomState = schema(
  {
    /**
     * Legacy seating/start flag. Prefer `phase === "playing"`.
     * Kept for older clients/tests until fully migrated.
     */
    started: t.boolean().default(false),
    /** Synced start phase (`waiting` | `countdown` | `playing`). */
    phase: t.string().default("waiting"),
    /** Table capacity set at create: 2 | 3 | 4. */
    maxSeats: t.uint8().default(2),
    /** Authoritative countdown second (5…1); `0` when not in countdown. */
    countdownRemaining: t.uint8().default(0),
    seats: t.map(Seat), // key = sessionId
    /** sessionId of seated player whose turn it is; `""` if no seated. */
    currentTurnSessionId: t.string().default(""),
  },
  "MyRoomState",
);
export type MyRoomState = SchemaType<typeof MyRoomState>;
