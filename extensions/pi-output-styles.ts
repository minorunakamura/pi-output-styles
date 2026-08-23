import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { OutputStyle } from "../src/pi-output-styles-core.ts";
import { discoverStyles, resolveSavedStyle } from "../src/pi-output-styles-core.ts";

async function persistSelection(ctx: ExtensionContext, style: OutputStyle | undefined): Promise<void> {
	const statePath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-output-style.local.json");
	if (style) {
		await mkdir(join(ctx.cwd, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(statePath, `${JSON.stringify({ style: style.id }, null, 2)}\n`, "utf8");
		return;
	}

	try {
		await unlink(statePath);
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) throw error;
	}
}

export default function piOutputStylesExtension(pi: ExtensionAPI) {
	let styles: OutputStyle[] = [];
	let activeStyle: OutputStyle | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"pi-output-style",
			activeStyle ? ctx.ui.theme.fg("accent", `style: ${activeStyle.name}`) : undefined,
		);
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		const discovered = await discoverStyles(join(ctx.cwd, CONFIG_DIR_NAME, "pi-output-styles"), parseFrontmatter);
		styles = discovered.styles;
		const resolved = await resolveSavedStyle(join(ctx.cwd, CONFIG_DIR_NAME, "pi-output-style.local.json"), styles);
		activeStyle = resolved.activeStyle;
		for (const warning of [...discovered.warnings, ...resolved.warnings]) {
			ctx.ui.notify(warning, "warning");
		}
		updateStatus(ctx);
	}

	pi.registerCommand("pi-output-style", {
		description: "Select the project output style",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			if (!ctx.hasUI) return;
			const selected = await ctx.ui.select("Output style", ["Default", ...styles.map((style) => style.name)]);
			if (!selected) return;

			const nextStyle = selected === "Default" ? undefined : styles.find((style) => style.name === selected);
			if (selected !== "Default" && !nextStyle) {
				ctx.ui.notify(`Output style "${selected}" is no longer available`, "error");
				return;
			}

			try {
				await persistSelection(ctx, nextStyle);
			} catch (error) {
				ctx.ui.notify(`Unable to save output style: ${String(error)}`, "error");
				return;
			}

			activeStyle = nextStyle;
			updateStatus(ctx);
			ctx.ui.notify(nextStyle ? `Output style "${nextStyle.name}" activated` : "Output style cleared", "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!activeStyle) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Active Output Style\n\n${activeStyle.body}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
	});
}
