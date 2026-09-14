import assert from "assert";
import {
  applyTouristMove,
  chebyshevDistance,
  isCenterCell,
  isPlayableCell,
  PLAYABLE_CELLS,
  validateTouristMove,
  type PieceSnapshot,
} from "../src/game/touristMove.js";

describe("touristMove pure rules", () => {
  it("playable set includes start, task, and four center cells", () => {
    assert.ok(isPlayableCell(0, 3), "N start");
    assert.ok(isPlayableCell(1, 3), "task");
    assert.ok(isCenterCell(4, 4));
    assert.ok(isCenterCell(4, 5));
    assert.ok(isCenterCell(5, 4));
    assert.ok(isCenterCell(5, 5));
    assert.ok(isPlayableCell(4, 4));
    assert.ok(!isPlayableCell(0, 0), "corner hole");
    assert.ok(!isPlayableCell(0, 2), "hole next to start");
    assert.ok(PLAYABLE_CELLS.size > 50);
  });

  it("Chebyshev distance 1 covers orthogonal and diagonal", () => {
    assert.strictEqual(
      chebyshevDistance({ row: 3, col: 3 }, { row: 3, col: 4 }),
      1,
    );
    assert.strictEqual(
      chebyshevDistance({ row: 3, col: 3 }, { row: 4, col: 4 }),
      1,
    );
    assert.strictEqual(
      chebyshevDistance({ row: 3, col: 3 }, { row: 3, col: 5 }),
      2,
    );
  });

  it("accepts legal orthogonal step", () => {
    const pieces: PieceSnapshot[] = [
      { side: "N", row: 3, col: 3 },
      { side: "E", row: 0, col: 4 },
      { side: "S", row: 9, col: 4 },
      { side: "W", row: 4, col: 0 },
    ];
    const result = validateTouristMove(pieces, pieces, {
      side: "N",
      row: 3,
      col: 4,
    });
    assert.strictEqual(result.ok, true);
  });

  it("accepts diagonal step onto center", () => {
    const pieces: PieceSnapshot[] = [{ side: "N", row: 3, col: 3 }];
    const result = validateTouristMove(pieces, pieces, {
      side: "N",
      row: 4,
      col: 4,
    });
    assert.strictEqual(result.ok, true);
  });

  it("rejects occupied cell including own piece", () => {
    const pieces: PieceSnapshot[] = [
      { side: "N", row: 3, col: 3 },
      { side: "E", row: 3, col: 4 },
    ];
    const result = validateTouristMove(pieces, pieces, {
      side: "N",
      row: 3,
      col: 4,
    });
    assert.deepStrictEqual(result, { ok: false, reason: "occupied" });
  });

  it("rejects non-playable hole", () => {
    const pieces: PieceSnapshot[] = [{ side: "N", row: 0, col: 3 }];
    const result = validateTouristMove(pieces, pieces, {
      side: "N",
      row: 0,
      col: 2,
    });
    assert.deepStrictEqual(result, { ok: false, reason: "not_playable" });
  });

  it("rejects non-adjacent target", () => {
    const pieces: PieceSnapshot[] = [{ side: "N", row: 3, col: 3 }];
    const result = validateTouristMove(pieces, pieces, {
      side: "N",
      row: 3,
      col: 5,
    });
    assert.deepStrictEqual(result, { ok: false, reason: "not_adjacent" });
  });

  it("applyTouristMove relocates piece on accept", () => {
    const pieces: PieceSnapshot[] = [
      { side: "N", row: 3, col: 3 },
      { side: "E", row: 0, col: 4 },
    ];
    const next = applyTouristMove(pieces, pieces, {
      side: "N",
      row: 3,
      col: 4,
    });
    assert.ok(next);
    assert.deepStrictEqual(
      next!.find((p) => p.side === "N"),
      { side: "N", row: 3, col: 4 },
    );
    assert.deepStrictEqual(
      next!.find((p) => p.side === "E"),
      { side: "E", row: 0, col: 4 },
    );
  });

  it("applyTouristMove returns null on reject", () => {
    const pieces: PieceSnapshot[] = [{ side: "N", row: 0, col: 3 }];
    assert.strictEqual(
      applyTouristMove(pieces, pieces, { side: "N", row: 0, col: 2 }),
      null,
    );
  });
});
