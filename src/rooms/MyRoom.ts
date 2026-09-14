import { Room, Client } from "colyseus";
import { JWT } from "@colyseus/auth";

/**
 * Базовая комната-заготовка для настольной игры «Счастливый турист».
 * Правила / авторитетное состояние поля — later.
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
    this.setMetadata({ title: "Tourist", status: "waiting" });
    // Здесь: инициализация состояния, установка maxClients и т.д.
  }

  onJoin(client: Client, _options: any, auth: any) {
    console.log(`[MyRoom] игрок вошёл: ${client.sessionId}`, auth);
    // Здесь: посадить игрока / назначить место
  }

  onLeave(client: Client, _code?: number) {
    console.log(`[MyRoom] игрок вышел: ${client.sessionId}`);
    // Здесь: обработать выход (пауза, сдача, ожидание переподключения)
  }

  onDispose() {
    console.log("[MyRoom] комната закрыта");
  }
}
