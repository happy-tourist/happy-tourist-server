import { Room, Client } from "colyseus";
import { JWT } from "@colyseus/auth";
import { MyRoomState, Seat, Piece } from "./schema/MyRoomState.js";
import {
  isBoardSide,
  isCenterCell,
  validateTouristMove,
  type BoardSide,
  type MoveIntent,
  type PieceSnapshot,
} from "../game/touristMove.js";

export type { BoardSide };

/** Unexpected disconnect grace (seconds) before permanent seat remove. */
export const RECONNECT_GRACE_SECONDS = 30;

/** Live say bubble lifetime (ms) — server clock + `at`. */
export const SAY_TTL_MS = 10_000;

/** Max concurrent live says per sessionId. */
export const SAY_MAX_LIVE = 3;

/** Authoritative start countdown length (seconds), display 5…1. */
export const COUNTDOWN_SECONDS = 5;

/** Multiplayer turn budget (seconds). Mutable for mocha acceleration. */
export let TURN_BUDGET_SECONDS = 60;

/** Solo endgame turn budget (seconds). Mutable for mocha acceleration. */
export let SOLO_BUDGET_SECONDS = 300;

/** Restore production turn budgets after test overrides. */
export function resetTurnBudgets() {
  TURN_BUDGET_SECONDS = 60;
  SOLO_BUDGET_SECONDS = 300;
}

/** Override turn budgets for mocha (avoid waiting real 60s/300s). */
export function setTurnBudgetsForTests(multiSeconds: number, soloSeconds: number) {
  TURN_BUDGET_SECONDS = multiSeconds;
  SOLO_BUDGET_SECONDS = soloSeconds;
}

const SAY_PRESETS: ReadonlySet<string> = new Set(["hello", "luck", "ready"]);
type SayPresetId = "hello" | "luck" | "ready";

type LiveSay = { sessionId: string; at: number };

const TOURIST_IDS = [1, 2, 3, 4] as const;
const SIDES: BoardSide[] = ["N", "E", "S", "W"];

/** Start cells per side (10×10 tourist layout). */
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

function pickUniform<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Create options: only 2|3|4; invalid → default 2. */
function parseMaxSeats(options: unknown): 2 | 3 | 4 {
  const raw =
    options && typeof options === "object"
      ? (options as Record<string, unknown>).maxSeats
      : undefined;
  if (raw === 2 || raw === 3 || raw === 4) {
    return raw;
  }
  return 2;
}

/**
 * Комната `tourist`: seated ≤ maxSeats (2|3|4) — seat+kind сразу;
 * pieces только в `playing` (materialize на вход / join mid-game).
 * Waiting → countdown (full table / all ready) → playing; `move` только в playing.
 * Turn deadline 60s (≥2 eligible) / 300s solo; timeout → advance или timeExpired.
 * Unexpected drop → grace 30 с + reconnect; consented leave → сразу remove.
 * Очередь хода + message `move` / `ready` / `say`.
 */
export class MyRoom extends Room<{ state: MyRoomState }> {
  /** Join-order queue of seated sessionIds (room-private; not synced). */
  private turnOrder: string[] = [];

  /** Room-private live says `{ sessionId, at }[]` (not schema); pruned by SAY_TTL_MS. */
  private liveSays: LiveSay[] = [];

  /** Bumps when a new countdown starts so stale ticks are ignored. */
  private countdownGeneration = 0;

  /** Bumps when turn deadline is cleared/rescheduled so stale timeouts are ignored. */
  private turnTimerGeneration = 0;

  /**
   * Проверка JWT-токена перед допуском игрока в комнату.
   * Если токен невалиден — JWT.verify выбросит ошибку,
   * и клиент не сможет подключиться.
   */
  static async onAuth(token: string, _options: any, _context: any) {
    const userdata = await JWT.verify(token);
    return userdata;
  }

  onCreate(options: any) {
    console.log("[MyRoom] комната создана");
    this.setState(new MyRoomState());
    // Без maxClients — гости могут смотреть; seated ≤ maxSeats через seats.
    this.state.maxSeats = parseMaxSeats(options);
    this.state.phase = "waiting";
    this.state.countdownRemaining = 0;
    this.state.started = false;
    this.state.turnUntil = 0;
    this.state.turnBudgetSeconds = 0;
    this.refreshMetadata();

    this.onMessage("move", (client, message) => {
      this.handleMove(client, message);
    });

    this.onMessage("say", (client, message) => {
      this.handleSay(client, message);
    });

    this.onMessage("ready", (client) => {
      this.handleReady(client);
    });
  }

  onJoin(client: Client, _options: any, auth: any) {
    console.log(`[MyRoom] игрок вошёл: ${client.sessionId}`, auth);

    // Seat while free capacity exists in any phase; full table → spectator.
    if (this.state.seats.size >= this.state.maxSeats) {
      return;
    }

    const usedIds = new Set<number>();
    this.state.seats.forEach((seat) => {
      usedIds.add(seat.touristId);
    });

    const availableIds = TOURIST_IDS.filter((id) => !usedIds.has(id));
    if (availableIds.length === 0) {
      return;
    }

    const touristId = pickUniform(availableIds);
    const seat = new Seat({
      touristId,
      connected: true,
      reconnectUntil: 0,
      ready: false,
      finishPlace: 0,
      timeExpired: false,
    });

    // Pieces only while already playing; waiting/countdown defer until enterPlaying.
    if (this.state.phase === "playing") {
      this.assignPiecesToSeat(seat);
    }

    this.state.seats.set(client.sessionId, seat);
    this.appendTurn(client.sessionId);
    this.refreshMetadata();
    this.maybeStartCountdown();
  }

  /** Lobby listing: title / status / maxSeats / occupied seats. */
  private refreshMetadata() {
    const phase = this.state.phase;
    const status = phase === "playing" ? "playing" : "waiting";
    this.setMetadata({
      title: "Tourist",
      status,
      maxSeats: this.state.maxSeats,
      seats: this.state.seats.size,
    });
  }

  /**
   * Unexpected disconnect: hold seat for RECONNECT_GRACE_SECONDS (spectators — no hold).
   * Does not change current turn (SC-MOVE-17). Does not cancel countdown (SC-START-11).
   * Turn deadline keeps ticking (SC-MOVE-26).
   */
  onDrop(client: Client, _code?: number) {
    console.log(`[MyRoom] игрок отвалился: ${client.sessionId}`);

    const seat = this.state.seats.get(client.sessionId);
    if (!seat) {
      // Зритель — grace не нужен; onLeave снимет клиента.
      return;
    }

    seat.connected = false;
    seat.reconnectUntil = Date.now() + RECONNECT_GRACE_SECONDS * 1000;
    this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
  }

  onReconnect(client: Client) {
    console.log(`[MyRoom] игрок переподключился: ${client.sessionId}`);

    const seat = this.state.seats.get(client.sessionId);
    if (!seat) {
      return;
    }

    seat.connected = true;
    seat.reconnectUntil = 0;
  }

  /**
   * Permanent leave: consented exit, grace timeout, or reconnect denied.
   * Ready marks of remaining seats are kept; countdown is not cancelled.
   * After last seated remove — dispose even if spectators remain (D4).
   */
  onLeave(client: Client, _code?: number) {
    console.log(`[MyRoom] игрок вышел: ${client.sessionId}`);

    if (!this.state.seats.has(client.sessionId)) {
      return;
    }

    // Удаляем seat целиком (все 4 pieces). Kind/клетки снова в пуле.
    // Seats reopen while seats.size < maxSeats in any phase.
    this.state.seats.delete(client.sessionId);
    this.removeFromTurnOrder(client.sessionId);
    this.refreshMetadata();

    if (this.state.seats.size === 0) {
      // Зрители не удерживают комнату.
      void this.disconnect();
      return;
    }

    // Remaining all-ready (after leave) may start countdown; leave never clears others' ready.
    this.maybeStartCountdown();
  }

  onDispose() {
    this.clearTurnDeadline();
    console.log("[MyRoom] комната закрыта");
  }

  /** Occupied cells of unfinished pieces in the room. */
  private collectOccupiedCells(): Set<string> {
    const occupied = new Set<string>();
    this.state.seats.forEach((seat) => {
      seat.pieces.forEach((piece) => {
        if (!piece.finished) {
          occupied.add(cellKey(piece.row, piece.col));
        }
      });
    });
    return occupied;
  }

  /** Place four pieces on free start cells for a seat (mutates `occupied`). */
  private assignPiecesToSeat(seat: Seat, occupied = this.collectOccupiedCells()) {
    for (const side of SIDES) {
      const free = START_CELLS[side].filter(
        (c) => !occupied.has(cellKey(c.row, c.col)),
      );
      if (free.length === 0) {
        // Не должно случаться при ≤4 seats и 4 стартах на сторону.
        return;
      }
      const cell = pickUniform(free);
      occupied.add(cellKey(cell.row, cell.col));
      seat.pieces.set(
        side,
        new Piece({ side, row: cell.row, col: cell.col, finished: false }),
      );
    }
  }

  /** Materialize four pieces for every seated player that still has none. */
  materializePiecesForAllSeats() {
    const occupied = this.collectOccupiedCells();
    this.state.seats.forEach((seat) => {
      if (seat.pieces.size === 0) {
        this.assignPiecesToSeat(seat, occupied);
      }
    });
  }

  /** Enter playing: materialize deferred pieces and start turn deadline. */
  enterPlaying() {
    this.countdownGeneration += 1;
    this.state.countdownRemaining = 0;
    this.state.phase = "playing";
    this.state.started = true;
    this.materializePiecesForAllSeats();
    this.refreshMetadata();
    this.resyncTurnDeadline();
  }

  /** Clear synced deadline + cancel pending turn timeout. */
  clearTurnDeadline() {
    this.turnTimerGeneration += 1;
    this.state.turnUntil = 0;
    this.state.turnBudgetSeconds = 0;
  }

  private countEligible(): number {
    let n = 0;
    this.state.seats.forEach((seat) => {
      if (seat.finishPlace === 0 && !seat.timeExpired) {
        n += 1;
      }
    });
    return n;
  }

  /**
   * Schedule / clear turn deadline for current eligible seat in playing.
   * Solo budget is preserved across that seat's own moves; becoming solo
   * mid-turn (or any multi assign) gets a fresh budget.
   */
  resyncTurnDeadline(opts?: { preserveSoloBudget?: boolean }) {
    if (this.state.phase !== "playing") {
      this.clearTurnDeadline();
      return;
    }

    const current = this.state.currentTurnSessionId;
    if (!this.isEligibleForTurn(current)) {
      this.clearTurnDeadline();
      return;
    }

    const eligible = this.countEligible();
    if (eligible === 0) {
      this.clearTurnDeadline();
      return;
    }

    if (eligible === 1) {
      if (
        opts?.preserveSoloBudget &&
        this.state.turnBudgetSeconds === SOLO_BUDGET_SECONDS &&
        this.state.turnUntil > Date.now()
      ) {
        return;
      }
      this.startTurnDeadline(SOLO_BUDGET_SECONDS);
      return;
    }

    this.startTurnDeadline(TURN_BUDGET_SECONDS);
  }

  private startTurnDeadline(budgetSeconds: number) {
    const gen = ++this.turnTimerGeneration;
    this.state.turnBudgetSeconds = budgetSeconds;
    this.state.turnUntil = Date.now() + budgetSeconds * 1000;
    this.clock.setTimeout(() => {
      if (gen !== this.turnTimerGeneration) {
        return;
      }
      this.onTurnTimeout();
    }, budgetSeconds * 1000);
  }

  private onTurnTimeout() {
    if (this.state.phase !== "playing") {
      this.clearTurnDeadline();
      return;
    }

    const eligible = this.countEligible();
    if (eligible >= 2) {
      // Pass without moving a piece; fresh deadline for next seat.
      this.advanceTurn({ preserveSoloBudget: false });
      return;
    }

    if (eligible === 1) {
      const seat = this.state.seats.get(this.state.currentTurnSessionId);
      if (seat && seat.finishPlace === 0 && !seat.timeExpired) {
        seat.timeExpired = true;
      }
      this.clearTurnDeadline();
      // No eligible movers remain after expiry.
      this.state.currentTurnSessionId = this.findEligibleFrom(0);
      return;
    }

    this.clearTurnDeadline();
  }

  private appendTurn(sessionId: string) {
    this.turnOrder.push(sessionId);
    // First seat, or mid-game join while every remaining seat is finished
    // (currentTurn cleared) — restore an eligible turn without jumping off an
    // already-eligible current player (SC-MOVE-19 / SC-FINISH-07).
    if (!this.isEligibleForTurn(this.state.currentTurnSessionId)) {
      this.state.currentTurnSessionId = this.findEligibleFrom(0);
    }
    if (this.state.phase === "playing") {
      // Mid-join may flip solo→multi; always resync (no solo preserve).
      this.resyncTurnDeadline({ preserveSoloBudget: false });
    }
  }

  private removeFromTurnOrder(sessionId: string) {
    const idx = this.turnOrder.indexOf(sessionId);
    if (idx === -1) {
      return;
    }
    const wasCurrent = this.state.currentTurnSessionId === sessionId;
    this.turnOrder.splice(idx, 1);

    if (this.turnOrder.length === 0) {
      this.state.currentTurnSessionId = "";
      this.clearTurnDeadline();
      return;
    }

    if (wasCurrent) {
      // Next at the same index (wrap), skipping finished / time-expired seats.
      this.state.currentTurnSessionId = this.findEligibleFrom(idx);
    }
    if (this.state.phase === "playing") {
      // Leave may create solo mid-turn → fresh 5:00 (do not preserve).
      this.resyncTurnDeadline({ preserveSoloBudget: false });
    }
  }

  /** Seat may hold turn only while finishPlace === 0 and not time-expired. */
  private isEligibleForTurn(sessionId: string): boolean {
    const seat = this.state.seats.get(sessionId);
    return !!seat && seat.finishPlace === 0 && !seat.timeExpired;
  }

  /** Next eligible sessionId starting at `startIdx` (wrap); `""` if none. */
  private findEligibleFrom(startIdx: number): string {
    if (this.turnOrder.length === 0) {
      return "";
    }
    const n = this.turnOrder.length;
    const from = ((startIdx % n) + n) % n;
    for (let i = 0; i < n; i++) {
      const id = this.turnOrder[(from + i) % n]!;
      if (this.isEligibleForTurn(id)) {
        return id;
      }
    }
    return "";
  }

  private advanceTurn(opts?: { preserveSoloBudget?: boolean }) {
    if (this.turnOrder.length === 0) {
      this.state.currentTurnSessionId = "";
      this.clearTurnDeadline();
      return;
    }
    const current = this.state.currentTurnSessionId;
    const idx = this.turnOrder.indexOf(current);
    const from = idx >= 0 ? idx : -1;
    this.state.currentTurnSessionId = this.findEligibleFrom(from + 1);

    const eligible = this.countEligible();
    const preserve =
      opts?.preserveSoloBudget ??
      (eligible === 1 &&
        this.state.turnBudgetSeconds === SOLO_BUDGET_SECONDS &&
        this.state.turnUntil > Date.now());
    this.resyncTurnDeadline({ preserveSoloBudget: preserve });
  }

  private listAllPieces(): PieceSnapshot[] {
    const out: PieceSnapshot[] = [];
    this.state.seats.forEach((seat) => {
      seat.pieces.forEach((p) => {
        out.push({
          side: p.side,
          row: p.row,
          col: p.col,
          finished: p.finished,
        });
      });
    });
    return out;
  }

  private listSeatPieces(sessionId: string): PieceSnapshot[] {
    const seat = this.state.seats.get(sessionId);
    if (!seat) {
      return [];
    }
    const out: PieceSnapshot[] = [];
    seat.pieces.forEach((p) => {
      out.push({
        side: p.side,
        row: p.row,
        col: p.col,
        finished: p.finished,
      });
    });
    return out;
  }

  private parseMoveMessage(message: unknown): MoveIntent | null {
    if (!message || typeof message !== "object") {
      return null;
    }
    const raw = message as Record<string, unknown>;
    if (!isBoardSide(raw.side)) {
      return null;
    }
    if (
      typeof raw.row !== "number" ||
      typeof raw.col !== "number" ||
      !Number.isInteger(raw.row) ||
      !Number.isInteger(raw.col)
    ) {
      return null;
    }
    return { side: raw.side, row: raw.row, col: raw.col };
  }

  private handleMove(client: Client, message: unknown) {
    if (this.state.phase !== "playing") {
      return; // waiting / countdown — reject, no state change (SC-MOVE-18)
    }

    const seat = this.state.seats.get(client.sessionId);
    if (!seat) {
      return; // spectator — reject, no state change
    }
    if (seat.finishPlace > 0) {
      return; // finished seat — no moves (SC-MOVE-23)
    }
    if (seat.timeExpired) {
      return; // solo budget expired — no moves (SC-MOVE-31)
    }
    if (this.state.currentTurnSessionId !== client.sessionId) {
      return; // out of turn
    }

    const intent = this.parseMoveMessage(message);
    if (!intent) {
      return;
    }

    const piece = seat.pieces.get(intent.side);
    if (!piece || piece.finished) {
      return; // unknown or already finished piece
    }

    const moverPieces = this.listSeatPieces(client.sessionId);
    const allPieces = this.listAllPieces();
    const validation = validateTouristMove(moverPieces, allPieces, intent);
    if (!validation.ok) {
      return;
    }

    piece.row = intent.row;
    piece.col = intent.col;

    if (isCenterCell(intent.row, intent.col)) {
      piece.finished = true;
      let finishedCount = 0;
      seat.pieces.forEach((p) => {
        if (p.finished) {
          finishedCount += 1;
        }
      });
      if (finishedCount === 4 && seat.finishPlace === 0) {
        seat.finishPlace = this.state.nextFinishPlace;
        this.state.nextFinishPlace += 1;
      }
    }

    // Solo wrap preserves remaining 5:00; multi / becoming-solo gets fresh budget.
    this.advanceTurn();
  }

  private parseSayPreset(message: unknown): SayPresetId | null {
    if (!message || typeof message !== "object") {
      return null;
    }
    const presetId = (message as Record<string, unknown>).presetId;
    if (typeof presetId !== "string" || !SAY_PRESETS.has(presetId)) {
      return null;
    }
    return presetId as SayPresetId;
  }

  private pruneLiveSays(now: number) {
    this.liveSays = this.liveSays.filter((s) => now - s.at < SAY_TTL_MS);
  }

  private countLiveSaysFor(sessionId: string, now: number): number {
    this.pruneLiveSays(now);
    return this.liveSays.filter((s) => s.sessionId === sessionId).length;
  }

  /**
   * Whitelist preset say: seated + connected only; max SAY_MAX_LIVE live / SAY_TTL_MS.
   * Silent reject otherwise (no schema mutate). Broadcast to all room clients.
   */
  private handleSay(client: Client, message: unknown) {
    const seat = this.state.seats.get(client.sessionId);
    if (!seat || !seat.connected) {
      return;
    }

    const presetId = this.parseSayPreset(message);
    if (!presetId || presetId === "ready") {
      // Readiness preset only via `ready` message (D3) — not raw say.
      return;
    }

    const now = Date.now();
    this.broadcastSay(client.sessionId, presetId, now);
  }

  /** Ephemeral say broadcast; tracks liveSays for TTL/limit (ready intent bypasses limit). */
  private broadcastSay(
    sessionId: string,
    presetId: SayPresetId,
    at: number,
    options?: { bypassLiveLimit?: boolean },
  ) {
    if (!options?.bypassLiveLimit) {
      if (this.countLiveSaysFor(sessionId, at) >= SAY_MAX_LIVE) {
        return false;
      }
    }
    this.liveSays.push({ sessionId, at });
    this.broadcast("say", { sessionId, presetId, at });
    return true;
  }

  /**
   * One-shot ready while waiting, ≥2 seated, under maxSeats.
   * Marks seat.ready + broadcasts readiness say; may trigger countdown.
   */
  private handleReady(client: Client) {
    if (this.state.phase !== "waiting") {
      return;
    }

    const seat = this.state.seats.get(client.sessionId);
    if (!seat || !seat.connected) {
      return; // spectator / offline
    }

    const seatedCount = this.state.seats.size;
    if (seatedCount < 2 || seatedCount >= this.state.maxSeats) {
      return;
    }

    if (seat.ready) {
      return; // one-shot
    }

    seat.ready = true;
    // Ready intent must always broadcast readiness (bypass live-say cap).
    this.broadcastSay(client.sessionId, "ready", Date.now(), {
      bypassLiveLimit: true,
    });
    this.maybeStartCountdown();
  }

  private allSeatedReady(): boolean {
    if (this.state.seats.size < 2) {
      return false;
    }
    let allReady = true;
    this.state.seats.forEach((seat) => {
      if (!seat.ready) {
        allReady = false;
      }
    });
    return allReady;
  }

  /**
   * Enter countdown when table is full, or when ≥2 seated (under max) are all ready.
   * Leave/drop never cancel an in-progress countdown.
   */
  private maybeStartCountdown() {
    if (this.state.phase !== "waiting") {
      return;
    }

    const seated = this.state.seats.size;
    if (seated < 2) {
      return;
    }

    const full = seated >= this.state.maxSeats;
    if (full || this.allSeatedReady()) {
      this.beginCountdown();
    }
  }

  private beginCountdown() {
    if (this.state.phase !== "waiting") {
      return;
    }

    this.state.phase = "countdown";
    this.state.countdownRemaining = COUNTDOWN_SECONDS;
    // Legacy `started` mirrors playing only (D1); moves gate on phase === 'playing'.
    this.state.started = false;
    this.clearTurnDeadline();
    this.refreshMetadata();

    const gen = ++this.countdownGeneration;
    this.scheduleCountdownTick(gen);
  }

  private scheduleCountdownTick(gen: number) {
    this.clock.setTimeout(() => {
      if (gen !== this.countdownGeneration) {
        return;
      }
      if (this.state.phase !== "countdown") {
        return;
      }

      if (this.state.countdownRemaining > 1) {
        this.state.countdownRemaining -= 1;
        this.scheduleCountdownTick(gen);
        return;
      }

      this.enterPlaying();
    }, 1000);
  }
}
