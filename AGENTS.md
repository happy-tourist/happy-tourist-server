Before work: local [`project-map.md`](project-map.md) (key `happy-tourist-meta` → `..`), then [`happy-tourist-meta/docs/projects-map.md`](../happy-tourist-meta/docs/projects-map.md) (+ optional `projects-map.local.yaml` in meta). Canonical doc links — `happy-tourist-meta/docs/...`.

Skills and OpenSpec live in **happy-tourist-meta**, not in this package. Before choosing a skill: [`happy-tourist-meta/.agents/skills/server/`](../happy-tourist-meta/.agents/skills/server/) (see [`happy-tourist-meta/.agents/AGENTS.md`](../happy-tourist-meta/.agents/AGENTS.md)).

## What This Application Is
`happy-tourist-server` is the Colyseus multiplayer backend for online board game «Счастливый турист». It authenticates players (email/password, anonymous, and Google OAuth via `@colyseus/auth` `addProvider('google')` in `src/config/auth.ts`), hosts realtime game rooms, syncs board state to clients, and exposes a small HTTP surface (health, demo API, auth routes from Colyseus).

This repository is the server-only package. The sibling browser SPA lives in [`../happy-tourist.github.io`](../happy-tourist.github.io) and connects via WebSocket / HTTP (`VITE_COLYSEUS_URL` / `VITE_API_URL` on the client).

## What It Is Used For
Main scenarios (target product; move rules later — see **Current vs client contract**):

- Register / login / anonymous / Google OAuth auth (`@colyseus/auth` + SQLite user store; callback `…/auth/provider/google/callback`).
- Create / join tourist rooms; list available rooms for the lobby.
- Host a `tourist` room for «Счастливый турист» (authoritative seating today; move rules later); lobby listing works today.
- Persist basic player profile fields (display name, rating, games played/won) on the auth user table.
- Serve healthchecks and (in non-production) Colyseus Monitor / Playground.

## Who The Users Are
Indirect users (via the client SPA):

- Casual players in the browser (registered or guest).

There is no separate admin API or CMS in this package.

## Important
This is a realtime game server, not a REST BFF. Authoritative seating, reconnect grace, and later move rules live here; the client mirrors seats/connectivity and renders pieces + presence on a local board layout.

Auth to rooms uses JWT (`MyRoom.onAuth` → `JWT.verify`). CORS in production allows `https://happy-tourist.github.io` with credentials; in development any origin is allowed.

Deploy target: VPS under `/var/www/happy-tourist-server`, Node 22, PM2 (`ecosystem.config.cjs`), GitHub Actions rsync on `main`.

### Current vs client contract
The client (`happy-tourist.github.io`) already assumes:

| Client expectation | Server today |
|--------------------|--------------|
| Room type name `tourist` | Registered as `tourist` in `app.config.ts` with `.enableRealtimeListing()` |
| Live lobby (`LobbyRoom`) | `lobby: defineRoom(LobbyRoom)` — client filters `name: tourist` |
| Tourist board layout on Game | Client-only tile geometry; server does not sync layout |
| Synced seats / started / connectivity | `MyRoomState`: `started` + `seats` Map (`touristId` + `pieces` + `connected` / `reconnectUntil`); move messages later |
| Tourist reconnect grace (30 s) | `onDrop` → `allowReconnection`; `onReconnect` restores seat; LobbyRoom has no grace |
| Lobby `GET /rooms/tourist` | Available (HTTP listing); UI uses live LobbyRoom instead |

When implementing the tourist game, prefer aligning room name, schema, and messages with the client rather than changing the client unilaterally.

## Core Stack
- `colyseus` 0.18 - multiplayer framework (`defineServer` / `defineRoom` via `@colyseus/tools`).
- `@colyseus/tools` - `listen`, `monitor`, `playground`, router helpers.
- `@colyseus/auth` - register/login/anonymous + JWT for room `onAuth`.
- `@colyseus/database` + `drizzle-orm` + `better-sqlite3` - GameDatabase / user store.
- `@colyseus/schema` - synced room state definitions.
- `express` 5 - HTTP middleware mounted inside `defineServer({ express })`.
- `typescript` - primary language (`"type": "module"`, NodeNext).
- Node.js `>= 22`.

## Development Tools
- `tsx` - `npm run dev` / `npm start` (`tsx watch src/index.ts`).
- `tsc` - `npm run build` → `build/` (`tsconfig.build.json`).
- `mocha` + `@colyseus/testing` - `npm test` (`test/**.test.ts`).
- `@colyseus/loadtest` - `npm run loadtest` (`loadtest/example.ts`).
- Package manager: npm (`package-lock.json`).

Application entry: `src/index.ts` → `listen(app)` from `@colyseus/tools`. Prefer not editing `index.ts` unless self-hosting details require it; configure rooms/HTTP in `src/app.config.ts`.

## How Startup Is Organized
1. `@colyseus/tools` loads `.env.${NODE_ENV}` if present, else `.env`.
2. `src/index.ts` imports `app.config.ts` and calls `listen(app)` (port `PORT` or `2567`).
3. `defineServer` wires:
   - `database: db` — enables `@colyseus/auth` HTTP routes + user store;
   - `rooms` — `lobby` → `LobbyRoom`; `tourist` → `MyRoom.enableRealtimeListing()`;
   - `routes` — custom HTTP endpoints (`/api/hello`, `GET|POST /api/theme`);
   - `express(app)` — CORS, `/health`, `/hi`, and (non-prod) `/monitor` + playground.

## Config And Env
See `.env.example`:

| Variable | Role |
|----------|------|
| `AUTH_SALT`, `JWT_SECRET`, `SESSION_SECRET` | Required secrets for `@colyseus/auth` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth Web client (`auth.oauth.addProvider` in `src/config/auth.ts`); redirect `…/auth/provider/google/callback` |
| `DATABASE_URL` | SQLite path (local `./game.db`; prod often `/var/www/happy-tourist-server/game.db`) |
| `NODE_ENV` | `development` / `production` (CORS, monitor/playground) |
| `PORT` | Listen port (default `2567`) |

`@colyseus/tools` picks `.env.development` or `.env.production` by `NODE_ENV`.

## Auth And Database
- `src/config/auth.ts` — `auth.oauth.addProvider('google', …)` (side-effect import from `app.config.ts`); leave built-in `onOAuthProviderCallback` alone.
- `src/db/index.ts` — `GameDatabase` with `schemas: { users }`.
- `src/db/schema.ts` — extends built-in `colyseus_users` with `displayName`, `rating` (default 1000), `gamesPlayed`, `gamesWon` (defaults 0), and nullable `theme` (`light` \| `dark` \| unset). Custom **NOT NULL** columns need `.default(...)` so built-in `/auth/register` / `/auth/login` do not fail; nullable prefs like `theme` do not.
- Room gate: `MyRoom.onAuth` verifies JWT and returns userdata to `onJoin` (same for email / anonymous / Google JWT).

## Rooms
- `src/app.config.ts` — `lobby` (built-in `LobbyRoom`) + `tourist` (`MyRoom` + `.enableRealtimeListing()`) for live lobby list.
- `src/rooms/MyRoom.ts` — `Room<MyRoomState>`: JWT `onAuth`; seat assign; unexpected drop → 30 s grace + `allowReconnection`; consented leave → immediate remove; empty seated → `disconnect()` (≤4 seated, no `maxClients=4`); metadata `status` waiting→playing on fourth seat.
- `src/rooms/schema/MyRoomState.ts` — product sync: `started` + `seats` Map (`touristId` + four `pieces` keyed by side + `connected` / `reconnectUntil`).

Product room name is `tourist`; add move messages when board-game rules land.

## HTTP Surface
From `src/app.config.ts` and Colyseus auth:

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` | `{ status, uptime }` — deploy/monitor |
| GET | `/hi` | Plain text smoke check |
| GET | `/api/hello` | Demo JSON via `createEndpoint` |
| GET | `/api/theme` | `{ theme: 'light' \| 'dark' \| null }`; JWT + registered only; SELECT `users.theme` |
| POST | `/api/theme` | `{ theme: 'light' \| 'dark' }`; JWT + registered only; updates `users.theme` |
| * | `/auth/*` | Provided by `@colyseus/auth` when `database` is set |
| GET | `/rooms/:roomName` | Colyseus available-rooms listing (HTTP fallback; live UI uses LobbyRoom) |
| GET | `/monitor` | Dev only (`monitor()`) |
| * | `/` playground | Dev only (`playground()`) |

CORS middleware must stay first in the Express hook (GitHub Pages ↔ server cross-origin + credentials).

## Combined Structure
- `src/index.ts` - process entry (`listen`).
- `src/app.config.ts` - server definition: DB, rooms, routes, Express middleware.
- `src/db/` - GameDatabase init + Drizzle user schema extension.
- `src/rooms/` - room handlers.
- `src/rooms/schema/` - `@colyseus/schema` state.

Outside `src`:

- `test/` - mocha + `@colyseus/testing` (boots real server, JWT connect).
- `loadtest/` - scriptable clients for `@colyseus/loadtest`.
- `ecosystem.config.cjs` - PM2 (1 fork instance, memory limits for ~1 GB VPS).
- `.github/workflows/deploy.yml` - build check, rsync, remote `npm ci` / `build` / `pm2 reload`.
- `.env.example` / `.env.development` / `.env.production` - env templates (secrets not committed for prod).

## Layering
Typical paths:

- HTTP auth → `@colyseus/auth` + `GameDatabase` / `users` schema.
- Matchmaking → Colyseus `lobby` + `tourist` realtime listing; HTTP `/rooms/:roomName` remains.
- Gameplay (later) → `Room` handler + schema state → client `onStateChange` / game messages.

Keep rules authoritative in the room; do not trust client board state. Prefer extending `users` schema defaults carefully so register/login stay compatible.

## Tests And Loadtest
- `test/MyRoom.test.ts` — boots `appConfig`, signs JWT, creates `tourist`, connects client; seating SC-PIECE-01…08 + reconnect grace SC-PIECE-11…16; lobby live-list cases (SC-LOBBY-02/03).
- `test/theme.test.ts` — `POST /api/theme`: unauthenticated/anonymous reject; registered persist + login userdata; `GET /api/theme` after POST with same JWT (SC-THEME-08) and with older session JWT after another device saves (SC-THEME-09).
- `loadtest/example.ts` — `joinOrCreate` scaffold; `--room tourist` / `--numClients` via npm script.

Update tests when the registered room name, auth contract, reconnect grace, or preference HTTP changes.

## Deploy
- CI: push to `main` → compile locally in Actions → rsync (excludes `.git`, `node_modules`, `build`, `.env*`, `game.db*`) → remote `npm ci`, `npm run build`, `pm2 reload`.
- Runtime cwd: `/var/www/happy-tourist-server`; logs under `/var/log/happy-tourist-server/`.
- Do not commit production secrets; keep `.env.production` on the server only.

## OpenSpec / Skills

Canonical OpenSpec and server skills live in **happy-tourist-meta**. Resolve meta via key `happy-tourist-meta` in [`project-map.md`](project-map.md).

| Path | Description |
|------|-------------|
| [`happy-tourist-meta/docs/projects-map.md`](../happy-tourist-meta/docs/projects-map.md) | Workspace / OpenSpec path map |
| [`happy-tourist-meta/openspec/`](../happy-tourist-meta/openspec/) | Spec-driven workflow: `specs/` source of truth, `changes/` active work |
| [`happy-tourist-meta/openspec/config.yaml`](../happy-tourist-meta/openspec/config.yaml) | Project context and rules |
| [`happy-tourist-meta/.agents/skills/server/`](../happy-tourist-meta/.agents/skills/server/) | Server skills |
| [`happy-tourist-meta/.agents/skills/`](../happy-tourist-meta/.agents/skills/) | OpenSpec skills |
| [`happy-tourist-meta/.agents/AGENTS.md`](../happy-tourist-meta/.agents/AGENTS.md) | Full docs/skills index in meta |
| [`happy-tourist-meta/AGENTS.md`](../happy-tourist-meta/AGENTS.md) | Meta always-on agent instructions |

There are **no** local `.agents/skills/` in this package. Runtime paths in skills (`src/…`) are relative to this server repo root; sibling client is `../happy-tourist.github.io`.

Typical Cursor chat workflow: `/opsx-explore` → `/opsx-propose` → artifact review → `/opsx-apply` → `/opsx-sync` → `/opsx-archive`. OpenSpec artifacts are created and archived in **happy-tourist-meta**, not in this repo.

Commands (`npm test`, `npm run build`, `npm run dev`, `npm run loadtest`) are run by the **agent** from this package root. Do not wait for user confirmation; fix failures before claiming done.

## Related Package
- [`../happy-tourist.github.io`](../happy-tourist.github.io) — Vue 3 + Quasar SPA (GitHub Pages). Prefer changing room names, state schema, and move protocol in coordination with the client; the client assumes room type `tourist`, mirrors seats/`started`/connectivity, renders pieces + presence, and persists the tourist reconnection token in `localStorage` (then `reconnect` → `joinById`) until move rules land.
