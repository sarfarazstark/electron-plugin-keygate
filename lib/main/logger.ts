/**
 * Logging.
 *
 * A three-method sink the app can replace. The default writes to the
 * console with a `[keygate]` prefix.
 *
 * Nothing that carries key material may reach a log call — not the key,
 * not the signed token, not a response body. Codes and messages only.
 */
export interface Logger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/** The default logger: the console, prefixed. */
export function createDefaultLogger(prefix = '[keygate]'): Logger {
	return {
		info(message, ...args) {
			console.info(prefix, message, ...args);
		},
		warn(message, ...args) {
			console.warn(prefix, message, ...args);
		},
		error(message, ...args) {
			console.error(prefix, message, ...args);
		},
	};
}

/** A logger that discards everything. Useful in tests. */
export function createSilentLogger(): Logger {
	return {
		info() {},
		warn() {},
		error() {},
	};
}
