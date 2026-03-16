import { randomBytes } from 'crypto';
import { createWriteStream, type WriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import stripAnsi from 'strip-ansi';
import { DEFAULT_MAX_BYTES, truncateTail } from './truncate.js';

export interface BashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface BashOptions {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export class BashSession {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiting: {
    marker: string;
    resolve: (result: BashResult) => void;
    reject: (err: Error) => void;
    options?: BashOptions;
    outputChunks: string[];
    outputBytes: number;
    streamBytes: number;
    streamTruncated: boolean;
    tempFilePath?: string;
    tempFileStream?: WriteStream;
    totalBytes: number;
    cancelled: boolean;
  } | null = null;

  constructor() {
    this.proc = spawn('bash', ['--noprofile', '--norc'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (data) => this.onData(data));
    this.proc.stderr.on('data', (data) => this.onData(data));
    this.proc.on('error', (err) => this.onError(err));
    this.proc.on('exit', () => {
      if (this.waiting) {
        this.waiting.reject(new Error('bash session exited'));
        this.waiting = null;
      }
    });
  }

  async exec(command: string, options?: BashOptions): Promise<BashResult> {
    if (this.waiting) {
      throw new Error('bash session is busy');
    }

    const marker = `__MONOAGENT_DONE_${randomBytes(8).toString('hex')}__`;
    const wrapped = `${command}\necho ${marker}:$?\n`;

    const outputChunks: string[] = [];
    const waiting = {
      marker,
      resolve: (result: BashResult) => {},
      reject: (err: Error) => {},
      options,
      outputChunks,
      outputBytes: 0,
      streamBytes: 0,
      streamTruncated: false,
      totalBytes: 0,
      cancelled: false,
    } as BashSession['waiting'];

    const promise = new Promise<BashResult>((resolve, reject) => {
      waiting.resolve = resolve;
      waiting.reject = reject;
    });

    if (options?.signal) {
      if (options.signal.aborted) {
        return {
          output: '',
          exitCode: undefined,
          cancelled: true,
          truncated: false,
        };
      }
      const abortHandler = () => {
        waiting.cancelled = true;
        this.proc.kill('SIGTERM');
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    this.waiting = waiting;
    this.proc.stdin.write(wrapped);
    return promise;
  }

  private onData(chunk: Buffer): void {
    if (!this.waiting) return;

    const text = sanitizeOutput(chunk.toString('utf-8'));
    this.waiting.totalBytes += text.length;

    // Start writing to temp file if exceeds threshold
    if (this.waiting.totalBytes > DEFAULT_MAX_BYTES && !this.waiting.tempFilePath) {
      const id = randomBytes(8).toString('hex');
      this.waiting.tempFilePath = join(tmpdir(), `monoagent-bash-${id}.log`);
      this.waiting.tempFileStream = createWriteStream(this.waiting.tempFilePath);
      for (const c of this.waiting.outputChunks) {
        this.waiting.tempFileStream.write(c);
      }
    }

    if (this.waiting.tempFileStream) {
      this.waiting.tempFileStream.write(text);
    }

    this.buffer += text;
    this.flushSafeOutput();
    this.checkForMarker();
  }

  private flushSafeOutput(): void {
    if (!this.waiting) return;
    const safety = this.waiting.marker.length + 10;
    if (this.buffer.length <= safety) return;
    const emitPart = this.buffer.slice(0, this.buffer.length - safety);
    this.buffer = this.buffer.slice(this.buffer.length - safety);
    this.appendOutput(emitPart);
  }

  private checkForMarker(): void {
    if (!this.waiting) return;
    const markerIdx = this.buffer.indexOf(this.waiting.marker);
    if (markerIdx === -1) return;

    const before = this.buffer.slice(0, markerIdx);
    const after = this.buffer.slice(markerIdx + this.waiting.marker.length);
    const match = after.match(/^:(\d+)\n/);
    if (!match) return;

    const exitCode = Number.parseInt(match[1], 10);
    const rest = after.slice(match[0].length);

    this.appendOutput(before);
    this.buffer = rest;

    const fullOutput = this.waiting.outputChunks.join('');
    const truncation = truncateTail(fullOutput);
    if (this.waiting.tempFileStream) this.waiting.tempFileStream.end();

    const result: BashResult = {
      output: truncation.truncated ? truncation.content : fullOutput,
      exitCode: this.waiting.cancelled ? undefined : exitCode,
      cancelled: this.waiting.cancelled,
      truncated: truncation.truncated,
      fullOutputPath: this.waiting.tempFilePath,
    };

    const resolve = this.waiting.resolve;
    this.waiting = null;
    resolve(result);
  }

  private appendOutput(text: string): void {
    if (!this.waiting || !text) return;
    this.waiting.outputChunks.push(text);
    this.waiting.outputBytes += text.length;
    if (this.waiting.options?.onChunk && !this.waiting.streamTruncated) {
      const remaining = DEFAULT_MAX_BYTES - this.waiting.streamBytes;
      if (remaining <= 0) {
        this.waiting.streamTruncated = true;
        this.waiting.options.onChunk('\n[Output truncated]\n');
        return;
      }
      if (text.length > remaining) {
        this.waiting.options.onChunk(text.slice(0, remaining));
        this.waiting.options.onChunk('\n[Output truncated]\n');
        this.waiting.streamBytes += remaining;
        this.waiting.streamTruncated = true;
        return;
      }
      this.waiting.streamBytes += text.length;
      this.waiting.options.onChunk(text);
    }
  }

  private onError(err: Error): void {
    if (this.waiting) {
      this.waiting.reject(err);
      this.waiting = null;
    }
  }
}

function sanitizeOutput(text: string): string {
  return stripAnsi(text).replace(/\r/g, '');
}
