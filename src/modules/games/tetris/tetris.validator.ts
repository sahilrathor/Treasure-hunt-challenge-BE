import { z } from 'zod';

import { HttpError } from '../../../utils/http-error.js';
import { createChallengeBinding, verifyChallengeBinding } from '../shared/challenge.js';
import type { GameModule } from '../shared/game.types.js';

const configSchema = z.object({
  target: z.number().int().min(1).max(20),
  speed: z.number().optional(),
});

// Legacy 6x10 dimensions
const LEGACY_WIDTH = 6;
const LEGACY_HEIGHT = 10;

// Tetromino 10x16 dimensions
export const TETRIS_WIDTH = 10;
export const TETRIS_HEIGHT = 16;

export type TetrominoType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export const TETROMINO_ROTATIONS: Record<TetrominoType, number[][][]> = {
  I: [
    [[1, 1, 1, 1]],
    [[1], [1], [1], [1]],
    [[1, 1, 1, 1]],
    [[1], [1], [1], [1]],
  ],
  O: [
    [[1, 1], [1, 1]],
    [[1, 1], [1, 1]],
    [[1, 1], [1, 1]],
    [[1, 1], [1, 1]],
  ],
  T: [
    [[0, 1, 0], [1, 1, 1]],
    [[1, 0], [1, 1], [1, 0]],
    [[1, 1, 1], [0, 1, 0]],
    [[0, 1], [1, 1], [0, 1]],
  ],
  S: [
    [[0, 1, 1], [1, 1, 0]],
    [[1, 0], [1, 1], [0, 1]],
    [[0, 1, 1], [1, 1, 0]],
    [[1, 0], [1, 1], [0, 1]],
  ],
  Z: [
    [[1, 1, 0], [0, 1, 1]],
    [[0, 1], [1, 1], [1, 0]],
    [[1, 1, 0], [0, 1, 1]],
    [[0, 1], [1, 1], [1, 0]],
  ],
  J: [
    [[1, 0, 0], [1, 1, 1]],
    [[1, 1], [1, 0], [1, 0]],
    [[1, 1, 1], [0, 0, 1]],
    [[0, 1], [0, 1], [1, 1]],
  ],
  L: [
    [[0, 0, 1], [1, 1, 1]],
    [[1, 0], [1, 0], [1, 1]],
    [[1, 1, 1], [1, 0, 0]],
    [[1, 1], [0, 1], [0, 1]],
  ],
};

function canPlacePiece(
  board: (string | null)[],
  matrix: number[][],
  row: number,
  col: number,
  width: number,
  height: number,
): boolean {
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix[r]!.length; c += 1) {
      if (matrix[r]![c]) {
        const targetR = row + r;
        const targetC = col + c;
        if (targetC < 0 || targetC >= width || targetR >= height) {
          return false;
        }
        if (targetR >= 0 && board[targetR * width + targetC] !== null) {
          return false;
        }
      }
    }
  }
  return true;
}

export function replayTetrominoTetris(actions: string[]) {
  let board: (string | null)[] = Array<(string | null)>(TETRIS_WIDTH * TETRIS_HEIGHT).fill(null);
  let lines = 0;

  for (const action of actions) {
    const match = /^place:([IOTZSJL]):([0-3]):(-?\d+)$/.exec(action);
    if (!match) continue;

    const type = match[1] as TetrominoType;
    const rot = Number(match[2]);
    const col = Number(match[3]);

    const rotations = TETROMINO_ROTATIONS[type];
    if (!rotations) continue;
    const matrix = rotations[rot % 4]!;

    let landRow = 0;
    if (!canPlacePiece(board, matrix, landRow, col, TETRIS_WIDTH, TETRIS_HEIGHT)) {
      break;
    }

    while (canPlacePiece(board, matrix, landRow + 1, col, TETRIS_WIDTH, TETRIS_HEIGHT)) {
      landRow += 1;
    }

    for (let r = 0; r < matrix.length; r += 1) {
      for (let c = 0; c < matrix[r]!.length; c += 1) {
        if (matrix[r]![c]) {
          const boardR = landRow + r;
          const boardC = col + c;
          if (boardR >= 0 && boardR < TETRIS_HEIGHT && boardC >= 0 && boardC < TETRIS_WIDTH) {
            board[boardR * TETRIS_WIDTH + boardC] = type;
          }
        }
      }
    }

    const keptRows: (string | null)[][] = [];
    for (let row = 0; row < TETRIS_HEIGHT; row += 1) {
      const rowSlice = board.slice(row * TETRIS_WIDTH, (row + 1) * TETRIS_WIDTH);
      if (rowSlice.every((cell) => cell !== null)) {
        lines += 1;
      } else {
        keptRows.push(rowSlice);
      }
    }

    while (keptRows.length < TETRIS_HEIGHT) {
      keptRows.unshift(Array<(string | null)>(TETRIS_WIDTH).fill(null));
    }
    board = keptRows.flat();
  }

  return lines;
}

export function replayLegacyTetris(actions: string[]) {
  let board = Array<boolean>(LEGACY_WIDTH * LEGACY_HEIGHT).fill(false);
  let lines = 0;
  for (const action of actions) {
    const match = /^drop:([0-5])$/.exec(action);
    if (!match) continue;
    const column = Number(match[1]);
    let placed = false;
    for (let row = LEGACY_HEIGHT - 1; row >= 0; row -= 1) {
      const index = row * LEGACY_WIDTH + column;
      if (!board[index]) {
        board[index] = true;
        placed = true;
        break;
      }
    }
    if (!placed) break;
    const rows: boolean[][] = [];
    for (let row = 0; row < LEGACY_HEIGHT; row += 1) {
      const values = board.slice(row * LEGACY_WIDTH, (row + 1) * LEGACY_WIDTH);
      if (values.every(Boolean)) lines += 1;
      else rows.push(values);
    }
    while (rows.length < LEGACY_HEIGHT) rows.unshift(Array<boolean>(LEGACY_WIDTH).fill(false));
    board = rows.flat();
  }
  return lines;
}

export function replayTetris(actions: string[]) {
  const hasPlaceActions = actions.some((action) => action.startsWith('place:'));
  if (hasPlaceActions) {
    return replayTetrominoTetris(actions);
  }
  return replayLegacyTetris(actions);
}

export const tetrisModule: GameModule = {
  code: 'tetris',
  createChallenge(config, difficulty) {
    const parsed = configSchema.parse(config);
    const binding = createChallengeBinding();
    return {
      publicData: { ...parsed, difficulty, challengeToken: binding.token },
      secretData: { tokenHash: binding.tokenHash },
    };
  },
  validate(config, _publicChallenge, secretChallenge, submission) {
    const { target } = configSchema.parse(config);
    const secret = z.object({ tokenHash: z.string() }).parse(secretChallenge);
    const parsed = z
      .object({
        challengeToken: z.string(),
        achieved: z.number().int(),
        actions: z.array(z.string()).max(500),
      })
      .safeParse(submission);
    if (!parsed.success)
      throw new HttpError(422, 'INVALID_GAME_RESULT', 'The Tetris result is malformed.');
    if (!verifyChallengeBinding(parsed.data.challengeToken, secret.tokenHash))
      throw new HttpError(422, 'CHALLENGE_MISMATCH', 'Challenge mismatch.');
    const lines = replayTetris(parsed.data.actions);
    return {
      passed: lines >= target,
      metadata: { lines, actionCount: parsed.data.actions.length },
    };
  },
};
