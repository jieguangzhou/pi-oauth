import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const CURSOR_PROVIDER_INFO = {
	id: "cursor",
	name: "Cursor",
	status: "planned",
	login: "Install Cursor CLI, then run agent login. API-key and CLI-backed provider support is planned.",
	manageCommand: "/cursor",
} as const;

export function registerCursor(pi: ExtensionAPI): void {
	pi.registerCommand("cursor", {
		description: "Show Cursor subscription login guidance for future pi-oauth support.",
		handler: async (_args, ctx) => {
			showCursorGuidance(ctx);
		},
	});
}

function showCursorGuidance(ctx: ExtensionCommandContext): void {
	ctx.ui.notify([
		"Cursor support is planned, but not enabled as a provider yet.",
		"",
		"Recommended auth path:",
		"1. Install Cursor CLI: curl https://cursor.com/install -fsS | bash",
		"2. Log in with your subscription: agent login",
		"3. Verify models: agent --list-models",
		"",
		"pi-oauth will prefer official Cursor CLI/API-key paths over private reverse-engineered login.",
	].join("\n"), "info");
}
