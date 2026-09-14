import { Room, Client } from "colyseus";
import { JWT } from "@colyseus/auth";
import { MyRoomState, Seat, Piece } from "./schema/MyRoomState.js";

export type BoardSide = "N" | "E" | "S" | "W";

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
 * старт на 4-й seat. Ходы / правила партии — later.
 */
export class MyRoom extends Room<{ state: MyRoomState }> {
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
    const seat = new Seat({ touristId });

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

    if (this.state.seats.size >= 4) {
      this.state.started = true;
      this.setMetadata({ title: "Tourist", status: "playing" });
    }
  }

  onLeave(client: Client, _code?: number) {
    console.log(`[MyRoom] игрок вышел: ${client.sessionId}`);

    if (!this.state.seats.has(client.sessionId)) {
      return;
    }

    // Удаляем seat целиком (все 4 pieces).
    // До start: kind и клетки снова в пуле.
    // После start: started остаётся true — новым seats не даём.
    this.state.seats.delete(client.sessionId);
  }

  onDispose() {
    console.log("[MyRoom] комната закрыта");
  }
}
