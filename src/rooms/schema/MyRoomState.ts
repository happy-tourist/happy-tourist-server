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
 */
export const Seat = schema(
  {
    touristId: t.uint8(), // 1…4
    pieces: t.map(Piece),
    connected: t.boolean().default(true),
    /** Unix ms deadline while offline in grace; `0` when online. */
    reconnectUntil: t.number().default(0),
  },
  "Seat",
);
export type Seat = SchemaType<typeof Seat>;

export const MyRoomState = schema(
  {
    started: t.boolean().default(false),
    seats: t.map(Seat), // key = sessionId
    /** sessionId of seated player whose turn it is; `""` if no seated. */
    currentTurnSessionId: t.string().default(""),
  },
  "MyRoomState",
);
export type MyRoomState = SchemaType<typeof MyRoomState>;
