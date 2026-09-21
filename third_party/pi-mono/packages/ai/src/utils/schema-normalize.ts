import type { Tool } from "../types.ts";
import { isRecord } from "./type-guards.ts";

/**
 * Compact JSON Schema normalizers for the Cloud Code Assist transports.
 *
 * The upstream implementation is a full draft-2020-12 normalizer; this port
 * covers the transformations those providers rely on: stripping keywords the
 * wire rejects (spilling human-meaningful ones into `description`), collapsing
 * `type` arrays and `null` unions, folding combiners, and guaranteeing object
 * schemas carry `properties`.
 */

type JsonObject = Record<string, unknown>;

/** Keywords the Google/CCA wire schemas reject outright (protojson "Cannot find field"). */
const UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
	$schema: true,
	$ref: true,
	$defs: true,
	$dynamicRef: true,
	$dynamicAnchor: true,
	examples: true,
	prefixItems: true,
	unevaluatedProperties: true,
	unevaluatedItems: true,
	patternProperties: true,
	additionalProperties: true,
	propertyNames: true,
	minItems: true,
	maxItems: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	multipleOf: true,
	pattern: true,
	format: true,
	dependencies: true,
	dependentSchemas: true,
	dependentRequired: true,
	"x-mcp-header": true,
	deprecated: true,
	readOnly: true,
	writeOnly: true,
	$comment: true,
};

/** Stripped keywords worth preserving as natural-language constraints in `description`. */
const LIFTABLE_TO_DESCRIPTION_FIELDS: Record<string, true> = {
	pattern: true,
	format: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	multipleOf: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	minProperties: true,
	maxProperties: true,
	default: true,
	examples: true,
};

/** snake_case aliases some MCP servers emit; the wire schema is camelCase. */
const SNAKE_TO_CAMEL_RENAMES: Record<string, string> = {
	additional_properties: "additionalProperties",
	any_of: "anyOf",
	prefix_items: "prefixItems",
	property_ordering: "propertyOrdering",
};

/** Keywords whose value is a single subschema. */
const SUBSCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	unevaluatedItems: true,
	not: true,
	if: true,
	then: true,
	else: true,
	contains: true,
	propertyNames: true,
	contentSchema: true,
};

/** Keywords whose value is a `{ name: Schema }` map. */
const SUBSCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	$defs: true,
	definitions: true,
	dependentSchemas: true,
};

/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_ARRAY_KEYS: Record<string, true> = {
	anyOf: true,
	oneOf: true,
	allOf: true,
	prefixItems: true,
};

const COMBINER_KEYS = ["anyOf", "oneOf", "allOf"] as const;

/** Fallback when a schema cannot be represented on the CCA wire at all. */
const CCA_FALLBACK_SCHEMA: JsonObject = { type: "object", properties: {} };

interface NormalizeOptions {
	/** CCA rejects `nullable`; Google accepts it. */
	stripNullableKeyword: boolean;
	/** Google enums are string-only; CCA accepts scalar enums of any type. */
	stringEnumsOnly: boolean;
	/** CCA rejects combiners and `type` arrays that survive normalization. */
	rejectResidualIncompatibilities: boolean;
}

const GOOGLE_OPTIONS: NormalizeOptions = {
	stripNullableKeyword: false,
	stringEnumsOnly: true,
	rejectResidualIncompatibilities: false,
};

const CCA_OPTIONS: NormalizeOptions = {
	stripNullableKeyword: true,
	stringEnumsOnly: false,
	rejectResidualIncompatibilities: true,
};

/** Append stripped constraint keywords to the node's description. */
function spillToDescription(node: JsonObject, entries: ReadonlyArray<readonly [string, unknown]>): void {
	const spilled = entries.filter(([, value]) => value !== undefined);
	if (spilled.length === 0) return;
	const existing = typeof node.description === "string" ? node.description : "";
	const formatted = `{${spilled.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")}}`;
	node.description = existing ? `${existing}\n\n${formatted}` : formatted;
}

function isNullSchema(schema: unknown): boolean {
	return isRecord(schema) && schema.type === "null";
}

function isTrueSchema(schema: unknown): boolean {
	return schema === true || (isRecord(schema) && Object.keys(schema).length === 0);
}

/**
 * Try to merge normalized combiner branches into a single schema.
 * Returns `undefined` when the branches are irreconcilable.
 */
function mergeBranches(branches: JsonObject[]): JsonObject | undefined {
	const nonNull = branches.filter(branch => !isNullSchema(branch));
	if (nonNull.length === 0) return { type: "string" };
	if (nonNull.length === 1) return nonNull[0];
	if (nonNull.some(isTrueSchema)) return {};

	const types = new Set<string>();
	const merged: JsonObject = {};
	let mergeable = true;
	for (const branch of nonNull) {
		const type = typeof branch.type === "string" ? branch.type : undefined;
		if (type === undefined) {
			mergeable = false;
			break;
		}
		types.add(type);
		for (const [key, value] of Object.entries(branch)) {
			if (key === "type") continue;
			if (key === "properties" && isRecord(value)) {
				const existing = isRecord(merged.properties) ? (merged.properties as JsonObject) : {};
				merged.properties = { ...existing, ...value };
				continue;
			}
			if (key === "required" && Array.isArray(value)) {
				const existing = Array.isArray(merged.required) ? (merged.required as unknown[]) : [];
				merged.required = [...new Set([...existing, ...value])];
				continue;
			}
			if (key === "enum" && Array.isArray(value)) {
				const existing = Array.isArray(merged.enum) ? (merged.enum as unknown[]) : [];
				merged.enum = [...new Set([...existing, ...value])];
				continue;
			}
			if (!(key in merged)) {
				merged[key] = value;
			} else if (JSON.stringify(merged[key]) !== JSON.stringify(value)) {
				mergeable = false;
			}
		}
		if (!mergeable) break;
	}
	if (!mergeable) return undefined;
	if (types.size === 1) {
		merged.type = [...types][0];
	} else if (types.size === 2 && types.has("number") && types.has("integer")) {
		merged.type = "number";
	} else {
		return undefined;
	}
	return merged;
}

function normalizeNode(value: unknown, options: NormalizeOptions): unknown {
	if (typeof value === "boolean") {
		// Boolean subschemas: `true` accepts anything, `false` accepts nothing.
		return value ? {} : { not: {} };
	}
	if (!isRecord(value)) return value;

	const node: JsonObject = {};
	const spill: Array<readonly [string, unknown]> = [];

	for (const [rawKey, rawValue] of Object.entries(value)) {
		const key = SNAKE_TO_CAMEL_RENAMES[rawKey] ?? rawKey;

		if (Object.hasOwn(UNSUPPORTED_SCHEMA_FIELDS, key)) {
			if (Object.hasOwn(LIFTABLE_TO_DESCRIPTION_FIELDS, key)) spill.push([key, rawValue]);
			continue;
		}
		if (key === "nullable") {
			if (!options.stripNullableKeyword) node.nullable = rawValue;
			continue;
		}
		if (key === "type" && Array.isArray(rawValue)) {
			// `type: ["string", "null"]` → single type (+ nullable for Google).
			const types = rawValue.filter(t => typeof t === "string") as string[];
			const nonNull = types.filter(t => t !== "null");
			if (nonNull.length === 1) {
				node.type = nonNull[0];
				if (!options.stripNullableKeyword && nonNull.length !== types.length) node.nullable = true;
			} else if (nonNull.length > 1) {
				if (options.rejectResidualIncompatibilities) return undefined;
				node.type = nonNull[0];
			}
			continue;
		}
		if (Object.hasOwn(COMBINER_KEYS, key) && Array.isArray(rawValue)) {
			const branches = rawValue
				.map(branch => normalizeNode(branch, options))
				.filter((branch): branch is JsonObject => isRecord(branch));
			if (key === "allOf") {
				const merged = mergeBranches(branches);
				if (merged) {
					Object.assign(node, merged);
					continue;
				}
			} else {
				const merged = mergeBranches(branches);
				if (merged) {
					const hadNull = branches.length !== rawValue.length || rawValue.some(isNullSchema);
					Object.assign(node, merged);
					if (hadNull && !options.stripNullableKeyword) node.nullable = true;
					continue;
				}
			}
			if (options.rejectResidualIncompatibilities) return undefined;
			node[key] = branches;
			continue;
		}
		if (Object.hasOwn(SUBSCHEMA_VALUE_KEYS, key)) {
			const normalized = normalizeNode(rawValue, options);
			if (normalized === undefined) return undefined;
			node[key] = normalized;
			continue;
		}
		if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, key) && isRecord(rawValue)) {
			const map: JsonObject = {};
			for (const [name, sub] of Object.entries(rawValue)) {
				const normalized = normalizeNode(sub, options);
				if (normalized === undefined) return undefined;
				map[name] = normalized;
			}
			node[key] = map;
			continue;
		}
		if (Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, key) && Array.isArray(rawValue)) {
			const list: unknown[] = [];
			for (const sub of rawValue) {
				const normalized = normalizeNode(sub, options);
				if (normalized === undefined) return undefined;
				list.push(normalized);
			}
			node[key] = list;
			continue;
		}
		node[key] = rawValue;
	}

	// Bare `enum` without `type`: infer the scalar type; Google only accepts
	// string enums, so a non-string enum drops to a bare type.
	if (Array.isArray(node.enum) && node.type === undefined) {
		const allStrings = node.enum.every(v => typeof v === "string");
		if (options.stringEnumsOnly && !allStrings) {
			delete node.enum;
			node.type = "string";
		} else {
			node.type = allStrings ? "string" : "number";
		}
	} else if (Array.isArray(node.enum) && options.stringEnumsOnly && node.enum.some(v => typeof v !== "string")) {
		delete node.enum;
	}

	// Object schemas must carry `properties` for the wire proto.
	if (node.type === "object" && !isRecord(node.properties)) {
		node.properties = {};
	}

	spillToDescription(node, spill);
	return node;
}

/** Normalize a tool parameter schema for the Google `parametersJsonSchema` field. */
export function normalizeSchemaForGoogle(value: unknown): unknown {
	const normalized = normalizeNode(value, GOOGLE_OPTIONS);
	return normalized === undefined ? {} : normalized;
}

/**
 * Normalize a tool parameter schema for Cloud Code Assist's legacy `parameters`
 * field (translated server-side into Anthropic `input_schema`). Schemas with
 * residual incompatibilities fall back to an empty object schema.
 */
export function normalizeSchemaForCCA(value: unknown): unknown {
	const normalized = normalizeNode(value, CCA_OPTIONS);
	return normalized === undefined ? { ...CCA_FALLBACK_SCHEMA } : normalized;
}

/**
 * Resolve a tool's parameters to a JSON Schema object suitable for sending
 * over the wire. Vendored tools already carry JSON Schema (`typebox` TSchema);
 * the clone drops non-serializable metadata the same way the wire serializer
 * always has.
 */
export function toolWireSchema(tool: Tool): Record<string, unknown> {
	const params = tool.parameters as unknown;
	if (!isRecord(params)) return {};
	try {
		return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
	} catch {
		return { ...(params as Record<string, unknown>) };
	}
}
