/**
 * Minimal debug logger for provider internals.
 *
 * The vendored package is a library and stays silent by default; diagnostics
 * are emitted to stderr only when `PI_AI_DEBUG` is set (any non-empty value
 * other than "0"/"false").
 */
function debugEnabled(): boolean {
	if (typeof process === "undefined" || !process.env) return false;
	const value = process.env.PI_AI_DEBUG;
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function write(level: string, message: string, fields?: Record<string, unknown>): void {
	if (!debugEnabled()) return;
	try {
		const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
		console.error(`[pi-ai:${level}] ${message}${suffix}`);
	} catch {
		// Logging must never perturb provider behavior.
	}
}

export const logger = {
	debug(message: string, fields?: Record<string, unknown>): void {
		write("debug", message, fields);
	},
	info(message: string, fields?: Record<string, unknown>): void {
		write("info", message, fields);
	},
	warn(message: string, fields?: Record<string, unknown>): void {
		write("warn", message, fields);
	},
	error(message: string, fields?: Record<string, unknown>): void {
		write("error", message, fields);
	},
};
