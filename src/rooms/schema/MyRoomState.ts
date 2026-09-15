import { schema, t, type SchemaType } from "@colyseus/schema";

/** One tourist token on a board side. */
export const Piece = schema(
  {
    side: t.string(), // "N"|"E"|"S"|"W"
    row: t.uint8(),
    col: t.uint8(),
    /** True after landing on a center cell; off-board for occupancy. */
    finished: t.boolean().default(false),
  },
  "Piece",
);
export type Piece = SchemaType<typeof Piece>;

/**
 * Seated player: unique tourist kind + exactly four pieces (one per side).
 * Key of `pieces` map = side letter (N|E|S|W).
 * Connectivity: online by default; offline + reconnectUntil during grace.
 * `ready`: one-shot ready-to-start mark (game/start).
 * `finishPlace`: 0 = not finished; 1…n after all four pieces finished.
 * `timeExpired`: solo budget elapsed; moves rejected; seat stays.
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
    /** Finish place; `0` until all four pieces finished. */
    finishPlace: t.uint8().default(0),
    /** Solo turn budget elapsed; moves rejected until leave. */
    timeExpired: t.boolean().default(false),
  },
  "Seat",
);
export type Seat = SchemaType<typeof Seat>;

/** Start phase: waiting → countdown → playing. */
export type StartPhase = "waiting" | "countdown" | "playing";

export const MyRoomState = schema(
  {
    /**
     * Legacy flag: mirror of `phase === "playing"` (prefer reading `phase`).
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
    /** Next finish place to assign (starts at 1; increments on full finish). */
    nextFinishPlace: t.uint8().default(1),
    /** Unix ms turn deadline; `0` = no active turn timer. */
    turnUntil: t.number().default(0),
    /** Active turn budget in seconds (60 multi / 300 solo); `0` when none. */
    turnBudgetSeconds: t.uint16().default(0),
  },
  "MyRoomState",
);
export type MyRoomState = SchemaType<typeof MyRoomState>;
