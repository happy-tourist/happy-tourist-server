import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import { JWT } from "@colyseus/auth";

import appConfig from "../src/app.config.js";
import {
  COUNTDOWN_SECONDS,
  RECONNECT_GRACE_SECONDS,
  SAY_TTL_MS,
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
  finished?: boolean;
};

type SeatView = {
  touristId: number;
  connected?: boolean;
  reconnectUntil?: number;
  ready?: boolean;
  finishPlace?: number;
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

  /** Skip authoritative countdown so move tests can assert rules in isolation. */
  function forcePlaying(room: { state: any }) {
    room.state.phase = "playing";
    room.state.countdownRemaining = 0;
    room.state.started = true;
  }

  async function waitForPhase(
    room: { state: any; waitForNextPatch: () => Promise<unknown> },
    phase: string,
    timeoutMs = COUNTDOWN_SECONDS * 1000 + 3000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (room.state.phase !== phase) {
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for phase=${phase}, got ${room.state.phase}`,
        );
      }
      await Promise.race([
        room.waitForNextPatch().catch(() => undefined),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    }
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
    const room = await colyseus.createRoom("tourist", { maxSeats: 3 });
    const [roomId, roomData] = await added;

    assert.strictEqual(roomId, room.roomId);
    assert.strictEqual(roomData.name, "tourist");
    assert.strictEqual(roomData.metadata?.status, "waiting");
    assert.strictEqual(roomData.metadata?.maxSeats, 3);
    assert.strictEqual(roomData.metadata?.seats, 0);

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
    assert.strictEqual(client.state.phase, "waiting");
    assert.strictEqual(client.state.maxSeats, 2);
    assert.strictEqual(client.state.started, false);
    assert.strictEqual(room.state.seats.size, 1);
    assert.strictEqual(room.metadata?.seats, 1);
    assert.strictEqual(room.metadata?.maxSeats, 2);
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
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
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

  // SC-PIECE-05: Filling maxSeats seats; further joiners are spectators
  it("SC-PIECE-05: fourth seated player fills maxSeats table", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    for (let i = 0; i < 3; i++) {
      await connectSeat(room, i + 1, `p${i + 1}`);
    }
    assert.strictEqual(room.state.seats.size, 3);
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(room.metadata?.seats, 3);
    assert.strictEqual(room.metadata?.maxSeats, 4);

    const fourth = await connectSeat(room, 4, "p4");
    assertFourPiecesOnSides(seatOf(fourth)!);
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(room.state.seats.size, room.state.maxSeats);
    assert.strictEqual(room.metadata?.seats, 4);

    const late = await connectSeat(room, 5, "late");
    assert.strictEqual(seatOf(late), undefined);
    assert.strictEqual(room.state.seats.size, 4);
  });

  // SC-PIECE-06: Connection beyond maxSeats is a spectator
  it("SC-PIECE-06: fifth connection is a spectator", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    for (let i = 0; i < 4; i++) {
      await connectSeat(room, i + 1, `p${i + 1}`);
    }
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(room.state.seats.size, room.state.maxSeats);
    const piecesBefore = allRoomPieces(room.state).length;

    const spectator = await connectSeat(room, 5, "guest");
    assert.strictEqual(seatOf(spectator), undefined);
    assert.strictEqual(spectator.state.seats.get(spectator.sessionId), undefined);
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(allRoomPieces(room.state).length, piecesBefore);
  });

  // SC-PIECE-19: Mid-game join takes a free seat
  it("SC-PIECE-19: mid-game join takes a free seat", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    await connectSeat(room, 1, "p1");
    await connectSeat(room, 2, "p2");
    assert.strictEqual(room.state.seats.size, 2);

    forcePlaying(room);

    const late = await connectSeat(room, 3, "p3");
    const seat = seatOf(late);
    assert.ok(seat, "free seat must be assigned mid-game");
    assertFourPiecesOnSides(seat);
    assert.strictEqual(room.state.seats.size, 3);
    assert.strictEqual(room.metadata?.seats, 3);
  });

  // SC-PIECE-07: Leave before start frees kind and cells (consented)
  it("SC-PIECE-07: leave before start frees kind and cells", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
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
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(room.metadata?.seats, 1);

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

  // SC-PIECE-08: Leave after full table reopens seating while under maxSeats
  it("SC-PIECE-08: leave after full table reopens a free seat", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const seated = [];
    for (let i = 0; i < 4; i++) {
      seated.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }
    assert.strictEqual(room.state.seats.size, 4);

    const leaving = seated[0]!;
    const leavingId = leaving.sessionId;
    const leavingPieces = listPieces(seatOf(leaving)!);
    assert.strictEqual(leavingPieces.length, 4);

    await leaving.leave(); // consented → immediate seat remove
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(leavingId), false);
    assert.strictEqual(room.state.seats.size, 3);
    assert.strictEqual(room.metadata?.seats, 3);
    assert.strictEqual(allRoomPieces(room.state).length, 12);

    const late = await connectSeat(room, 99, "rejoin");
    assert.ok(seatOf(late), "free seat must reopen after leave");
    assertFourPiecesOnSides(seatOf(late)!);
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(room.metadata?.seats, 4);
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

  // SC-PIECE-12: Unexpected disconnect after seats full holds the seat
  it("SC-PIECE-12: unexpected disconnect after start holds the seat", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const seated = [];
    for (let i = 0; i < 4; i++) {
      seated.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }
    assert.strictEqual(room.state.seats.size, 4);

    const dropping = seated[0]!;
    const sessionId = dropping.sessionId;
    const now = Date.now();
    await unexpectedDrop(dropping);
    await room.waitForNextPatch();

    assert.ok(room.state.seats.has(sessionId));
    assert.strictEqual(room.state.seats.size, 4);
    assertFourPiecesOnSides(room.state.seats.get(sessionId));
    assertOfflineGrace(room.state.seats.get(sessionId), now);

    const late = await connectSeat(room, 99, "spectator");
    assert.strictEqual(seatOf(late), undefined);
    assert.strictEqual(room.state.seats.size, 4);
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

    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
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
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(room.metadata?.seats, 1);

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
    const room = await colyseus.createRoom("tourist", { maxSeats: 2 });
    const s1 = await connectSeat(room, 10, "a");
    const s2 = await connectSeat(room, 11, "b");
    assert.strictEqual(room.state.seats.size, 2);

    const guest = await connectSeat(room, 14, "spectator");
    assert.strictEqual(seatOf(guest), undefined);
    assert.strictEqual(room.state.seats.size, 2);

    await s2.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.size, 1);
    assert.strictEqual(seatOf(guest), undefined);

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

  function placePiece(
    room: { state: any },
    sessionId: string,
    side: BoardSide,
    row: number,
    col: number,
  ) {
    const piece = room.state.seats.get(sessionId).pieces.get(side);
    assert.ok(piece, `piece ${side} must exist`);
    piece.row = row;
    piece.col = col;
  }

  function markPieceFinished(
    room: { state: any },
    sessionId: string,
    side: BoardSide,
  ) {
    const piece = room.state.seats.get(sessionId).pieces.get(side);
    assert.ok(piece, `piece ${side} must exist`);
    piece.finished = true;
  }

  function setSeatFinished(
    room: { state: any },
    sessionId: string,
    place: number,
  ) {
    const seat = room.state.seats.get(sessionId);
    assert.ok(seat);
    for (const side of SIDES) {
      markPieceFinished(room, sessionId, side);
    }
    seat.finishPlace = place;
    if (place >= room.state.nextFinishPlace) {
      room.state.nextFinishPlace = place + 1;
    }
  }

  function snapshotPieces(state: any): Array<{ side: string; row: number; col: number; sessionId: string; finished?: boolean }> {
    const out: Array<{ side: string; row: number; col: number; sessionId: string; finished?: boolean }> = [];
    state.seats.forEach((seat: SeatView, sessionId: string) => {
      listPieces(seat).forEach((p) => {
        out.push({
          sessionId,
          side: p.side,
          row: p.row,
          col: p.col,
          finished: p.finished,
        });
      });
    });
    return out;
  }

  // SC-MOVE-01: First seated player holds the turn
  it("SC-MOVE-01: first seated player holds the turn", async () => {
    const room = await colyseus.createRoom("tourist", {});
    assert.strictEqual(room.state.currentTurnSessionId, "");

    const first = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();

    assert.strictEqual(room.state.currentTurnSessionId, first.sessionId);
    assert.strictEqual(first.state.currentTurnSessionId, first.sessionId);

    const second = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, first.sessionId);
    assert.strictEqual(second.state.currentTurnSessionId, first.sessionId);
  });

  // SC-MOVE-02: Join order defines the rotation
  it("SC-MOVE-02: join order defines the rotation", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    forcePlaying(room);
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);
    placePiece(room, c2.sessionId, "N", 0, 5);
    placePiece(room, c2.sessionId, "E", 5, 9);
    placePiece(room, c2.sessionId, "S", 9, 5);
    placePiece(room, c2.sessionId, "W", 5, 0);

    c1.send("move", { side: "N", row: 3, col: 4 });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c2.sessionId);
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").row,
      3,
    );
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").col,
      4,
    );

    placePiece(room, c2.sessionId, "N", 2, 3);
    c2.send("move", { side: "N", row: 2, col: 4 });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);
  });

  // SC-MOVE-03: Solo seated player keeps the turn after moving
  it("SC-MOVE-03: solo seated player keeps the turn after moving", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const solo = await connectSeat(room, 1, "solo");
    await room.waitForNextPatch();
    forcePlaying(room);
    assert.strictEqual(room.state.currentTurnSessionId, solo.sessionId);

    placePiece(room, solo.sessionId, "N", 3, 3);
    placePiece(room, solo.sessionId, "E", 0, 4);
    placePiece(room, solo.sessionId, "S", 9, 4);
    placePiece(room, solo.sessionId, "W", 4, 0);

    solo.send("move", { side: "N", row: 3, col: 4 });
    await room.waitForNextPatch();

    assert.strictEqual(room.state.currentTurnSessionId, solo.sessionId);
    assert.strictEqual(
      room.state.seats.get(solo.sessionId).pieces.get("N").col,
      4,
    );
  });

  // SC-MOVE-16: Permanent leave advances the turn
  it("SC-MOVE-16: permanent leave advances the turn", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);

    await c1.leave();
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(c1.sessionId), false);
    assert.strictEqual(room.state.currentTurnSessionId, c2.sessionId);
  });

  // SC-MOVE-17: Offline grace keeps the turn waiting
  it("SC-MOVE-17: offline grace keeps the turn waiting", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);

    await unexpectedDrop(c1);
    await room.waitForNextPatch();

    assert.ok(room.state.seats.has(c1.sessionId));
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);
    assert.notStrictEqual(room.state.currentTurnSessionId, c2.sessionId);
  });

  // SC-MOVE-04: Legal orthogonal step updates position and turn
  it("SC-MOVE-04: legal orthogonal step updates position and turn", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    forcePlaying(room);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);
    placePiece(room, c2.sessionId, "N", 0, 5);
    placePiece(room, c2.sessionId, "E", 5, 9);
    placePiece(room, c2.sessionId, "S", 9, 5);
    placePiece(room, c2.sessionId, "W", 5, 0);

    c1.send("move", { side: "N", row: 3, col: 4 });
    await room.waitForNextPatch();

    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").row,
      3,
    );
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").col,
      4,
    );
    assert.strictEqual(room.state.currentTurnSessionId, c2.sessionId);
    assert.strictEqual(
      c2.state.seats.get(c1.sessionId).pieces.get("N").col,
      4,
    );
  });

  // SC-MOVE-05: Diagonal step is allowed
  it("SC-MOVE-05: diagonal step is allowed", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    c1.send("move", { side: "N", row: 4, col: 4 });
    await room.waitForNextPatch();

    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").row,
      4,
    );
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").col,
      4,
    );
  });

  // SC-MOVE-06: Occupied cell is rejected
  it("SC-MOVE-06: occupied cell is rejected", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 3, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    const before = snapshotPieces(room.state);
    const turnBefore = room.state.currentTurnSessionId;

    c1.send("move", { side: "N", row: 3, col: 4 });
    await new Promise((r) => setTimeout(r, 50));
    await room.waitForNextPatch().catch(() => undefined);

    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.currentTurnSessionId, turnBefore);
  });

  // SC-MOVE-07: Non-playable cell is rejected
  it("SC-MOVE-07: non-playable cell is rejected", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);

    placePiece(room, c1.sessionId, "N", 0, 3);
    placePiece(room, c1.sessionId, "E", 3, 9);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    const before = snapshotPieces(room.state);
    const turnBefore = room.state.currentTurnSessionId;

    c1.send("move", { side: "N", row: 0, col: 2 });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.currentTurnSessionId, turnBefore);
  });

  // SC-MOVE-08: Start and center cells are walkable
  it("SC-MOVE-08: start and center cells are walkable", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);

    // Onto start: from task (1,3) → start (0,3)
    placePiece(room, c1.sessionId, "N", 1, 3);
    placePiece(room, c1.sessionId, "E", 3, 9);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    c1.send("move", { side: "N", row: 0, col: 3 });
    await room.waitForNextPatch();
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").row,
      0,
    );
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").col,
      3,
    );
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").finished,
      false,
    );

    // Solo keeps turn — onto center: (3,3) → (4,4) finishes the piece
    placePiece(room, c1.sessionId, "N", 3, 3);
    c1.send("move", { side: "N", row: 4, col: 4 });
    await room.waitForNextPatch();
    const finishedN = room.state.seats.get(c1.sessionId).pieces.get("N");
    assert.strictEqual(finishedN.finished, true);
    assert.strictEqual(finishedN.row, 4);
    assert.strictEqual(finishedN.col, 4);
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);
  });

  // SC-FINISH-01: Move onto a center cell finishes the piece
  it("SC-FINISH-01: move onto a center cell finishes the piece", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);
    assert.strictEqual(room.state.nextFinishPlace, 1);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    c1.send("move", { side: "N", row: 4, col: 4 });
    await room.waitForNextPatch();

    const piece = room.state.seats.get(c1.sessionId).pieces.get("N");
    assert.strictEqual(piece.finished, true);
    assert.strictEqual(room.state.seats.get(c1.sessionId).finishPlace, 0);
  });

  // SC-FINISH-02: Another piece may reuse the same center cell
  it("SC-FINISH-02: another piece may reuse the same center cell", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 3, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    c1.send("move", { side: "N", row: 4, col: 4 });
    await room.waitForNextPatch();
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").finished,
      true,
    );

    // Same center cell free for another unfinished piece
    placePiece(room, c1.sessionId, "E", 3, 4);
    c1.send("move", { side: "E", row: 4, col: 4 });
    await room.waitForNextPatch();

    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").finished,
      true,
    );
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("E").finished,
      true,
    );
  });

  // SC-FINISH-03: First full finisher gets place one
  it("SC-FINISH-03: first full finisher gets place one", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);

    markPieceFinished(room, c1.sessionId, "E");
    markPieceFinished(room, c1.sessionId, "S");
    markPieceFinished(room, c1.sessionId, "W");
    placePiece(room, c1.sessionId, "N", 3, 3);

    c1.send("move", { side: "N", row: 4, col: 4 });
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.get(c1.sessionId).finishPlace, 1);
    assert.strictEqual(room.state.nextFinishPlace, 2);
    assert.strictEqual(room.state.seats.has(c1.sessionId), true);
    assert.strictEqual(room.state.currentTurnSessionId, "");
  });

  // SC-FINISH-04: Later full finisher gets the next place
  it("SC-FINISH-04: later full finisher gets the next place", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    forcePlaying(room);

    setSeatFinished(room, c1.sessionId, 1);
    room.state.currentTurnSessionId = c2.sessionId;

    markPieceFinished(room, c2.sessionId, "E");
    markPieceFinished(room, c2.sessionId, "S");
    markPieceFinished(room, c2.sessionId, "W");
    placePiece(room, c2.sessionId, "N", 3, 4);

    c2.send("move", { side: "N", row: 4, col: 4 });
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.get(c1.sessionId).finishPlace, 1);
    assert.strictEqual(room.state.seats.get(c2.sessionId).finishPlace, 2);
    assert.strictEqual(room.state.nextFinishPlace, 3);
  });

  // SC-MOVE-21: Finished seats are skipped in turn rotation
  it("SC-MOVE-21: finished seats are skipped in turn rotation", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const a = await connectSeat(room, 1, "a");
    const b = await connectSeat(room, 2, "b");
    await room.waitForNextPatch();
    forcePlaying(room);

    setSeatFinished(room, a.sessionId, 1);
    room.state.currentTurnSessionId = b.sessionId;

    placePiece(room, b.sessionId, "N", 3, 3);
    placePiece(room, b.sessionId, "E", 0, 5);
    placePiece(room, b.sessionId, "S", 9, 5);
    placePiece(room, b.sessionId, "W", 5, 0);

    b.send("move", { side: "N", row: 3, col: 4 });
    await room.waitForNextPatch();

    assert.strictEqual(room.state.currentTurnSessionId, b.sessionId);
  });

  // SC-MOVE-22: Finished offline seat does not hold the turn
  it("SC-MOVE-22: finished offline seat does not hold the turn", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const a = await connectSeat(room, 1, "a");
    const b = await connectSeat(room, 2, "b");
    const c = await connectSeat(room, 3, "c");
    await room.waitForNextPatch();
    forcePlaying(room);

    setSeatFinished(room, a.sessionId, 1);
    room.state.currentTurnSessionId = b.sessionId;

    await unexpectedDrop(a);
    await room.waitForNextPatch();
    assert.ok(room.state.seats.has(a.sessionId));
    assert.strictEqual(room.state.seats.get(a.sessionId).connected, false);

    placePiece(room, b.sessionId, "N", 3, 3);
    placePiece(room, b.sessionId, "E", 0, 5);
    placePiece(room, b.sessionId, "S", 9, 5);
    placePiece(room, b.sessionId, "W", 5, 0);
    placePiece(room, c.sessionId, "N", 0, 4);
    placePiece(room, c.sessionId, "E", 4, 9);
    placePiece(room, c.sessionId, "S", 9, 4);
    placePiece(room, c.sessionId, "W", 4, 0);

    b.send("move", { side: "N", row: 3, col: 4 });
    await room.waitForNextPatch();

    // Join order A(finished offline) → B → C; after B moves, skip A → C
    assert.strictEqual(room.state.currentTurnSessionId, c.sessionId);
  });

  // SC-MOVE-23 / SC-FINISH-06: Finished seat cannot move
  it("SC-MOVE-23 / SC-FINISH-06: finished seat cannot move", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();
    forcePlaying(room);

    setSeatFinished(room, c1.sessionId, 1);
    room.state.currentTurnSessionId = c1.sessionId;

    placePiece(room, c1.sessionId, "N", 3, 3);
    const before = snapshotPieces(room.state);
    const turnBefore = room.state.currentTurnSessionId;

    c1.send("move", { side: "N", row: 3, col: 4 });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.currentTurnSessionId, turnBefore);
  });

  // SC-FINISH-07: Finished seat blocks mid-game seating until leave
  it("SC-FINISH-07: finished seat blocks mid-game seating until leave", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 2 });
    const a = await connectSeat(room, 1, "a");
    const b = await connectSeat(room, 2, "b");
    await room.waitForNextPatch();
    forcePlaying(room);

    setSeatFinished(room, a.sessionId, 1);
    setSeatFinished(room, b.sessionId, 2);
    assert.strictEqual(room.state.seats.size, 2);

    const guest = await connectSeat(room, 3, "guest");
    assert.strictEqual(seatOf(guest), undefined);
    assert.strictEqual(room.state.seats.size, 2);

    await a.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.size, 1);

    const late = await connectSeat(room, 4, "late");
    assert.ok(seatOf(late), "free seat after finished leave");
    assertFourPiecesOnSides(seatOf(late)!);
    assert.strictEqual(room.state.seats.size, 2);
    // Remaining seat B is finished → current was ""; late must receive turn.
    assert.strictEqual(room.state.currentTurnSessionId, late.sessionId);
  });

  // SC-FINISH-08: Dispose only when no seats remain
  it("SC-FINISH-08: dispose only when no seats remain", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 2 });
    const a = await connectSeat(room, 1, "a");
    const b = await connectSeat(room, 2, "b");
    await room.waitForNextPatch();
    forcePlaying(room);
    setSeatFinished(room, a.sessionId, 1);
    setSeatFinished(room, b.sessionId, 2);

    const guest = await connectSeat(room, 3, "spectator");
    assert.strictEqual(seatOf(guest), undefined);

    await b.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.size, 1);
    assert.strictEqual(room.state.seats.get(a.sessionId).finishPlace, 1);

    const leftPromise = new Promise<number>((resolve) => {
      guest.onLeave((code) => resolve(code));
    });
    await a.leave();
    await leftPromise;
    assert.strictEqual(room.state.seats.size, 0);
  });

  // SC-FINISH-11: Finished disconnect keeps seat for grace
  it("SC-FINISH-11: finished disconnect keeps seat for grace", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const finished = await connectSeat(room, 1, "fin");
    await connectSeat(room, 2, "holder");
    await room.waitForNextPatch();
    forcePlaying(room);

    setSeatFinished(room, finished.sessionId, 1);
    const sessionId = finished.sessionId;
    const place = room.state.seats.get(sessionId).finishPlace;
    const touristId = room.state.seats.get(sessionId).touristId;

    const now = Date.now();
    await unexpectedDrop(finished);
    await room.waitForNextPatch();

    assert.ok(room.state.seats.has(sessionId));
    assertOfflineGrace(room.state.seats.get(sessionId), now);
    assert.strictEqual(room.state.seats.get(sessionId).finishPlace, place);
    assert.strictEqual(room.state.seats.get(sessionId).touristId, touristId);
  });

  // SC-PIECE-21: Finished seats counted in occupancy
  it("SC-PIECE-21: finished seats counted in occupancy", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 3 });
    const a = await connectSeat(room, 1, "a");
    const b = await connectSeat(room, 2, "b");
    const c = await connectSeat(room, 3, "c");
    await room.waitForNextPatch();
    forcePlaying(room);

    setSeatFinished(room, a.sessionId, 1);
    setSeatFinished(room, b.sessionId, 2);
    assert.strictEqual(room.state.seats.size, 3);

    const guest = await connectSeat(room, 4, "guest");
    assert.strictEqual(seatOf(guest), undefined);

    await a.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.size, 2);

    const late = await connectSeat(room, 5, "late");
    assert.ok(seatOf(late));
    assertFourPiecesOnSides(seatOf(late)!);
    assert.strictEqual(room.state.seats.size, 3);
    // keep c non-finished so room stays valid
    assert.strictEqual(room.state.seats.get(c.sessionId).finishPlace, 0);
  });

  // SC-MOVE-09: Move out of turn is rejected
  it("SC-MOVE-09: move out of turn is rejected", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);

    placePiece(room, c2.sessionId, "N", 3, 3);
    placePiece(room, c2.sessionId, "E", 0, 5);
    placePiece(room, c2.sessionId, "S", 9, 5);
    placePiece(room, c2.sessionId, "W", 5, 0);

    const before = snapshotPieces(room.state);
    c2.send("move", { side: "N", row: 3, col: 4 });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);
  });

  // SC-MOVE-10: Spectator cannot move
  it("SC-MOVE-10: spectator cannot move", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    for (let i = 0; i < 4; i++) {
      await connectSeat(room, i + 1, `p${i + 1}`);
    }
    const spectator = await connectSeat(room, 5, "guest");
    await room.waitForNextPatch();
    assert.strictEqual(seatOf(spectator), undefined);

    const before = snapshotPieces(room.state);
    const turnBefore = room.state.currentTurnSessionId;

    spectator.send("move", { side: "N", row: 3, col: 4 });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.currentTurnSessionId, turnBefore);
  });

  // --- game/say (SC-SAY-01…06, SC-SAY-10) ---

  type SayEvent = { sessionId: string; presetId: string; at: number };

  function assertSayEvent(ev: SayEvent, sessionId: string, presetId: string) {
    assert.strictEqual(ev.sessionId, sessionId);
    assert.strictEqual(ev.presetId, presetId);
    assert.ok(typeof ev.at === "number" && ev.at > 0);
  }

  // SC-SAY-01: Known preset is accepted
  it("SC-SAY-01: known preset is accepted and broadcast", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const sender = await connectSeat(room, 1, "sayer");
    const observer = await connectSeat(room, 2, "observer");
    await room.waitForNextPatch();

    const gotSender = sender.waitForMessage("say", 2000);
    const gotObserver = observer.waitForMessage("say", 2000);
    sender.send("say", { presetId: "hello" });

    const evSender = (await gotSender) as SayEvent;
    const evObserver = (await gotObserver) as SayEvent;
    assertSayEvent(evSender, sender.sessionId, "hello");
    assertSayEvent(evObserver, sender.sessionId, "hello");
    assert.strictEqual(evSender.at, evObserver.at);
  });

  // SC-SAY-02: Non-whitelist payload is rejected
  it("SC-SAY-02: non-whitelist payload is rejected without broadcast", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const sender = await connectSeat(room, 1, "sayer");
    const observer = await connectSeat(room, 2, "observer");
    await room.waitForNextPatch();

    let observerSaw = false;
    observer.onMessage("say", () => {
      observerSaw = true;
    });

    sender.send("say", { presetId: "unknown" });
    sender.send("say", { text: "Всем привет" });
    sender.send("say", { presetId: 123 });
    sender.send("say", "hello");
    await new Promise((r) => setTimeout(r, 80));

    assert.strictEqual(observerSaw, false);
  });

  // SC-SAY-03: Seated connected player may say off-turn
  it("SC-SAY-03: seated connected player may say off-turn", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);
    assert.notStrictEqual(room.state.currentTurnSessionId, c2.sessionId);

    const got = c1.waitForMessage("say", 2000);
    c2.send("say", { presetId: "luck" });
    const ev = (await got) as SayEvent;
    assertSayEvent(ev, c2.sessionId, "luck");
  });

  // SC-SAY-04: Spectator cannot say
  it("SC-SAY-04: spectator cannot say", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const seated: Awaited<ReturnType<typeof connectSeat>>[] = [];
    for (let i = 0; i < 4; i++) {
      seated.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }
    const spectator = await connectSeat(room, 5, "guest");
    await room.waitForNextPatch();
    assert.strictEqual(seatOf(spectator), undefined);

    let seatedSaw = false;
    seated[0]!.onMessage("say", () => {
      seatedSaw = true;
    });

    spectator.send("say", { presetId: "hello" });
    await new Promise((r) => setTimeout(r, 80));

    assert.strictEqual(seatedSaw, false);
  });

  // SC-SAY-05: Offline grace seat cannot say
  it("SC-SAY-05: offline grace seat cannot say", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const sender = await connectSeat(room, 1, "sayer");
    const observer = await connectSeat(room, 2, "observer");
    await room.waitForNextPatch();

    const seat = room.state.seats.get(sender.sessionId);
    assert.ok(seat);
    seat.connected = false;
    seat.reconnectUntil = Date.now() + RECONNECT_GRACE_SECONDS * 1000;
    await room.waitForNextPatch();

    let observerSaw = false;
    observer.onMessage("say", () => {
      observerSaw = true;
    });

    sender.send("say", { presetId: "hello" });
    await new Promise((r) => setTimeout(r, 80));

    assert.strictEqual(observerSaw, false);
  });

  // SC-SAY-06: Spectators see seated player say
  it("SC-SAY-06: spectators see seated player say", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const seatedClients: Awaited<ReturnType<typeof connectSeat>>[] = [];
    for (let i = 0; i < 4; i++) {
      seatedClients.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }
    const spectator = await connectSeat(room, 5, "guest");
    await room.waitForNextPatch();
    assert.strictEqual(seatOf(spectator), undefined);

    const sender = seatedClients[0]!;
    const otherSeated = seatedClients[1]!;

    const gotSpectator = spectator.waitForMessage("say", 2000);
    const gotSeated = otherSeated.waitForMessage("say", 2000);
    sender.send("say", { presetId: "luck" });

    const evSpectator = (await gotSpectator) as SayEvent;
    const evSeated = (await gotSeated) as SayEvent;
    assertSayEvent(evSpectator, sender.sessionId, "luck");
    assertSayEvent(evSeated, sender.sessionId, "luck");
    assert.strictEqual(evSpectator.at, evSeated.at);
  });

  // SC-SAY-10: Fourth concurrent say is rejected; after TTL may send again
  it("SC-SAY-10: fourth concurrent say is rejected; after TTL may send again", async function () {
    this.timeout(SAY_TTL_MS + 5000);

    const room = await colyseus.createRoom("tourist", {});
    const sender = await connectSeat(room, 1, "sayer");
    const observer = await connectSeat(room, 2, "observer");
    await room.waitForNextPatch();

    const received: SayEvent[] = [];
    observer.onMessage("say", (msg: SayEvent) => {
      received.push(msg);
    });

    sender.send("say", { presetId: "hello" });
    sender.send("say", { presetId: "luck" });
    sender.send("say", { presetId: "hello" });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(received.length, 3);

    sender.send("say", { presetId: "luck" });
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(received.length, 3, "fourth concurrent say must be rejected");

    await new Promise((r) => setTimeout(r, SAY_TTL_MS + 200));

    const gotAgain = observer.waitForMessage("say", 2000);
    sender.send("say", { presetId: "hello" });
    const ev = (await gotAgain) as SayEvent;
    assertSayEvent(ev, sender.sessionId, "hello");
  });

  // --- game/start (SC-START-01…07, 11/12) + SC-MOVE-18/19 + SC-SAY-13 ---

  // SC-START-01: New room is waiting; moves rejected
  it("SC-START-01: new room is waiting and moves are rejected", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 3 });
    const c1 = await connectSeat(room, 1, "p1");
    await room.waitForNextPatch();

    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(c1.state.phase, "waiting");

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    const before = snapshotPieces(room.state);
    c1.send("move", { side: "N", row: 3, col: 4 });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.phase, "waiting");
  });

  // SC-START-02 / SC-START-03: Full table countdown → playing unlocks moves
  it("SC-START-03: full table starts countdown then playing unlocks moves", async function () {
    this.timeout(COUNTDOWN_SECONDS * 1000 + 10000);

    const room = await colyseus.createRoom("tourist", { maxSeats: 3 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "waiting");

    const c3 = await connectSeat(room, 3, "p3");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "countdown");
    assert.strictEqual(room.state.countdownRemaining, COUNTDOWN_SECONDS);
    assert.strictEqual(c1.state.phase, "countdown");
    assert.strictEqual(c2.state.countdownRemaining, COUNTDOWN_SECONDS);

    const seen = new Set<number>();
    const deadline = Date.now() + COUNTDOWN_SECONDS * 1000 + 5000;
    while (room.state.phase === "countdown" && Date.now() < deadline) {
      seen.add(room.state.countdownRemaining);
      await Promise.race([
        room.waitForNextPatch().catch(() => undefined),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    }
    await waitForPhase(room, "playing");
    // Client view may lag one patch behind room.state after countdown ends.
    while (c1.state.phase !== "playing" && Date.now() < deadline + 2000) {
      await Promise.race([
        room.waitForNextPatch().catch(() => undefined),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    }

    assert.strictEqual(room.state.phase, "playing");
    assert.strictEqual(room.state.countdownRemaining, 0);
    assert.strictEqual(c1.state.phase, "playing");
    for (let n = 1; n <= COUNTDOWN_SECONDS; n++) {
      assert.ok(seen.has(n), `countdown must observe ${n}`);
    }

    // SC-START-02: legal move accepted in playing
    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);
    placePiece(room, c2.sessionId, "N", 0, 5);
    placePiece(room, c2.sessionId, "E", 5, 9);
    placePiece(room, c2.sessionId, "S", 9, 5);
    placePiece(room, c2.sessionId, "W", 5, 0);
    placePiece(room, c3.sessionId, "N", 0, 6);
    placePiece(room, c3.sessionId, "E", 6, 9);
    placePiece(room, c3.sessionId, "S", 9, 6);
    placePiece(room, c3.sessionId, "W", 6, 0);

    c1.send("move", { side: "N", row: 3, col: 4 });
    const moveDeadline = Date.now() + 2000;
    while (
      room.state.seats.get(c1.sessionId).pieces.get("N").col !== 4 &&
      Date.now() < moveDeadline
    ) {
      await Promise.race([
        room.waitForNextPatch().catch(() => undefined),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    }
    assert.strictEqual(
      room.state.seats.get(c1.sessionId).pieces.get("N").col,
      4,
    );
    assert.strictEqual(room.state.currentTurnSessionId, c2.sessionId);
  });

  // SC-START-04: Single seated player has no ready
  it("SC-START-04: single seated player ready is rejected", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const solo = await connectSeat(room, 1, "solo");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(room.state.seats.size, 1);

    solo.send("ready");
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(room.state.seats.get(solo.sessionId).ready, false);
    assert.strictEqual(room.state.phase, "waiting");
  });

  // SC-START-05: All seated ready starts countdown
  it("SC-START-05: all seated ready starts countdown then playing", async function () {
    this.timeout(COUNTDOWN_SECONDS * 1000 + 10000);

    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    const c3 = await connectSeat(room, 3, "p3");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(room.state.seats.size, 3);

    c1.send("ready");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.get(c1.sessionId).ready, true);
    assert.strictEqual(room.state.phase, "waiting");

    c2.send("ready");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "waiting");

    c3.send("ready");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "countdown");
    assert.strictEqual(room.state.countdownRemaining, COUNTDOWN_SECONDS);

    await waitForPhase(room, "playing");
    assert.strictEqual(room.state.phase, "playing");
    assert.strictEqual(c2.state.phase, "playing");
  });

  // SC-START-06 + SC-SAY-13: Ready is one-shot and broadcasts readiness say
  it("SC-START-06: ready is one-shot and shows say bubble", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "waiting");

    const got1 = c1.waitForMessage("say", 2000);
    const got2 = c2.waitForMessage("say", 2000);
    c1.send("ready");

    const ev1 = (await got1) as SayEvent;
    const ev2 = (await got2) as SayEvent;
    assertSayEvent(ev1, c1.sessionId, "ready");
    assertSayEvent(ev2, c1.sessionId, "ready");
    assert.strictEqual(room.state.seats.get(c1.sessionId).ready, true);

    let secondBroadcast = false;
    c2.onMessage("say", () => {
      secondBroadcast = true;
    });
    c1.send("ready");
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(secondBroadcast, false);
    assert.strictEqual(room.state.phase, "waiting");
  });

  // SC-SAY-13: Readiness preset is on the say channel (via ready intent, not raw say)
  it("SC-SAY-13: readiness preset broadcasts via ready, not raw say", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const sender = await connectSeat(room, 1, "sayer");
    const observer = await connectSeat(room, 2, "observer");
    await room.waitForNextPatch();

    // D3: raw say with ready must not broadcast (use ready message).
    let leaked = false;
    observer.onMessage("say", () => {
      leaked = true;
    });
    sender.send("say", { presetId: "ready" });
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(leaked, false);
    assert.strictEqual(room.state.seats.get(sender.sessionId).ready, false);

    const got = observer.waitForMessage("say", 2000);
    sender.send("ready");
    const ev = (await got) as SayEvent;
    assertSayEvent(ev, sender.sessionId, "ready");
    assert.strictEqual(room.state.seats.get(sender.sessionId).ready, true);
  });

  // SC-START-07: Leave does not clear others' ready
  it("SC-START-07: leave does not clear others ready", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    const c3 = await connectSeat(room, 3, "p3");
    await room.waitForNextPatch();

    c1.send("ready");
    c2.send("ready");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.seats.get(c1.sessionId).ready, true);
    assert.strictEqual(room.state.seats.get(c2.sessionId).ready, true);
    assert.strictEqual(room.state.phase, "waiting");

    await c1.leave();
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(c1.sessionId), false);
    assert.strictEqual(room.state.seats.get(c2.sessionId).ready, true);
    assert.strictEqual(room.state.seats.get(c3.sessionId).ready, false);
    assert.strictEqual(room.state.phase, "waiting");
  });

  // SC-START-11: Drop during countdown keeps grace and countdown
  it("SC-START-11: drop during countdown keeps grace and countdown", async function () {
    this.timeout(COUNTDOWN_SECONDS * 1000 + 10000);

    const room = await colyseus.createRoom("tourist", { maxSeats: 2 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "countdown");

    const sessionId = c1.sessionId;
    const now = Date.now();
    await unexpectedDrop(c1);
    await room.waitForNextPatch();

    assert.ok(room.state.seats.has(sessionId));
    assertOfflineGrace(room.state.seats.get(sessionId), now);
    assert.strictEqual(room.state.phase, "countdown");

    await waitForPhase(room, "playing");
    assert.strictEqual(room.state.phase, "playing");
    assert.ok(room.state.seats.has(sessionId));
    assert.strictEqual(c2.state.phase, "playing");
  });

  // SC-START-12: Consented leave during countdown continues
  it("SC-START-12: consented leave during countdown continues", async function () {
    this.timeout(COUNTDOWN_SECONDS * 1000 + 10000);

    const room = await colyseus.createRoom("tourist", { maxSeats: 2 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "countdown");

    const leavingId = c1.sessionId;
    const piecesBefore = allRoomPieces(room.state).length;
    await c1.leave();
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(leavingId), false);
    assert.strictEqual(room.state.seats.size, 1);
    assert.strictEqual(allRoomPieces(room.state).length, piecesBefore - 4);
    assert.strictEqual(room.state.phase, "countdown");

    await waitForPhase(room, "playing");
    assert.strictEqual(room.state.phase, "playing");
    assert.strictEqual(c2.state.phase, "playing");
    assert.strictEqual(room.state.seats.size, 1);
  });

  // SC-MOVE-18: Move before playing is rejected
  it("SC-MOVE-18: move before playing is rejected", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);

    const before = snapshotPieces(room.state);
    const turnBefore = room.state.currentTurnSessionId;
    c1.send("move", { side: "N", row: 3, col: 4 });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.currentTurnSessionId, turnBefore);

    // Also rejected during countdown
    room.state.phase = "countdown";
    room.state.countdownRemaining = 3;
    c1.send("move", { side: "N", row: 3, col: 4 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(snapshotPieces(room.state), before);
    assert.strictEqual(room.state.currentTurnSessionId, turnBefore);
  });

  // SC-MOVE-19: Mid-game seat appends to turn order
  it("SC-MOVE-19: mid-game seat appends to turn order", async () => {
    const room = await colyseus.createRoom("tourist", { maxSeats: 4 });
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");
    await room.waitForNextPatch();
    forcePlaying(room);
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);

    const c3 = await connectSeat(room, 3, "p3");
    await room.waitForNextPatch();
    assert.ok(seatOf(c3), "new seat mid-game");
    assert.strictEqual(room.state.currentTurnSessionId, c1.sessionId);

    placePiece(room, c1.sessionId, "N", 3, 3);
    placePiece(room, c1.sessionId, "E", 0, 4);
    placePiece(room, c1.sessionId, "S", 9, 4);
    placePiece(room, c1.sessionId, "W", 4, 0);
    placePiece(room, c2.sessionId, "N", 0, 5);
    placePiece(room, c2.sessionId, "E", 5, 9);
    placePiece(room, c2.sessionId, "S", 9, 5);
    placePiece(room, c2.sessionId, "W", 5, 0);
    placePiece(room, c3.sessionId, "N", 0, 6);
    placePiece(room, c3.sessionId, "E", 6, 9);
    placePiece(room, c3.sessionId, "S", 9, 6);
    placePiece(room, c3.sessionId, "W", 6, 0);

    c1.send("move", { side: "N", row: 3, col: 4 });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c2.sessionId);

    placePiece(room, c2.sessionId, "N", 2, 3);
    c2.send("move", { side: "N", row: 2, col: 4 });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.currentTurnSessionId, c3.sessionId);
  });
});
