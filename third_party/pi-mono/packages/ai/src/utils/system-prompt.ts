/** ES2024 `String.prototype.toWellFormed` stand-in: replace lone surrogates with U+FFFD. */
function toWellFormed(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1\ufffd");
}

/**
 * Normalize a context system prompt into a list of non-empty prompt strings.
 * Accepts a single string (vendored `Context.systemPrompt`) or an array of
 * strings for forward compatibility.
 */
export function normalizeSystemPrompts(systemPrompt: readonly string[] | string | undefined | null): string[] {
	if (systemPrompt === undefined || systemPrompt === null) return [];
	const prompts = Array.isArray(systemPrompt) ? systemPrompt : typeof systemPrompt === "string" ? [systemPrompt] : [];
	return prompts.map(prompt => toWellFormed(prompt)).filter(prompt => prompt.trim().length > 0);
}
