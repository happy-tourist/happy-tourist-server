import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import { JWT } from "@colyseus/auth";

import appConfig from "../src/app.config.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("connecting into a room with JWT", async () => {
    const token = await JWT.sign({ id: 1, username: "test" });
    colyseus.sdk.auth.token = token;

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
});
