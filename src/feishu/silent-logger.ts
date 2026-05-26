/**
 * No-op logger injected into Lark.Client / WSClient to silence the SDK's
 * default stdout logger. Our own pino logger captures anything we care about.
 *
 * Note: passing `loggerLevel: LoggerLevel.fatal` (value 0) does NOT work —
 * the SDK does `params.loggerLevel || LoggerLevel.info`, so falsy 0 gets
 * overridden back to info and "[info]: [ 'client ready' ]" leaks to stdout.
 */
export const silentLogger = {
  error: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  info: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  trace: (..._args: any[]) => {},
};
