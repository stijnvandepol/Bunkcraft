/**
 * Structured logging: one JSON object per line (`{"ts","level","msg",...fields}`), easy to ship
 * to Loki/CloudWatch or to grep with jq. LOG_LEVEL (debug|info|warn|error, default info) and
 * LOG_FORMAT (json|text, default json) are read once at start-up.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export class Logger {
  constructor(
    public level: LogLevel = 'info',
    public format: 'json' | 'text' = 'json',
    private readonly sink: (line: string, level: LogLevel) => void = (line, level) => {
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
    },
  ) {}

  /** A logger with fixed fields (e.g. the room code) on every line. */
  child(base: LogFields): ChildLogger {
    return new ChildLogger(this, base);
  }

  log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (ORDER[level] < ORDER[this.level]) return;
    if (this.format === 'text') {
      const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
      this.sink(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra}`, level);
      return;
    }
    this.sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }), level);
  }

  debug(msg: string, fields?: LogFields): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.log('error', msg, fields); }
}

export class ChildLogger {
  constructor(private readonly parent: Logger, private readonly base: LogFields) {}
  log(level: LogLevel, msg: string, fields?: LogFields): void { this.parent.log(level, msg, { ...this.base, ...fields }); }
  debug(msg: string, fields?: LogFields): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.log('error', msg, fields); }
}

export function parseLevel(v: string | undefined): LogLevel {
  return v && v.toLowerCase() in ORDER ? (v.toLowerCase() as LogLevel) : 'info';
}

/** Process-wide logger; the server entry point configures it from the environment. */
export const log = new Logger(parseLevel(process.env.LOG_LEVEL), process.env.LOG_FORMAT === 'text' ? 'text' : 'json');
// Under Vitest stay quiet unless asked.
if (process.env.VITEST && !process.env.LOG_LEVEL) log.level = 'error';
