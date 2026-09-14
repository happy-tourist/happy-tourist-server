import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import { JWT } from "@colyseus/auth";

import appConfig from "../src/app.config.js";
import {
  RECONNECT_GRACE_SECONDS,
  type BoardSide,
} from "../src/rooms/MyRoom.js";

const SIDES: BoardSide[] = ["N", "E", "S", "W"];

const START_CELLS: Record<BoardSide, ReadonlyArray<{ row: number; col: number }>> = {
  N: [
    { row: 0, col: 3 },
    { row: 0, col: 4 },
    { row: 0, col: 5 },
    { row: 0, col: 6 },
  ],
  E: [
    { row: 3, col: 9 },
    { row: 4, col: 9 },
    { row: 5, col: 9 },
    { row: 6, col: 9 },
  ],
  S: [
    { row: 9, col: 3 },
    { row: 9, col: 4 },
    { row: 9, col: 5 },
    { row: 9, col: 6 },
  ],
  W: [
    { row: 3, col: 0 },
    { row: 4, col: 0 },
    { row: 5, col: 0 },
    { row: 6, col: 0 },
  ],
};

type PieceView = {
  side: string;
  row: number;
  col: number;
};

type SeatView = {
  touristId: number;
  connected?: boolean;
  reconnectUntil?: number;
  pieces: { forEach: (cb: (p: PieceView, key?: string) => void) => void; size?: number; get?: (k: string) => PieceView | undefined };
};

function seatBySession(state: any, sessionId: string): SeatView | undefined {
  return state.seats?.get(sessionId);
}

/** Unexpected drop without SDK auto-reconnect (tests control reconnect manually). */
async function unexpectedDrop(client: { reconnection: { enabled: boolean }; leave: (consented?: boolean) => Promise<number> }) {
  client.reconnection.enabled = false;
  await client.leave(false);
}

function assertOfflineGrace(seat: SeatView, nowMs: number) {
  assert.strictEqual(seat.connected, false);
  const until = seat.reconnectUntil ?? 0;
  assert.ok(until > nowMs, "reconnectUntil must be in the future");
  const delta = until - nowMs;
  const expected = RECONNECT_GRACE_SECONDS * 1000;
  assert.ok(
    Math.abs(delta - expected) < 3000,
    `reconnectUntil delta ${delta}ms should be ~${expected}ms`,
  );
}

function seatOf(client: { sessionId: string; state: any }): SeatView | undefined {
  return client.state.seats?.get(client.sessionId);
}

function listPieces(seat: SeatView): PieceView[] {
  const out: PieceView[] = [];
  seat.pieces?.forEach((p) => out.push(p));
  return out;
}

function allRoomPieces(state: any): PieceView[] {
  const out: PieceView[] = [];
  state.seats?.forEach((seat: SeatView) => {
    seat.pieces?.forEach((p) => out.push(p));
  });
  return out;
}

function assertFourPiecesOnSides(seat: SeatView) {
  const pieces = listPieces(seat);
  assert.strictEqual(pieces.length, 4, "seat must have exactly four pieces");
  const sides = pieces.map((p) => p.side).sort();
  assert.deepStrictEqual(sides, ["E", "N", "S", "W"]);
  for (const piece of pieces) {
    const allowed = START_CELLS[piece.side as BoardSide];
    assert.ok(
      allowed.some((c) => c.row === piece.row && c.col === piece.col),
      `piece side ${piece.side}: (${piece.row},${piece.col}) must be a start cell`,
    );
  }
}

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  async function authAs(id: number, username: string) {
    const token = await JWT.sign({ id, username });
    colyseus.sdk.auth.token = token;
  }

  async function connectSeat(room: any, id: number, username: string) {
    await authAs(id, username);
    return colyseus.connectTo(room);
  }

  it("connecting into a room with JWT", async () => {
    await authAs(1, "test");

    const room = await colyseus.createRoom("tourist", {});
    const client1 = await colyseus.connectTo(room);

    assert.strictEqual(client1.sessionId, room.clients[0].sessionId);
  });

  // SC-LOBBY-02: Room appears in listing
  it("SC-LOBBY-02: lobby client receives + when tourist room is created", async () => {
    const lobby = await colyseus.sdk.joinOrCreate("lobby", {
      filter: { name: "tourist" },
    });

    const added = lobby.waitForMessage("+", 5000);
    const room = await colyseus.createRoom("tourist", {});
    const [roomId, roomData] = await added;

    assert.strictEqual(roomId, room.roomId);
    assert.strictEqual(roomData.name, "tourist");
    assert.strictEqual(roomData.metadata?.status, "waiting");

    await lobby.leave();
  });

  // SC-LOBBY-03: Room leaves listing
  it("SC-LOBBY-03: lobby client receives - when tourist room is disposed", async () => {
    const lobby = await colyseus.sdk.joinOrCreate("lobby", {
      filter: { name: "tourist" },
    });

    const added = lobby.waitForMessage("+", 5000);
    const room = await colyseus.createRoom("tourist", {});
    const [roomId] = await added;
    assert.strictEqual(roomId, room.roomId);

    const removed = lobby.waitForMessage("-", 5000);
    await room.disconnect();
    const removedId = await removed;

    assert.strictEqual(removedId, room.roomId);

    await lobby.leave();
  });

  // SC-PIECE-01: First join receives four pieces on all sides
  it("SC-PIECE-01: first join receives four pieces on all sides", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const client = await connectSeat(room, 1, "p1");

    const seat = seatOf(client);
    assert.ok(seat, "seat must be synced for first joiner");
    assert.ok([1, 2, 3, 4].includes(seat.touristId));
    assertFourPiecesOnSides(seat);
    assert.strictEqual(client.state.started, false);
    assert.strictEqual(room.state.seats.size, 1);
  });

  // SC-PIECE-02: Tourist kinds stay unique among players
  it("SC-PIECE-02: tourist kinds stay unique among players", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");

    const s1 = seatOf(c1)!;
    const s2 = seatOf(c2)!;
    assert.notStrictEqual(s1.touristId, s2.touristId);
    assertFourPiecesOnSides(s1);
    assertFourPiecesOnSides(s2);

    const ids: number[] = [];
    room.state.seats.forEach((seat: SeatView) => ids.push(seat.touristId));
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  // SC-PIECE-03: Start cells lie on the assigned side and stay free
  it("SC-PIECE-03: start cells lie on the assigned side and stay free", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const clients = [];
    for (let i = 0; i < 4; i++) {
      clients.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }

    const cellKeys = new Set<string>();
    for (const client of clients) {
      const seat = seatOf(client)!;
      assertFourPiecesOnSides(seat);
      for (const piece of listPieces(seat)) {
        const key = `${piece.row},${piece.col}`;
        assert.ok(!cellKeys.has(key), `duplicate cell ${key}`);
        cellKeys.add(key);
      }
    }
    assert.strictEqual(cellKeys.size, 16);
  });

  // SC-PIECE-04: Second player uses remaining cells on each side
  it("SC-PIECE-04: second player uses remaining cells on each side", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");

    const s1 = seatOf(c1)!;
    const s2 = seatOf(c2)!;
    assertFourPiecesOnSides(s1);
    assertFourPiecesOnSides(s2);

    const occupied = new Set(
      listPieces(s1).map((p) => `${p.row},${p.col}`),
    );
    for (const piece of listPieces(s2)) {
      assert.ok(
        !occupied.has(`${piece.row},${piece.col}`),
        `second player cell (${piece.row},${piece.col}) must be free of first`,
      );
    }

    for (const side of SIDES) {
      const p1 = listPieces(s1).find((p) => p.side === side);
      const p2 = listPieces(s2).find((p) => p.side === side);
      assert.ok(p1 && p2, `both players must have a piece on side ${side}`);
      assert.notStrictEqual(
        `${p1!.row},${p1!.col}`,
        `${p2!.row},${p2!.col}`,
        `side ${side} cells must differ`,
      );
    }
  });

  // SC-PIECE-05: Fourth seated player starts the room
  it("SC-PIECE-05: fourth seated player starts the room", async () => {
    const room = await colyseus.createRoom("tourist", {});
    for (let i = 0; i < 3; i++) {
      await connectSeat(room, i + 1, `p${i + 1}`);
    }
    assert.strictEqual(room.state.started, false);

    const fourth = await connectSeat(room, 4, "p4");
    assertFourPiecesOnSides(seatOf(fourth)!);
    assert.strictEqual(room.state.started, true);
    assert.strictEqual(room.state.seats.size, 4);

    const late = await connectSeat(room, 5, "late");
    assert.strictEqual(seatOf(late), undefined);
  });

  // SC-PIECE-06: Fifth connection is a spectator
  it("SC-PIECE-06: fifth connection is a spectator", async () => {
    const room = await colyseus.createRoom("tourist", {});
    for (let i = 0; i < 4; i++) {
      await connectSeat(room, i + 1, `p${i + 1}`);
    }
    assert.strictEqual(room.state.started, true);
    assert.strictEqual(room.state.seats.size, 4);
    const piecesBefore = allRoomPieces(room.state).length;

    const spectator = await connectSeat(room, 5, "guest");
    assert.strictEqual(seatOf(spectator), undefined);
    assert.strictEqual(spectator.state.seats.get(spectator.sessionId), undefined);
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(room.state.started, true);
    assert.strictEqual(allRoomPieces(room.state).length, piecesBefore);
  });

  // SC-PIECE-07: Leave before start frees kind and cells (consented)
  it("SC-PIECE-07: leave before start frees kind and cells", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const first = await connectSeat(room, 1, "p1");
    const firstSeat = seatOf(first)!;
    assert.strictEqual(firstSeat.connected, true);
    assert.strictEqual(firstSeat.reconnectUntil ?? 0, 0);
    const freedId = firstSeat.touristId;
    const freedCells = new Set(
      listPieces(firstSeat).map((p) => `${p.row},${p.col}`),
    );

    // Keep the room alive while the seated player leaves.
    await connectSeat(room, 2, "holder");

    await first.leave(); // consented → immediate seat remove
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(first.sessionId), false);
    assert.strictEqual(room.state.started, false);

    // Fill remaining seats — freed kind/cells must be assignable again.
    const seenIds = new Set<number>();
    const seenCells = new Set<string>();
    room.state.seats.forEach((seat: SeatView) => {
      seenIds.add(seat.touristId);
      listPieces(seat).forEach((p) => seenCells.add(`${p.row},${p.col}`));
    });
    for (let i = 0; i < 3; i++) {
      const c = await connectSeat(room, 10 + i, `reseat${i}`);
      const s = seatOf(c)!;
      seenIds.add(s.touristId);
      listPieces(s).forEach((p) => seenCells.add(`${p.row},${p.col}`));
    }

    assert.ok(seenIds.has(freedId), `freed touristId ${freedId} must be reusable`);
    for (const cell of freedCells) {
      assert.ok(seenCells.has(cell), `freed cell ${cell} must be reusable`);
    }
  });

  // SC-PIECE-08: Leave after start does not reopen seating (consented)
  it("SC-PIECE-08: leave after start does not reopen seating", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const seated = [];
    for (let i = 0; i < 4; i++) {
      seated.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }
    assert.strictEqual(room.state.started, true);

    const leaving = seated[0]!;
    const leavingId = leaving.sessionId;
    const leavingPieces = listPieces(seatOf(leaving)!);
    assert.strictEqual(leavingPieces.length, 4);

    await leaving.leave(); // consented → immediate seat remove
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(leavingId), false);
    assert.strictEqual(room.state.seats.size, 3);
    assert.strictEqual(room.state.started, true);
    assert.strictEqual(allRoomPieces(room.state).length, 12);

    const late = await connectSeat(room, 99, "spectator");
    assert.strictEqual(seatOf(late), undefined);
    assert.strictEqual(room.state.seats.size, 3);
    assert.strictEqual(room.state.started, true);
  });

  // SC-PIECE-11: Unexpected disconnect before start holds the seat
  it("SC-PIECE-11: unexpected disconnect before start holds the seat", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const first = await connectSeat(room, 1, "p1");
    const observer = await connectSeat(room, 2, "observer");
    const sessionId = first.sessionId;
    const piecesBefore = listPieces(seatOf(first)!);
    assert.strictEqual(seatOf(first)!.connected, true);

    const now = Date.now();
    await unexpectedDrop(first);
    await room.waitForNextPatch();

    assert.ok(room.state.seats.has(sessionId), "seat must remain during grace");
    assert.strictEqual(room.state.seats.size, 2);
    assertFourPiecesOnSides(room.state.seats.get(sessionId));
    assert.strictEqual(listPieces(room.state.seats.get(sessionId)).length, piecesBefore.length);

    const held = seatBySession(observer.state, sessionId)!;
    assertOfflineGrace(held, now);
    assertOfflineGrace(room.state.seats.get(sessionId), now);
  });

  // SC-PIECE-12: Unexpected disconnect after start holds the seat
  it("SC-PIECE-12: unexpected disconnect after start holds the seat", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const seated = [];
    for (let i = 0; i < 4; i++) {
      seated.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }
    assert.strictEqual(room.state.started, true);

    const dropping = seated[0]!;
    const sessionId = dropping.sessionId;
    const now = Date.now();
    await unexpectedDrop(dropping);
    await room.waitForNextPatch();

    assert.ok(room.state.seats.has(sessionId));
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(room.state.started, true);
    assertFourPiecesOnSides(room.state.seats.get(sessionId));
    assertOfflineGrace(room.state.seats.get(sessionId), now);

    const late = await connectSeat(room, 99, "spectator");
    assert.strictEqual(seatOf(late), undefined);
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(room.state.started, true);
  });

  // SC-PIECE-13: Reconnect within grace restores the same seat
  it("SC-PIECE-13: reconnect within grace restores the same seat", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const first = await connectSeat(room, 1, "p1");
    const observer = await connectSeat(room, 2, "observer");
    const sessionId = first.sessionId;
    const touristId = seatOf(first)!.touristId;
    const token = first.reconnectionToken;

    await unexpectedDrop(first);
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.get(sessionId).connected, false);

    await authAs(1, "p1");
    const reconnected = await colyseus.sdk.reconnect(token);
    await room.waitForNextPatch();

    assert.strictEqual(reconnected.sessionId, sessionId);
    const seat = room.state.seats.get(sessionId);
    assert.ok(seat);
    assert.strictEqual(seat.touristId, touristId);
    assert.strictEqual(seat.connected, true);
    assert.strictEqual(seat.reconnectUntil, 0);
    assertFourPiecesOnSides(seat);

    const observed = seatBySession(observer.state, sessionId)!;
    assert.strictEqual(observed.connected, true);
    assert.strictEqual(observed.reconnectUntil ?? 0, 0);
  });

  // SC-PIECE-14: Grace timeout removes the seat
  it("SC-PIECE-14: grace timeout removes the seat", async function () {
    this.timeout(RECONNECT_GRACE_SECONDS * 1000 + 15000);

    const room = await colyseus.createRoom("tourist", {});
    const first = await connectSeat(room, 1, "p1");
    await connectSeat(room, 2, "holder");
    const sessionId = first.sessionId;
    const freedId = seatOf(first)!.touristId;
    const freedCells = new Set(
      listPieces(seatOf(first)!).map((p) => `${p.row},${p.col}`),
    );

    await unexpectedDrop(first);
    await room.waitForNextPatch();
    assert.ok(room.state.seats.has(sessionId));

    await new Promise((r) => setTimeout(r, RECONNECT_GRACE_SECONDS * 1000 + 1500));
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(sessionId), false);
    assert.strictEqual(room.state.started, false);

    // Freed kind/cells reusable before start.
    const seenIds = new Set<number>();
    const seenCells = new Set<string>();
    room.state.seats.forEach((seat: SeatView) => {
      seenIds.add(seat.touristId);
      listPieces(seat).forEach((p) => seenCells.add(`${p.row},${p.col}`));
    });
    for (let i = 0; i < 3; i++) {
      const c = await connectSeat(room, 20 + i, `after-timeout-${i}`);
      const s = seatOf(c)!;
      seenIds.add(s.touristId);
      listPieces(s).forEach((p) => seenCells.add(`${p.row},${p.col}`));
    }
    assert.ok(seenIds.has(freedId));
    for (const cell of freedCells) {
      assert.ok(seenCells.has(cell));
    }
  });

  // SC-PIECE-15: Last seated removal closes the room with spectators present
  it("SC-PIECE-15: last seated removal closes the room with spectators present", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const s1 = await connectSeat(room, 10, "a");
    const s2 = await connectSeat(room, 11, "b");
    const s3 = await connectSeat(room, 12, "c");
    const s4 = await connectSeat(room, 13, "d");
    assert.strictEqual(room.state.started, true);

    await s2.leave();
    await s3.leave();
    await s4.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.size, 1);

    const guest = await connectSeat(room, 14, "spectator");
    assert.strictEqual(seatOf(guest), undefined);
    assert.strictEqual(room.state.seats.size, 1);

    const leftPromise = new Promise<number>((resolve) => {
      guest.onLeave((code) => resolve(code));
    });
    await s1.leave(); // consented permanent leave of last seated
    await leftPromise;

    assert.strictEqual(room.state.seats.size, 0);
  });

  // SC-PIECE-16: Seat connectivity is synchronized
  it("SC-PIECE-16: seat connectivity is synchronized", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const first = await connectSeat(room, 1, "p1");
    const observer = await connectSeat(room, 2, "observer");
    const sessionId = first.sessionId;

    assert.strictEqual(seatBySession(observer.state, sessionId)!.connected, true);
    assert.strictEqual(seatBySession(observer.state, sessionId)!.reconnectUntil ?? 0, 0);

    const now = Date.now();
    const token = first.reconnectionToken;
    await unexpectedDrop(first);
    await room.waitForNextPatch();

    const offline = seatBySession(observer.state, sessionId)!;
    assertOfflineGrace(offline, now);

    await authAs(1, "p1");
    await colyseus.sdk.reconnect(token);
    await room.waitForNextPatch();

    const online = seatBySession(observer.state, sessionId)!;
    assert.strictEqual(online.connected, true);
    assert.strictEqual(online.reconnectUntil ?? 0, 0);
  });
});
