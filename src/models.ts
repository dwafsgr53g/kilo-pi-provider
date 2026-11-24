import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { KILO_API_BASE, withOrganizationHeader } from "./api.ts";

export type KiloChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

const KILO_OPENROUTER_BASE = `${KILO_API_BASE}/api/openrouter`;

export interface OpenRouterModel {
	id: string;
	name: string;
	context_length: number;
	max_completion_tokens?: number | null;
	pricing?: {
		prompt?: string | null;
		completion?: string | null;
		input_cache_write?: string | null;
		input_cache_read?: string | null;
	};
	architecture?: {
		input_modalities?: string[] | null;
		output_modalities?: string[] | null;
	};
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
	opencode?: {
		family?: string;
		prompt?: string;
		variants?: Record<
			string,
			{
				reasoning?: {
					enabled?: boolean;
					effort?: string;
				};
				verbosity?: string;
			}
		>;
		/**
		 * Gateway reasoning switches: `toggle` means on/off, `effort` lists the values the provider accepts.
		 * Stays correct when variants lag behind or are missing.
		 */
		reasoning_options?: KiloReasoningOption[];
		ai_sdk_provider?: string;
	};
}

type KiloReasoningOption = { type: "toggle" } | { type: "effort"; values?: string[] | null };

export function parsePrice(price: string | null | undefined): number {
	if (!price) return 0;
	const parsed = parseFloat(price);
	if (Number.isNaN(parsed)) return 0;
	// OpenRouter prices are per-token; Pi expects per-million-token
	return parsed * 1_000_000;
}

export function isFreeModel(m: OpenRouterModel): boolean {
	const prompt = parseFloat(m.pricing?.prompt ?? "1");
	const completion = parseFloat(m.pricing?.completion ?? "1");
	if (prompt !== 0 || completion !== 0) return false;
	// Zero pricing alone isn't reliable: some models report "0" but still require auth.
	// Trust the :free suffix, Kilo-native ids without a vendor prefix, and the known free routers.
	if (m.id === "kilo-auto/free") return true;
	if (m.id.includes(":free")) return true;
	if (!m.id.includes("/")) return true;
	if (m.id.startsWith("kilo/") || m.id.startsWith("openrouter/")) return true;
	return false;
}

/** Pi's reasoning levels below off, weakest first. The scale Kilo efforts are ranked on, never a source of levels. */
const PI_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

type PiReasoningLevel = (typeof PI_REASONING_LEVELS)[number];

const PI_LEVEL_INTENSITY = new Map<string, number>(PI_REASONING_LEVELS.map((level, index) => [level, index]));

/**
 * Pi level shown for a single Kilo thinking mode whose effort name Pi does not know.
 * Intensity cannot be derived from one unnamed state, so it lands mid-scale.
 */
const UNNAMED_EFFORT_LEVEL: PiReasoningLevel = "medium";

/** Provider effort that turns reasoning off. OpenRouter's convention is "none". */
const DEFAULT_OFF_EFFORT = "none";

type KiloThinkingLevelMap = NonNullable<KiloChatModelConfig["thinkingLevelMap"]>;

type KiloModelCompat = {
	thinkingFormat?: "openrouter";
	cacheControlFormat?: "anthropic";
	requiresReasoningContentOnAssistantMessages?: boolean;
	supportsStore?: boolean;
};

function shouldUseResponsesApi(m: OpenRouterModel): boolean {
	const aiSdkProvider = m.opencode?.ai_sdk_provider;
	if (aiSdkProvider === "openai") return true;

	// Metadata can arrive before ai_sdk_provider is populated, so gpt-5 and o-series are matched by id.
	// Chat completions for those answer "please use any of: responses".
	const id = m.id.toLowerCase();
	const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	return (
		shortId === "gpt-5" ||
		shortId.startsWith("gpt-5.") ||
		shortId.startsWith("gpt-5-") ||
		shortId.startsWith("o1") ||
		shortId.startsWith("o3") ||
		shortId.startsWith("o4")
	);
}

function getKiloModelCompat(m: OpenRouterModel, api: Api | undefined): KiloChatModelConfig["compat"] {
	if (api === "openai-responses") {
		return {
			// Kilo/OpenRouter-compatible responses endpoints do not need OpenAI's
			// session_id header, and long prompt-cache retention is provider-specific.
			sessionAffinityFormat: "openai-nosession",
			supportsLongCacheRetention: false,
		};
	}

	const compat: KiloModelCompat = {
		// Kilo's gateway is OpenRouter-compatible, but it uses api.kilo.ai so
		// pi-ai's URL/provider auto-detection cannot infer OpenRouter model quirks.
		thinkingFormat: "openrouter",
		supportsStore: false,
	};

	if (m.id.startsWith("anthropic/")) {
		compat.cacheControlFormat = "anthropic";
	}

	if (m.id === "deepseek/deepseek-v4-flash" || m.id === "deepseek/deepseek-v4-pro") {
		compat.requiresReasoningContentOnAssistantMessages = true;
	}

	return compat;
}

function normalizeEffort(value: string | null | undefined): string | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized ? normalized : undefined;
}

interface KiloReasoningDeclaration {
	/** Provider efforts that enable reasoning, weakest first. */
	efforts: string[];
	/** Provider effort that disables reasoning, when Kilo declares one. */
	offEffort?: string;
}

/**
 * Reads the reasoning states Kilo declares, through the effort each variant carries rather than its name.
 * `reasoning_options` covers models whose variants lag behind; an effort of "none" is the off switch.
 */
function readKiloReasoning(m: OpenRouterModel): KiloReasoningDeclaration | undefined {
	const variants = m.opencode?.variants;
	const options = m.opencode?.reasoning_options;
	if (!variants && !options) return undefined;

	const declared: string[] = [];
	const declare = (effort: string) => {
		if (!declared.includes(effort)) declared.push(effort);
	};
	let offEffort: string | undefined;

	for (const option of options ?? []) {
		if (option?.type === "toggle") {
			offEffort ??= DEFAULT_OFF_EFFORT;
			continue;
		}
		if (option?.type !== "effort" || !Array.isArray(option.values)) continue;
		for (const value of option.values) {
			const effort = normalizeEffort(value);
			if (!effort) continue;
			if (effort === "none") offEffort ??= effort;
			else declare(effort);
		}
	}

	for (const [key, variant] of Object.entries(variants ?? {})) {
		const reasoning = variant?.reasoning;
		if (!reasoning) {
			// A preset that only changes verbosity or sampling declares no effort Pi can send.
			const keyEffort = normalizeEffort(key);
			if (keyEffort === "none") offEffort ??= keyEffort;
			continue;
		}
		const effort = normalizeEffort(reasoning.effort);
		if (reasoning.enabled === false || effort === "none") {
			offEffort ??= effort ?? DEFAULT_OFF_EFFORT;
			continue;
		}
		if (effort) declare(effort);
	}

	if (declared.length === 0 && offEffort === undefined) return undefined;

	return { efforts: orderByIntensity(declared), offEffort };
}

function intensityOf(effort: string): number | undefined {
	return PI_LEVEL_INTENSITY.get(effort);
}

/**
 * Orders Kilo's efforts weakest first, ranking known names by Pi's scale so a strongest-first declaration is corrected.
 * Unknown names keep Kilo's declaration order: Pi does not guess a strength it was not told.
 */
function orderByIntensity(declared: readonly string[]): string[] {
	const ordered = [...declared];
	const known = ordered.filter((effort) => intensityOf(effort) !== undefined);
	if (known.length === ordered.length) {
		return ordered.sort((a, b) => (intensityOf(a) as number) - (intensityOf(b) as number));
	}
	// Unknown vocabulary: Kilo's order is the intensity order.
	// Flipped only when its known efforts are listed strongest first.
	const ranks = known.map((effort) => intensityOf(effort) as number);
	const descending = ranks.some((rank, index) => index > 0 && rank > (ranks[index - 1] as number));
	const ascending = ranks.some((rank, index) => index > 0 && rank < (ranks[index - 1] as number));
	return descending && !ascending ? ordered.reverse() : ordered;
}

/**
 * Pairs Kilo's efforts with Pi levels when the names do not line up: count from Kilo, order preserved, extremes at the ends.
 * More states than Pi has levels is the one case the count cannot hold, so the range is kept and the middle thinned.
 */
function pairUnnamedEfforts(count: number): { level: PiReasoningLevel; effortIndex: number }[] {
	const last = PI_REASONING_LEVELS.length - 1;
	if (count === 1) return [{ level: UNNAMED_EFFORT_LEVEL, effortIndex: 0 }];
	if (count <= PI_REASONING_LEVELS.length) {
		// Floors, so a state never lands on a stronger Pi level than its proportional position.
		return Array.from({ length: count }, (_, index) => ({
			level: PI_REASONING_LEVELS[Math.floor((index * last) / (count - 1))] as PiReasoningLevel,
			effortIndex: index,
		}));
	}
	return Array.from({ length: PI_REASONING_LEVELS.length }, (_, index) => ({
		level: PI_REASONING_LEVELS[index] as PiReasoningLevel,
		effortIndex: Math.round((index * (count - 1)) / last),
	}));
}

/**
 * Maps a catalog entry onto Pi levels: one level per effort Kilo declares, plus off when Kilo can disable reasoning.
 * Undeclared levels stay null so Pi hides them instead of clamping to a state the model was never offered.
 */
export function buildThinkingLevelMap(m: OpenRouterModel): KiloThinkingLevelMap {
	const map: KiloThinkingLevelMap = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};

	const declaration = readKiloReasoning(m);
	if (!declaration) return map;
	if (declaration.offEffort !== undefined) map.off = declaration.offEffort;

	const { efforts } = declaration;
	if (efforts.length === 0) return map;

	if (efforts.every((effort) => intensityOf(effort) !== undefined)) {
		// Kilo named its states in Pi's vocabulary: each keeps its own level.
		for (const effort of efforts) map[effort as PiReasoningLevel] = effort;
		return map;
	}

	for (const { level, effortIndex } of pairUnnamedEfforts(efforts.length)) {
		map[level] = efforts[effortIndex] as string;
	}

	return map;
}

export function selectKiloCatalogModels(
	models: readonly OpenRouterModel[],
	options: { freeOnly?: boolean },
): KiloChatModelConfig[] {
	return models
		.filter((m) => {
			// Skip image generation models
			const outputMods = m.architecture?.output_modalities ?? [];
			if (outputMods.includes("image")) return false;
			// When unauthenticated, only show free models
			if (options.freeOnly && !isFreeModel(m)) return false;
			return true;
		})
		.map(mapOpenRouterModel);
}

export function mergeKiloCatalogModels(
	models: Model<Api>[],
	catalog: readonly KiloChatModelConfig[],
	organizationId?: string,
): Model<Api>[] {
	if (catalog.length === 0) return models;
	// Use an existing kilo model as a template for provider metadata
	const template = models.find((m) => m.provider === "kilo");
	if (!template) return models;
	const headers = organizationId ? withOrganizationHeader({}, organizationId) : undefined;
	const nonKilo = models.filter((m) => m.provider !== "kilo");
	const fullModels = catalog.map((m) => ({
		...template,
		id: m.id,
		name: m.name,
		api: m.api ?? template.api,
		baseUrl: m.baseUrl ?? template.baseUrl,
		reasoning: m.reasoning,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		thinkingLevelMap: m.thinkingLevelMap,
		headers,
		compat: m.compat,
	}));
	return [...nonKilo, ...fullModels];
}

export function mapOpenRouterModel(m: OpenRouterModel): KiloChatModelConfig {
	const inputModalities = m.architecture?.input_modalities ?? ["text"];
	const supportsImages = inputModalities.includes("image");
	const supportsReasoning = m.supported_parameters?.includes("reasoning") ?? false;
	const maxTokens =
		m.top_provider?.max_completion_tokens ?? m.max_completion_tokens ?? Math.ceil(m.context_length * 0.2);
	const api = shouldUseResponsesApi(m) ? ("openai-responses" as const) : ("openai-completions" as const);

	return {
		id: m.id,
		name: m.name,
		api,
		...(api === "openai-responses" ? { baseUrl: KILO_OPENROUTER_BASE } : {}),
		reasoning: supportsReasoning,
		input: supportsImages ? ["text", "image"] : ["text"],
		cost: {
			input: parsePrice(m.pricing?.prompt),
			output: parsePrice(m.pricing?.completion),
			cacheRead: parsePrice(m.pricing?.input_cache_read),
			cacheWrite: parsePrice(m.pricing?.input_cache_write),
		},
		contextWindow: m.context_length,
		maxTokens: maxTokens,
		thinkingLevelMap: buildThinkingLevelMap(m),
		compat: getKiloModelCompat(m, api),
	};
}
