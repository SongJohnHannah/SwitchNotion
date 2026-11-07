/// <reference types="node" />
export interface OperatorProgress {
  stage: string;
  plan?: string;
  index?: number;
  totalChunks?: number;
  seconds?: number;
  totalSeconds?: number;
  ownerPid?: number;
  engine?: string;
  [key: string]: unknown;
}
export type Language = 'en' | 'zh' | 'auto';
export interface TranscribeFileOptions {
  source: string;
  outputDirectory?: string;
  profile?: string;
  allowExperimental?: boolean;
  language?: Language;
  signal?: AbortSignal;
  onProgress?: (event: OperatorProgress) => void;
}
export interface FileTranscript {
  complete: true;
  device: 'cuda';
  text: string;
  transcriptFile: string;
  eventsFile: string;
  checkpointFile: string;
  outputDirectory: string;
  transcriptSha256: string;
  totalSamples: number;
  duration: number;
  chunks: number;
  recoveries: number;
  nativeExits: number;
  profile: string;
  entryFile: string;
  validationScope: string;
  [key: string]: unknown;
}
export interface AudioOptions {
  language?: Language;
  signal?: AbortSignal;
  onResult?: (raw: Record<string, unknown>) => void | Promise<void>;
}
export interface SpeechSession {
  readonly recordDirectory: string;
  readonly eventsFile: string;
  status(): Record<string, unknown>;
  configure(): Promise<Record<string, unknown>>;
  probe(options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  retain(): number;
  release(): Promise<void>;
  close(): Promise<void>;
  transcribe(options: AudioOptions & { pcm: Buffer; context?: string }): Promise<string>;
  transcribeDetailed(options: AudioOptions & { pcm: Buffer; context?: string }): Promise<{ text: string; context: string; language: string }>;
  transcribeRecording(options: AudioOptions & { audio: Buffer }): Promise<string>;
  transcribeWav(options: AudioOptions & { wav: Buffer; chunkSeconds?: number; onProgress?: (fraction: number) => void }): Promise<string>;
}
export interface TranscodeVideoOptions {
  source: string;
  outputDirectory?: string;
  quality?: 'original' | '1080p' | '720p';
  hardwareDecode?: boolean;
  forceKeyframeSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (event: OperatorProgress) => void;
}
export interface VideoResult {
  complete: true;
  path: string;
  engine: 'h264_nvenc';
  decodeEngine: string;
  recordDirectory: string;
  duration: number;
  width: number;
  height: number;
  bytes: number;
  sourceBytes: number;
  outputToSourceRatio: number;
  [key: string]: unknown;
}
export function transcribeFile(options: TranscribeFileOptions): Promise<FileTranscript>;
export function transcodeVideo(options: TranscodeVideoOptions): Promise<VideoResult>;
export function createSpeechSession(options?: { timeoutMs?: number; onProgress?: (event: OperatorProgress) => void }): SpeechSession;
export function describe(): Record<string, unknown>;
export function createFileOperator(options: { home?: string; assetHome?: string; loader?: NodeRequire }): {
  transcribeFile: typeof transcribeFile;
  transcodeVideo: typeof transcodeVideo;
  createSpeechSession: typeof createSpeechSession;
  describe: typeof describe;
};
