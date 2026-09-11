import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";

describe("ui/theme HTTP preference", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => {
    colyseus = await boot(appConfig);
  });

  after(async () => {
    await colyseus.shutdown();
  });

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  // SC-THEME-04: Save theme requires registered JWT
  it("SC-THEME-04: rejects unauthenticated theme save", async () => {
    await assert.rejects(
      () =>
        colyseus.http.post("/api/theme", {
          body: { theme: "dark" },
        }),
      (err: any) => {
        assert.ok(err.statusCode === 401 || err.status === 401);
        return true;
      }
    );
  });

  it("SC-THEME-04: rejects anonymous theme save", async () => {
    const anon = await colyseus.sdk.auth.signInAnonymously();
    assert.strictEqual(anon.user.anonymous, true);
    colyseus.sdk.auth.token = anon.token;

    await assert.rejects(
      () =>
        colyseus.sdk.http.post("/api/theme", {
          body: { theme: "dark" },
        }),
      (err: any) => {
        assert.ok(
          err.statusCode === 403 ||
            err.status === 403 ||
            err.statusCode === 401 ||
            err.status === 401
        );
        return true;
      }
    );
  });

  // SC-THEME-05: Registered user theme is persisted
  it("SC-THEME-05: registered user theme is saved and returned on login", async () => {
    const email = `theme-${Date.now()}@example.com`;
    const password = "theme-test-pass";

    const registered = await colyseus.sdk.auth.registerWithEmailAndPassword(
      email,
      password
    );
    assert.ok(registered.token);
    assert.ok(!registered.user.anonymous);
    colyseus.sdk.auth.token = registered.token;

    const save = await colyseus.sdk.http.post("/api/theme", {
      body: { theme: "dark" },
    });
    assert.strictEqual(save.data.theme, "dark");

    await colyseus.sdk.auth.signOut();

    const login = await colyseus.sdk.auth.signInWithEmailAndPassword(
      email,
      password
    );
    assert.strictEqual(login.user.theme, "dark");
  });
});
