/// <reference types="node" />

export type SpeechLanguage = 'auto' | 'zh' | 'en';
export interface LocalSpeechRuntime {
  pythonExecutable: string;
  modelDirectory: string;
  dllDirectory?: string | null;
  platform?: 'win32' | 'darwin';
  architecture?: 'x64' | 'arm64';
  device?: 'cuda' | 'cpu';
  computeType?: 'float16' | 'int8';
  cpuThreads?: number;
}
export interface SpeechStatus {
  protocolVersion: 1;
  provider: 'faster-whisper';
  model: 'medium';
  platform: string;
  architecture: string;
  device: 'cuda' | 'cpu';
  computeType: 'float16' | 'int8';
  hardwareLabel: string;
  offline: true;
  supported: boolean;
  configured: boolean;
  ready: boolean;
  loaded: boolean;
  busy: boolean;
  languages: SpeechLanguage[];
}
export interface SpeechOptions {
  /** Absolute, writable, per-computer state directory; never distribute it. */
  root: string;
  runtime?: LocalSpeechRuntime;
  idleMs?: number;
  timeoutMs?: number;
}
export class SpeechProvider {
  constructor(options: SpeechOptions);
  runtime: LocalSpeechRuntime | null;
  readonly leases: number;
  status(): SpeechStatus;
  configure(): Promise<LocalSpeechRuntime>;
  probe(options?: { signal?: AbortSignal }): Promise<SpeechStatus>;
  /** 16 kHz mono Float32 little-endian PCM, normalized [-1, 1], at most 60 s. */
  transcribe(options: { pcm: Buffer; language?: SpeechLanguage; signal?: AbortSignal }): Promise<string>;
  /** PCM16 / Float32 WAV, up to 10 minutes and 128 MiB; progress is 0..1. */
  transcribeWav(options: { wav: Buffer; language?: SpeechLanguage; signal?: AbortSignal;
    onProgress?: (fraction: number) => void }): Promise<string>;
  retain(): void;
  release(): void;
  close(): void;
}
export function decodeWav(wav: Buffer): { pcm: Buffer; sampleRate: number; duration: number };
