/** JSON-line logger. Every line passes the secret scrubber (acceptance A7). */
import { redactSecrets } from "../config/index.js";
export function createLogger(cfg, write = (l) => process.stdout.write(l + "\n")) {
    return (msg, fields = {}) => {
        const line = JSON.stringify({ time: new Date().toISOString(), msg, ...fields });
        write(redactSecrets(line, cfg));
    };
}
//# sourceMappingURL=log.js.map