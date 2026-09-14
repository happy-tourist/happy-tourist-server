import { Room, Client } from "colyseus";
import { JWT } from "@colyseus/auth";
import { MyRoomState, Seat, Piece } from "./schema/MyRoomState.js";
import {
  isBoardSide,
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

const SAY_PRESETS: ReadonlySet<string> = new Set(["hello", "luck"]);
type SayPresetId = "hello" | "luck";

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

/**
 * Комната `tourist`: до 4 seated — у каждого 4 фигурки (N/E/S/W);
 * старт на 4-й seat. Unexpected drop → grace 30 с + reconnect; consented leave → сразу remove.
 * Очередь хода + message `move` — authoritative one-step; `say` — ephemeral preset broadcast.
 */
export class MyRoom extends Room<{ state: MyRoomState }> {
  /** Join-order queue of seated sessionIds (room-private; not synced). */
  private turnOrder: string[] = [];

  /** Room-private live says `{ sessionId, at }[]` (not schema); pruned by SAY_TTL_MS. */
  private liveSays: LiveSay[] = [];

  /**
   * Проверка JWT-токена перед допуском игрока в комнату.
   * Если токен невалиден — JWT.verify выбросит ошибку,
   * и клиент не сможет подключиться.
   */
  static async onAuth(token: string, _options: any, _context: any) {
    const userdata = await JWT.verify(token);
    return userdata;
  }

  onCreate(_options: any) {
    console.log("[MyRoom] комната создана");
    this.setState(new MyRoomState());
    // Без maxClients=4 — гости могут смотреть; seated ≤ 4 через seats/started.
    this.setMetadata({ title: "Tourist", status: "waiting" });

    this.onMessage("move", (client, message) => {
      this.handleMove(client, message);
    });

    this.onMessage("say", (client, message) => {
      this.handleSay(client, message);
    });
  }

  onJoin(client: Client, _options: any, auth: any) {
    console.log(`[MyRoom] игрок вошёл: ${client.sessionId}`, auth);

    if (this.state.started) {
      return;
    }

    if (this.state.seats.size >= 4) {
      return;
    }

    const usedIds = new Set<number>();
    const occupied = new Set<string>();
    this.state.seats.forEach((seat) => {
      usedIds.add(seat.touristId);
      seat.pieces.forEach((piece) => {
        occupied.add(cellKey(piece.row, piece.col));
      });
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
    });

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
        new Piece({ side, row: cell.row, col: cell.col }),
      );
    }

    this.state.seats.set(client.sessionId, seat);
    this.appendTurn(client.sessionId);

    if (this.state.seats.size >= 4) {
      this.state.started = true;
      this.setMetadata({ title: "Tourist", status: "playing" });
    }
  }

  /**
   * Unexpected disconnect: hold seat for RECONNECT_GRACE_SECONDS (spectators — no hold).
   * Does not change current turn (SC-MOVE-17).
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
   * After last seated remove — dispose even if spectators remain (D4).
   */
  onLeave(client: Client, _code?: number) {
    console.log(`[MyRoom] игрок вышел: ${client.sessionId}`);

    if (!this.state.seats.has(client.sessionId)) {
      return;
    }

    // Удаляем seat целиком (все 4 pieces).
    // До start: kind и клетки снова в пуле.
    // После start: started остаётся true — новым seats не даём.
    this.state.seats.delete(client.sessionId);
    this.removeFromTurnOrder(client.sessionId);

    if (this.state.seats.size === 0) {
      // Зрители не удерживают комнату.
      void this.disconnect();
    }
  }

  onDispose() {
    console.log("[MyRoom] комната закрыта");
  }

  private appendTurn(sessionId: string) {
    this.turnOrder.push(sessionId);
    if (this.turnOrder.length === 1) {
      this.state.currentTurnSessionId = sessionId;
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
      return;
    }

    if (wasCurrent) {
      // Next at the same index (wrap).
      this.state.currentTurnSessionId =
        this.turnOrder[idx % this.turnOrder.length]!;
    }
  }

  private advanceTurn() {
    if (this.turnOrder.length === 0) {
      this.state.currentTurnSessionId = "";
      return;
    }
    const current = this.state.currentTurnSessionId;
    const idx = this.turnOrder.indexOf(current);
    const from = idx >= 0 ? idx : 0;
    this.state.currentTurnSessionId =
      this.turnOrder[(from + 1) % this.turnOrder.length]!;
  }

  private listAllPieces(): PieceSnapshot[] {
    const out: PieceSnapshot[] = [];
    this.state.seats.forEach((seat) => {
      seat.pieces.forEach((p) => {
        out.push({ side: p.side, row: p.row, col: p.col });
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
      out.push({ side: p.side, row: p.row, col: p.col });
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
    const seat = this.state.seats.get(client.sessionId);
    if (!seat) {
      return; // spectator — reject, no state change
    }
    if (this.state.currentTurnSessionId !== client.sessionId) {
      return; // out of turn
    }

    const intent = this.parseMoveMessage(message);
    if (!intent) {
      return;
    }

    const moverPieces = this.listSeatPieces(client.sessionId);
    const allPieces = this.listAllPieces();
    const validation = validateTouristMove(moverPieces, allPieces, intent);
    if (!validation.ok) {
      return;
    }

    const piece = seat.pieces.get(intent.side);
    if (!piece) {
      return;
    }
    piece.row = intent.row;
    piece.col = intent.col;
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
    if (!presetId) {
      return;
    }

    const now = Date.now();
    if (this.countLiveSaysFor(client.sessionId, now) >= SAY_MAX_LIVE) {
      return;
    }

    this.liveSays.push({ sessionId: client.sessionId, at: now });
    this.broadcast("say", {
      sessionId: client.sessionId,
      presetId,
      at: now,
    });
  }
}
