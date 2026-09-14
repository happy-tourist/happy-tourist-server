/**
 * Pure tourist one-step move rules (authoritative).
 * Playable cells mirror client LAYOUT (start `1`, task `*`, center `7`).
 */

export type BoardSide = "N" | "E" | "S" | "W";

export type Cell = { row: number; col: number };

export type PieceSnapshot = {
  side: string;
  row: number;
  col: number;
};

/** Client LAYOUT geometry (10×10); `.` = hole. */
export const TOURIST_LAYOUT = [
  "...1111...",
  "...****...",
  "..******..",
  "1********1",
  "1***77***1",
  "1***77***1",
  "1********1",
  "..******..",
  "...****...",
  "...1111...",
] as const;

const CENTER_CELLS: ReadonlyArray<Cell> = [
  { row: 4, col: 4 },
  { row: 4, col: 5 },
  { row: 5, col: 4 },
  { row: 5, col: 5 },
];

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function buildPlayableSet(): ReadonlySet<string> {
  const set = new Set<string>();
  for (let row = 0; row < TOURIST_LAYOUT.length; row++) {
    const line = TOURIST_LAYOUT[row]!;
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]!;
      if (ch === "1" || ch === "*" || ch === "7") {
        set.add(cellKey(row, col));
      }
    }
  }
  return set;
}

/** All playable cells (start + task + center). */
export const PLAYABLE_CELLS: ReadonlySet<string> = buildPlayableSet();

export function isPlayableCell(row: number, col: number): boolean {
  return PLAYABLE_CELLS.has(cellKey(row, col));
}

export function isCenterCell(row: number, col: number): boolean {
  return CENTER_CELLS.some((c) => c.row === row && c.col === col);
}

/** Chebyshev distance (orthogonal + diagonal neighbors = 1). */
export function chebyshevDistance(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

export type MoveIntent = {
  side: BoardSide;
  row: number;
  col: number;
};

export type MoveRejectReason =
  | "bad_shape"
  | "unknown_side"
  | "not_adjacent"
  | "not_playable"
  | "occupied";

export type MoveValidation =
  | { ok: true; from: Cell; to: Cell }
  | { ok: false; reason: MoveRejectReason };

const SIDES: ReadonlySet<string> = new Set(["N", "E", "S", "W"]);

export function isBoardSide(value: unknown): value is BoardSide {
  return typeof value === "string" && SIDES.has(value);
}

/**
 * Occupancy of all pieces except the mover’s piece at `exclude`
 * (that cell frees when the piece leaves).
 */
export function buildOccupancy(
  allPieces: ReadonlyArray<PieceSnapshot>,
  exclude?: Cell,
): Set<string> {
  const set = new Set<string>();
  const excludeKey = exclude ? cellKey(exclude.row, exclude.col) : null;
  for (const p of allPieces) {
    const key = cellKey(p.row, p.col);
    if (excludeKey !== null && key === excludeKey) {
      continue;
    }
    set.add(key);
  }
  return set;
}

/**
 * Validate one-step move for a seat’s pieces against room-wide occupancy
 * (excluding the moving piece’s current cell).
 */
export function validateTouristMove(
  moverPieces: ReadonlyArray<PieceSnapshot>,
  allRoomPieces: ReadonlyArray<PieceSnapshot>,
  intent: MoveIntent,
): MoveValidation {
  if (!isBoardSide(intent.side)) {
    return { ok: false, reason: "bad_shape" };
  }
  if (
    typeof intent.row !== "number" ||
    typeof intent.col !== "number" ||
    !Number.isInteger(intent.row) ||
    !Number.isInteger(intent.col) ||
    intent.row < 0 ||
    intent.col < 0
  ) {
    return { ok: false, reason: "bad_shape" };
  }

  const piece = moverPieces.find((p) => p.side === intent.side);
  if (!piece) {
    return { ok: false, reason: "unknown_side" };
  }

  const from: Cell = { row: piece.row, col: piece.col };
  const to: Cell = { row: intent.row, col: intent.col };

  if (chebyshevDistance(from, to) !== 1) {
    return { ok: false, reason: "not_adjacent" };
  }

  if (!isPlayableCell(to.row, to.col)) {
    return { ok: false, reason: "not_playable" };
  }

  const occupancy = buildOccupancy(allRoomPieces, from);
  if (occupancy.has(cellKey(to.row, to.col))) {
    return { ok: false, reason: "occupied" };
  }

  return { ok: true, from, to };
}

/**
 * Pure apply after validation: returns mover pieces with the moved side relocated.
 * Returns `null` if validation fails.
 */
export function applyTouristMove(
  moverPieces: ReadonlyArray<PieceSnapshot>,
  allRoomPieces: ReadonlyArray<PieceSnapshot>,
  intent: MoveIntent,
): PieceSnapshot[] | null {
  const validation = validateTouristMove(moverPieces, allRoomPieces, intent);
  if (!validation.ok) {
    return null;
  }
  return moverPieces.map((p) =>
    p.side === intent.side
      ? { side: p.side, row: intent.row, col: intent.col }
      : { side: p.side, row: p.row, col: p.col },
  );
}
