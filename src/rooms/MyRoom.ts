import { Room, Client } from "colyseus";
import { JWT } from "@colyseus/auth";

/**
 * Базовая комната-заготовка.
 * Здесь вы будете реализовывать логику шашек:
 * состояние доски, ходы, проверка правил, синхронизация.
 */
export class MyRoom extends Room {
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
    // Минимальные поля для live lobby list (LobbyPage: metadata.title / status).
    this.setMetadata({ title: "Checkers", status: "waiting" });
    // Здесь: инициализация состояния доски, установка maxClients = 2 и т.д.
  }

  onJoin(client: Client, _options: any, auth: any) {
    console.log(`[MyRoom] игрок вошёл: ${client.sessionId}`, auth);
    // Здесь: посадить игрока за доску (белые/чёрные)
  }

  onLeave(client: Client, _code?: number) {
    console.log(`[MyRoom] игрок вышел: ${client.sessionId}`);
    // Здесь: обработать выход (пауза, сдача, ожидание переподключения)
  }

  onDispose() {
    console.log("[MyRoom] комната закрыта");
  }
}
