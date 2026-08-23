import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type ParsedFrontmatter = {
	frontmatter: unknown;
	body: string;
};

export type FrontmatterParser = (content: string) => ParsedFrontmatter;

export type OutputStyle = {
	id: string;
	name: string;
	description?: string;
	body: string;
	path: string;
};

export type DiscoveryResult = {
	styles: OutputStyle[];
	warnings: string[];
};

export type StyleResolution = {
	activeStyle?: OutputStyle;
	warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function loadStyleFile(
	filePath: string,
	parseFrontmatter: FrontmatterParser,
): Promise<OutputStyle> {
	const content = await readFile(filePath, "utf8");
	const parsed = parseFrontmatter(content);
	if (!isRecord(parsed.frontmatter)) {
		throw new Error("frontmatter must be an object");
	}
	if (parsed.frontmatter["keep-coding-instructions"] !== true) {
		throw new Error("keep-coding-instructions must be true");
	}
	const name = parsed.frontmatter.name;
	if (name !== undefined && typeof name !== "string") {
		throw new Error("name must be a string");
	}
	const description = parsed.frontmatter.description;
	if (description !== undefined && typeof description !== "string") {
		throw new Error("description must be a string");
	}
	if (typeof parsed.body !== "string") {
		throw new Error("style body must be a string");
	}

	const id = basename(filePath, extname(filePath));
	return {
		id,
		name: name ?? id,
		...(description === undefined ? {} : { description }),
		body: parsed.body,
		path: filePath,
	};
}

export async function discoverStyles(
	styleDirectory: string,
	parseFrontmatter: FrontmatterParser,
): Promise<DiscoveryResult> {
	let entries: Dirent[];
	try {
		entries = await readdir(styleDirectory, { withFileTypes: true });
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { styles: [], warnings: [] };
		}
		return {
			styles: [],
			warnings: [
				`Unable to read style directory ${styleDirectory}: ${String(error)}`,
			],
		};
	}

	const styles: OutputStyle[] = [];
	const warnings: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || extname(entry.name) !== ".md") continue;
		const filePath = join(styleDirectory, entry.name);
		try {
			// Preserve directory order and deterministic warning/error timing.
			// oxlint-disable-next-line no-await-in-loop
			styles.push(await loadStyleFile(filePath, parseFrontmatter));
		} catch (error) {
			warnings.push(
				`${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const selectable = styles.filter((style) => {
		if (style.name === "Default") {
			warnings.push(
				`${style.path}: reserved display name "Default" is not allowed`,
			);
			return false;
		}
		return true;
	});
	const names = new Map<string, OutputStyle[]>();
	for (const style of selectable) {
		const matching = names.get(style.name) ?? [];
		matching.push(style);
		names.set(style.name, matching);
	}
	const unique = selectable.filter(
		(style) => (names.get(style.name)?.length ?? 0) === 1,
	);
	for (const [name, matching] of names) {
		if (matching.length > 1) {
			warnings.push(
				`Duplicate style name "${name}" excluded: ${matching.map((style) => style.path).join(", ")}`,
			);
		}
	}

	unique.sort((a, b) => a.id.localeCompare(b.id));
	return { styles: unique, warnings };
}

export async function resolveSavedStyle(
	stateFile: string,
	styles: readonly OutputStyle[],
): Promise<StyleResolution> {
	let content: string;
	try {
		content = await readFile(stateFile, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { warnings: [] };
		}
		return {
			warnings: [
				`Unable to read output style state file ${stateFile}; using Default`,
			],
		};
	}

	let state: unknown;
	try {
		state = JSON.parse(content);
	} catch {
		return {
			warnings: [`Invalid output style state file ${stateFile}; using Default`],
		};
	}
	if (!isRecord(state) || typeof state.style !== "string") {
		return {
			warnings: [`Invalid output style state file ${stateFile}; using Default`],
		};
	}

	const activeStyle = styles.find((style) => style.id === state.style);
	if (!activeStyle) {
		return {
			warnings: [
				`Saved output style "${state.style}" was not found; using Default`,
			],
		};
	}
	return { activeStyle, warnings: [] };
}
