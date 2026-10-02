/** JSON-line logger. Every line passes the secret scrubber (acceptance A7). */
import { redactSecrets, type Config } from "../config/index.js";

export type LogFn = (msg: string, fields?: Record<string, unknown>) => void;

export function createLogger(cfg: Config, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): LogFn {
  return (msg, fields = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), msg, ...fields });
    write(redactSecrets(line, cfg));
  };
}
