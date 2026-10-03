/** Retryable: rate limits, overload, and server errors. */
export class TransientModelError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
/** Not retryable: bad request, authentication, permission, invalid model. */
export class PermanentModelError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export class BudgetBlockedError extends Error {
    level;
    constructor(message, level) {
        super(message);
        this.level = level;
    }
}
//# sourceMappingURL=types.js.map