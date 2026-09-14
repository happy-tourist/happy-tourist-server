import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import { JWT } from "@colyseus/auth";

import appConfig from "../src/app.config.js";
import type { BoardSide } from "../src/rooms/MyRoom.js";

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

type SeatView = {
  touristId: number;
  side: string;
  row: number;
  col: number;
};

function seatOf(client: { sessionId: string; state: any }): SeatView | undefined {
  return client.state.seats?.get(client.sessionId);
}

function listSeats(state: any): SeatView[] {
  const out: SeatView[] = [];
  state.seats?.forEach((seat: SeatView) => out.push(seat));
  return out;
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

  it("SC-PIECE-01: first join receives a seat", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const client = await connectSeat(room, 1, "p1");

    const seat = seatOf(client);
    assert.ok(seat, "seat must be synced for first joiner");
    assert.ok([1, 2, 3, 4].includes(seat.touristId));
    assert.ok(["N", "E", "S", "W"].includes(seat.side));
    const allowed = START_CELLS[seat.side as BoardSide];
    assert.ok(
      allowed.some((c) => c.row === seat.row && c.col === seat.col),
      `start cell (${seat.row},${seat.col}) must belong to side ${seat.side}`,
    );
    assert.strictEqual(client.state.started, false);
    assert.strictEqual(room.state.seats.size, 1);
  });

  it("SC-PIECE-02: kinds and sides stay unique", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const c1 = await connectSeat(room, 1, "p1");
    const c2 = await connectSeat(room, 2, "p2");

    const s1 = seatOf(c1)!;
    const s2 = seatOf(c2)!;
    assert.notStrictEqual(s1.touristId, s2.touristId);
    assert.notStrictEqual(s1.side, s2.side);

    const seats = listSeats(room.state);
    const ids = seats.map((s) => s.touristId);
    const sides = seats.map((s) => s.side);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(new Set(sides).size, sides.length);
  });

  it("SC-PIECE-03: start cell lies on the assigned side", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const clients = [];
    for (let i = 0; i < 4; i++) {
      clients.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }

    for (const client of clients) {
      const seat = seatOf(client)!;
      const allowed = START_CELLS[seat.side as BoardSide];
      assert.ok(
        allowed.some((c) => c.row === seat.row && c.col === seat.col),
        `side ${seat.side}: (${seat.row},${seat.col}) not in start cells`,
      );
    }
  });

  it("SC-PIECE-04: fifth connection is a spectator after four seats", async () => {
    const room = await colyseus.createRoom("tourist", {});
    for (let i = 0; i < 4; i++) {
      await connectSeat(room, i + 1, `p${i + 1}`);
    }
    assert.strictEqual(room.state.started, true);
    assert.strictEqual(room.state.seats.size, 4);

    const spectator = await connectSeat(room, 5, "guest");
    assert.strictEqual(seatOf(spectator), undefined);
    assert.strictEqual(spectator.state.seats.get(spectator.sessionId), undefined);
    assert.strictEqual(room.state.seats.size, 4);
    assert.strictEqual(room.state.started, true);
  });

  it("SC-PIECE-05: fourth seat starts the room", async () => {
    const room = await colyseus.createRoom("tourist", {});
    for (let i = 0; i < 3; i++) {
      await connectSeat(room, i + 1, `p${i + 1}`);
    }
    assert.strictEqual(room.state.started, false);

    await connectSeat(room, 4, "p4");
    assert.strictEqual(room.state.started, true);
    assert.strictEqual(room.state.seats.size, 4);

    const late = await connectSeat(room, 5, "late");
    assert.strictEqual(seatOf(late), undefined);
  });

  it("SC-PIECE-06: leave before start frees pools", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const first = await connectSeat(room, 1, "p1");
    const firstSeat = seatOf(first)!;
    const freedId = firstSeat.touristId;
    const freedSide = firstSeat.side;

    // Keep the room alive while the seated player leaves.
    await connectSeat(room, 2, "holder");

    await first.leave();
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(first.sessionId), false);
    assert.strictEqual(room.state.started, false);

    // Fill remaining seats — freed kind/side must be assignable again.
    const seenIds = new Set<number>();
    const seenSides = new Set<string>();
    room.state.seats.forEach((seat: SeatView) => {
      seenIds.add(seat.touristId);
      seenSides.add(seat.side);
    });
    for (let i = 0; i < 3; i++) {
      const c = await connectSeat(room, 10 + i, `reseat${i}`);
      const s = seatOf(c)!;
      seenIds.add(s.touristId);
      seenSides.add(s.side);
    }

    assert.ok(seenIds.has(freedId), `freed touristId ${freedId} must be reusable`);
    assert.ok(seenSides.has(freedSide), `freed side ${freedSide} must be reusable`);
  });

  it("SC-PIECE-07: leave after start does not reopen seating", async () => {
    const room = await colyseus.createRoom("tourist", {});
    const seated = [];
    for (let i = 0; i < 4; i++) {
      seated.push(await connectSeat(room, i + 1, `p${i + 1}`));
    }
    assert.strictEqual(room.state.started, true);

    const leaving = seated[0]!;
    const leavingId = leaving.sessionId;
    await leaving.leave();
    await room.waitForNextPatch();

    assert.strictEqual(room.state.seats.has(leavingId), false);
    assert.strictEqual(room.state.seats.size, 3);
    assert.strictEqual(room.state.started, true);

    const late = await connectSeat(room, 99, "spectator");
    assert.strictEqual(seatOf(late), undefined);
    assert.strictEqual(room.state.seats.size, 3);
    assert.strictEqual(room.state.started, true);
  });
});
