import type { LineFrame, Word } from './recognize';

export type { LineFrame, Word };

export interface OcrLine {
  text: string;
  score: number;
  frame: LineFrame;
  words: Word[];
  /** How this line is joined to the previous one when text is copied. */
  join: 'none' | 'space' | 'newline' | 'paragraph';
}

export interface OcrPage {
  /** Size of the image the coordinates refer to. */
  width: number;
  height: number;
  lines: OcrLine[];
}

export type ModelTier = 'small' | 'tiny';
export type Backend = 'auto' | 'wasm' | 'webgpu';

export type WorkerRequest =
  | { type: 'init'; tier: ModelTier; baseUrl: string; backend: Backend }
  | { type: 'ocr'; id: number; bitmap: ImageBitmap };

export type WorkerResponse =
  | { type: 'model-progress'; loaded: number; total: number; cached: boolean }
  | { type: 'ready'; backend: string; threads: number }
  | { type: 'init-error'; message: string }
  | { type: 'page-progress'; id: number; stage: 'detect' | 'recognize'; done: number; total: number }
  | { type: 'result'; id: number; page: OcrPage; ms: number }
  | { type: 'error'; id: number; message: string };
