import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_PROVIDER_INFO, registerCursor } from "./cursor.js";
import { XAI_PROVIDER_INFO, registerXai } from "./xai.js";

const PROVIDERS = [XAI_PROVIDER_INFO, CURSOR_PROVIDER_INFO] as const;

export default function piOAuth(pi: ExtensionAPI): void {
	registerXai(pi);
	registerCursor(pi);

	pi.registerCommand("oauth", {
		description: "Show pi-oauth providers and login guidance.",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select("pi-oauth", PROVIDERS.map((provider) => formatProviderRow(provider)));
			if (!choice) return;
			const provider = PROVIDERS.find((candidate) => choice.startsWith(candidate.name));
			if (!provider) return;
			ctx.ui.notify(`${provider.name}\n${provider.login}\n\nManage: ${provider.manageCommand}`, "info");
		},
	});
}

function formatProviderRow(provider: typeof PROVIDERS[number]): string {
	return `${provider.name.padEnd(16)}${provider.status.padEnd(10)}${provider.manageCommand}`;
}
