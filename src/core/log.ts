/**
 * Local-only logging: an Output channel inside VS Code plus a rolling file under <home>/logs.
 * Nothing here ever leaves the machine. Tokens are never logged (see redact()).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOME_LAYOUT, ensureDir } from './paths';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
  setLevel(level: LogLevel): void;
}

export interface LogSink {
  write(line: string): void;
}

const TOKEN_RE = /(bearer\s+|"token"\s*:\s*")[a-f0-9]{16,}/gi;
export function redact(text: string): string {
  return text.replace(TOKEN_RE, (_m, p1: string) => `${p1}<redacted>`);
}

export function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.name}: ${meta.message}${meta.stack ? '\n' + meta.stack : ''}`;
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return ' ' + String(meta);
  }
}

class BaseLogger implements Logger {
  constructor(
    private readonly sinks: LogSink[],
    private readonly scope: string,
    private levelRef: { level: LogLevel },
  ) {}
  private emit(level: LogLevel, msg: string, meta?: unknown): void {
    if (ORDER[level] < ORDER[this.levelRef.level]) return;
    const line = redact(`${new Date().toISOString()} [${level}] [${this.scope}] ${msg}${formatMeta(meta)}`);
    for (const s of this.sinks) {
      try {
        s.write(line);
      } catch {
        /* never throw from logging */
      }
    }
  }
  debug(m: string, meta?: unknown): void { this.emit('debug', m, meta); }
  info(m: string, meta?: unknown): void { this.emit('info', m, meta); }
  warn(m: string, meta?: unknown): void { this.emit('warn', m, meta); }
  error(m: string, meta?: unknown): void { this.emit('error', m, meta); }
  child(scope: string): Logger { return new BaseLogger(this.sinks, `${this.scope}:${scope}`, this.levelRef); }
  setLevel(level: LogLevel): void { this.levelRef.level = level; }
}

/** Rolling file sink: synchronous appends (small lines), rotates at ~2MB, keeps 3 files. */
export class FileSink implements LogSink {
  private fd: number | undefined;
  private size = 0;
  constructor(private readonly file: string, private readonly maxBytes = 2 * 1024 * 1024) {
    ensureDir(path.dirname(file));
    try {
      this.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch {
      this.size = 0;
    }
  }
  write(line: string): void {
    if (this.size > this.maxBytes) this.rotate();
    if (this.fd === undefined) this.fd = fs.openSync(this.file, 'a');
    const buf = Buffer.from(line + '\n', 'utf8');
    fs.writeSync(this.fd, buf);
    this.size += buf.length;
  }
  private rotate(): void {
    try {
      this.close();
      for (let i = 2; i >= 0; i--) {
        const from = i === 0 ? this.file : `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      this.size = 0;
    } catch {
      /* ignore */
    }
  }
  private close(): void {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = undefined;
    }
  }
  dispose(): void {
    this.close();
  }
}

export function createLogger(sinks: LogSink[], scope = 'explainit', level: LogLevel = 'info'): Logger {
  return new BaseLogger(sinks, scope, { level });
}

export function createConsoleLogger(level: LogLevel = 'debug', scope = 'test'): Logger {
  return createLogger([{ write: (l) => console.log(l) }], scope, level);
}

export function defaultLogFile(): string {
  return path.join(HOME_LAYOUT.logs(), 'explainit.log');
}
