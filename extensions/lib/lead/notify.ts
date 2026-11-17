// Tells the lead that the workflow waits for them: in the session UI when there is one, and outside it through
// `OMP_STARTER_NOTIFY_CMD` (run by `sh -c` with the text in `OMP_STARTER_NOTIFY_TEXT`), else a macOS notification.
// Texts carry metadata only (story, gate, path), never file content.
export interface NotifyContext {
	hasUI: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export function leadNotify(ctx: NotifyContext, text: string): void {
	if (ctx.hasUI) ctx.ui.notify(text, "warning");
	const command = process.env.OMP_STARTER_NOTIFY_CMD;
	try {
		if (command) {
			Bun.spawn(["sh", "-c", command], { env: { ...process.env, OMP_STARTER_NOTIFY_TEXT: text }, stdout: "ignore", stderr: "ignore" });
		} else if (process.platform === "darwin") {
			Bun.spawn(["osascript", "-e", `display notification ${JSON.stringify(text)} with title "omp lead"`], { stdout: "ignore", stderr: "ignore" });
		}
	} catch {
		// A notification that cannot be sent must not stop the gate it announces.
	}
}
