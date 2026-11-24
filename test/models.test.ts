import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type ThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	buildThinkingLevelMap,
	mapOpenRouterModel,
	mergeKiloCatalogModels,
	type OpenRouterModel,
	selectKiloCatalogModels,
} from "../src/models.ts";

const modelWithGatewayVariants: OpenRouterModel = {
	id: "acme/reasoning-model",
	name: "Acme Reasoning Model",
	context_length: 128_000,
	supported_parameters: ["reasoning"],
	opencode: {
		variants: {
			none: { reasoning: { enabled: false } },
			high: { reasoning: { effort: "high" } },
			xhigh: { reasoning: { effort: "xhigh" } },
		},
	},
};

const freeCatalogModel: OpenRouterModel = {
	id: "acme/free-model:free",
	name: "Acme Free Model",
	context_length: 32_000,
	pricing: { prompt: "0", completion: "0" },
};

const paidCatalogModel: OpenRouterModel = {
	id: "acme/paid-model",
	name: "Acme Paid Model",
	context_length: 64_000,
	pricing: { prompt: "0.000001", completion: "0.000002" },
};

const imageCatalogModel: OpenRouterModel = {
	...freeCatalogModel,
	id: "acme/image-model:free",
	architecture: { output_modalities: ["text", "image"] },
};

describe("selectKiloCatalogModels", () => {
	test("maps selected models with the OpenRouter model mapper", () => {
		expect(selectKiloCatalogModels([paidCatalogModel], {})).toEqual([mapOpenRouterModel(paidCatalogModel)]);
	});

	test("excludes models that generate images", () => {
		const selected = selectKiloCatalogModels([imageCatalogModel, freeCatalogModel], {});

		expect(selected.map((model) => model.id)).toEqual([freeCatalogModel.id]);
	});

	test("excludes paid models when only free models are requested", () => {
		const selected = selectKiloCatalogModels([freeCatalogModel, paidCatalogModel], { freeOnly: true });

		expect(selected.map((model) => model.id)).toEqual([freeCatalogModel.id]);
	});

	test("keeps paid models by default", () => {
		const selected = selectKiloCatalogModels([freeCatalogModel, paidCatalogModel], {});

		expect(selected.map((model) => model.id)).toEqual([freeCatalogModel.id, paidCatalogModel.id]);
	});
});

const kiloTemplate: Model<Api> = {
	id: "kilo/template",
	name: "Kilo Template",
	api: "openai-responses",
	provider: "kilo",
	baseUrl: "https://api.kilo.ai/api/gateway",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
	headers: { "X-KILOCODE-EDITORNAME": "Pi" },
	samplingParams: { temperature: 0.2 },
};

const otherProviderModel: Model<Api> = { ...kiloTemplate, id: "other/model", provider: "other" };

describe("mergeKiloCatalogModels", () => {
	const catalog = [mapOpenRouterModel(paidCatalogModel)];

	test("returns the registered models when the catalog is empty", () => {
		const models = [kiloTemplate, otherProviderModel];

		expect(mergeKiloCatalogModels(models, [])).toBe(models);
	});

	test("returns the registered models when no Kilo template exists", () => {
		const models = [otherProviderModel];

		expect(mergeKiloCatalogModels(models, catalog)).toBe(models);
	});

	test("replaces Kilo models after preserving other providers", () => {
		const merged = mergeKiloCatalogModels([kiloTemplate, otherProviderModel, kiloTemplate], catalog);

		expect(merged.map((model) => `${model.provider}:${model.id}`)).toEqual([
			"other:other/model",
			`kilo:${paidCatalogModel.id}`,
		]);
	});

	test("applies catalog capabilities to the Kilo template", () => {
		const [catalogModel] = catalog;

		expect(mergeKiloCatalogModels([kiloTemplate], catalog)).toEqual([
			{
				...kiloTemplate,
				id: catalogModel?.id,
				name: catalogModel?.name,
				api: catalogModel?.api,
				reasoning: catalogModel?.reasoning,
				input: catalogModel?.input,
				cost: catalogModel?.cost,
				contextWindow: catalogModel?.contextWindow,
				maxTokens: catalogModel?.maxTokens,
				thinkingLevelMap: catalogModel?.thinkingLevelMap,
				headers: undefined,
				compat: catalogModel?.compat,
			},
		]);
	});

	test("uses catalog API routing when present", () => {
		const responsesModel = mapOpenRouterModel({ ...paidCatalogModel, opencode: { ai_sdk_provider: "openai" } });

		expect(mergeKiloCatalogModels([kiloTemplate], [responsesModel])[0]).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://api.kilo.ai/api/openrouter",
		});
	});

	test("falls back to template API routing when the catalog omits it", () => {
		const catalogModel = { ...mapOpenRouterModel(paidCatalogModel), api: undefined, baseUrl: undefined };

		expect(mergeKiloCatalogModels([kiloTemplate], [catalogModel])[0]).toMatchObject({
			api: kiloTemplate.api,
			baseUrl: kiloTemplate.baseUrl,
		});
	});

	test("adds the organization header when an organization is selected", () => {
		expect(mergeKiloCatalogModels([kiloTemplate], catalog, "organization-id")[0]?.headers).toEqual({
			"X-KiloCode-OrganizationId": "organization-id",
		});
	});
});

describe("mapOpenRouterModel", () => {
	test("routes OpenAI models to Responses and other models to chat completions", () => {
		const completionsModel = mapOpenRouterModel(modelWithGatewayVariants);
		const responsesModel = mapOpenRouterModel({
			...modelWithGatewayVariants,
			opencode: { ...modelWithGatewayVariants.opencode, ai_sdk_provider: "openai" },
		});

		expect(completionsModel.api).toBe("openai-completions");
		expect(completionsModel.baseUrl).toBeUndefined();
		expect(responsesModel.api).toBe("openai-responses");
		expect(responsesModel.baseUrl).toBe("https://api.kilo.ai/api/openrouter");
	});

	test("uses gateway-compatible Responses session affinity and cache settings", () => {
		const model = mapOpenRouterModel({
			...modelWithGatewayVariants,
			opencode: { ...modelWithGatewayVariants.opencode, ai_sdk_provider: "openai" },
		});

		expect(model.compat).toEqual({
			sessionAffinityFormat: "openai-nosession",
			supportsLongCacheRetention: false,
		});
	});

	test("maps gateway thinking variants", () => {
		expect(mapOpenRouterModel(modelWithGatewayVariants).thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
	});

	test.each(["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"])(
		"keeps %s at the efforts the catalog declares",
		(id) => {
			expect(mapOpenRouterModel({ ...modelWithGatewayVariants, id }).thinkingLevelMap).toEqual({
				off: "none",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: "xhigh",
				max: null,
			});
		},
	);

	test("keeps gpt-5.5 at the efforts the catalog declares", () => {
		expect(mapOpenRouterModel({ ...modelWithGatewayVariants, id: "openai/gpt-5.5" }).thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
	});
});

describe("buildThinkingLevelMap", () => {
	type KiloVariants = NonNullable<NonNullable<OpenRouterModel["opencode"]>["variants"]>;

	const effort = (value: string, enabled = true) => ({ reasoning: { enabled, effort: value } });

	const catalogEntry = (opencode: OpenRouterModel["opencode"]): OpenRouterModel => ({
		id: "acme/model",
		name: "Acme Model",
		context_length: 128_000,
		supported_parameters: ["reasoning"],
		opencode,
	});

	const expected = (values: Partial<Record<string, string | null>>) => ({
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
		...values,
	});

	const piModel = (model: OpenRouterModel): Model<"openai-completions"> => ({
		id: model.id,
		name: model.name,
		provider: "kilo",
		api: "openai-completions",
		baseUrl: "https://api.kilo.ai/api/openrouter",
		reasoning: model.supported_parameters?.includes("reasoning") ?? false,
		thinkingLevelMap: buildThinkingLevelMap(model),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.context_length,
		maxTokens: 1_024,
	});

	// What Pi itself offers and clamps to, i.e. what the user actually sees.
	const levelsOf = (model: OpenRouterModel) => getSupportedThinkingLevels(piModel(model));
	const clampTo = (model: OpenRouterModel, level: ThinkingLevel) => clampThinkingLevel(piModel(model), level);

	test("offers exactly the states a toggle pair declares", () => {
		const model = catalogEntry({
			variants: { instant: effort("none", false), thinking: effort("high") },
			reasoning_options: [{ type: "toggle" }],
		});

		expect(levelsOf(model)).toEqual(["off", "high"]);
		expect(buildThinkingLevelMap(model)).toEqual(expected({ off: "none", high: "high" }));
	});

	test("offers every level the gateway declares", () => {
		const model = catalogEntry({
			variants: {
				none: effort("none", false),
				minimal: effort("minimal"),
				low: effort("low"),
				medium: effort("medium"),
				high: effort("high"),
				xhigh: effort("xhigh"),
				max: effort("max"),
			},
		});

		expect(levelsOf(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	// Kilo owns the count: Pi offers one choice per declared state, no more, no fewer.
	test.each([
		[1, ["solo"], ["medium"]],
		[2, ["light", "heavy"], ["minimal", "max"]],
		[3, ["light", "medium", "heavy"], ["minimal", "medium", "max"]],
		[4, ["a", "b", "c", "d"], ["minimal", "low", "high", "max"]],
		[5, ["a", "b", "c", "d", "e"], ["minimal", "low", "medium", "high", "max"]],
		[6, ["a", "b", "c", "d", "e", "f"], ["minimal", "low", "medium", "high", "xhigh", "max"]],
	])("maps %i unnamed states onto Pi levels", (_count, efforts, levels) => {
		const variants = Object.fromEntries(
			(efforts as string[]).map((effortName, index) => [`preset-${index}`, effort(effortName)]),
		) as KiloVariants;
		const model = catalogEntry({ variants });

		expect(levelsOf(model)).toEqual(levels);
	});

	test("keeps the Pi count equal to the Kilo count for named states", () => {
		const model = catalogEntry({
			variants: {
				none: effort("none", false),
				low: effort("low"),
				high: effort("high"),
				max: effort("max"),
			},
		});

		expect(levelsOf(model)).toEqual(["off", "low", "high", "max"]);
	});

	test("maps unnamed states by order and intensity, passing the Kilo effort through", () => {
		const model = catalogEntry({
			variants: { first: effort("light"), second: effort("heavy"), third: effort("severe") },
		});

		expect(buildThinkingLevelMap(model)).toEqual(
			expected({ minimal: "light", medium: "heavy", max: "severe" }),
		);
	});

	test("keeps Kilo's direction when it declares its strongest state first", () => {
		const model = catalogEntry({
			variants: { top: effort("max"), middle: effort("medium"), bottom: effort("low") },
			reasoning_options: [{ type: "effort", values: ["max", "medium", "low"] }],
		});

		expect(levelsOf(model)).toEqual(["low", "medium", "max"]);
		expect(clampTo(model, "max")).toBe("max");
	});

	test("clamps to the strongest state Kilo declared, never to an undeclared one", () => {
		const model = catalogEntry({
			variants: { low: effort("low"), high: effort("high") },
			reasoning_options: [{ type: "effort", values: ["low", "high"] }],
		});

		expect(levelsOf(model)).toEqual(["low", "high"]);
		expect(clampTo(model, "max")).toBe("high");
		expect(clampTo(model, "minimal")).toBe("low");
	});

	test("falls back to reasoning_options when variants omit a level", () => {
		const model = catalogEntry({
			variants: { high: effort("high") },
			reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
		});

		expect(levelsOf(model)).toEqual(["off", "low", "high", "max"]);
	});

	test("hides off for models that cannot disable reasoning", () => {
		const model = catalogEntry({
			variants: { low: effort("low"), medium: effort("medium"), high: effort("high") },
			reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
		});

		expect(levelsOf(model)).toEqual(["low", "medium", "high"]);
	});

	test("ignores the variant name when it disagrees with the effort", () => {
		const model = catalogEntry({
			variants: { thinking: effort("minimal"), turbo: effort("max") },
		});

		expect(levelsOf(model)).toEqual(["minimal", "max"]);
	});

	test("declares nothing when Kilo describes no reasoning state", () => {
		expect(buildThinkingLevelMap(catalogEntry({}))).toEqual(expected({}));
		expect(buildThinkingLevelMap(catalogEntry({ variants: {} }))).toEqual(expected({}));
		expect(levelsOf(catalogEntry({}))).toEqual([]);
		expect(levelsOf(catalogEntry({ variants: { instant: { reasoning: { enabled: true } } } }))).toEqual([]);
	});

	test("offers only off when Kilo declares no thinking state", () => {
		const model = catalogEntry({ variants: { instant: effort("none", false) } });

		expect(levelsOf(model)).toEqual(["off"]);
	});
});
