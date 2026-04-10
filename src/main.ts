import {
	Plugin,
	MarkdownView,
	WorkspaceLeaf,
	TFile,
	Notice,
} from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { createServer, IncomingMessage, Server } from "http";
/* eslint-disable @typescript-eslint/no-var-requires */
const WS: typeof import("ws") = require("ws");
type WSWebSocket = import("ws").WebSocket;
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SelectionState {
	text: string;
	filePath: string;
	fileUrl: string;
	selection: {
		start: { line: number; character: number };
		end: { line: number; character: number };
		isEmpty: boolean;
	};
}

interface JsonRpcRequest {
	jsonrpc: string;
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: string;
	id?: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
	content: { type: string; text: string }[];
	deferred?: boolean;
	unique_key?: string;
}

interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (params: Record<string, unknown>) => ToolResult;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2024-11-05";
const PORT_MIN = 10000;
const PORT_MAX = 65535;
const MAX_PORT_ATTEMPTS = 50;
const PLUGIN_VERSION = "0.3.0";
const DEBOUNCE_MS = 100;
const LOG_PREFIX = "claude-ide";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class ClaudeCodeIdePlugin extends Plugin {
	private wsServer: InstanceType<typeof WS.Server> | null = null;
	private httpServer: Server | null = null;
	private port: number | null = null;
	private authToken: string | null = null;
	private clients: Set<WSWebSocket> = new Set();

	private latestSelection: SelectionState | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async onload() {
		console.debug(`[${LOG_PREFIX}] Plugin loading...`);
		try {
			await this.startServer();
			this.setupSelectionTracking();
			process.env.CLAUDE_CODE_SSE_PORT = String(this.port);
			console.info(`[${LOG_PREFIX}] Started — port=${this.port}, lock=${this.lockFilePath}, vault=${this.getVaultPath()}`);
			new Notice("Claude Code IDE: connected on port " + this.port);
		} catch (e) {
			console.error(`[${LOG_PREFIX}] Failed to start:`, e);
			new Notice("Claude Code IDE: failed to start – see console");
		}
	}

	async onunload() {
		console.info(`[${LOG_PREFIX}] Unloading — closing server on port ${this.port}`);
		delete process.env.CLAUDE_CODE_SSE_PORT;
		this.stopServer();
		console.debug(`[${LOG_PREFIX}] Unloaded`);
	}

	// -----------------------------------------------------------------------
	// WebSocket server
	// -----------------------------------------------------------------------

	private async startServer(): Promise<void> {
		this.authToken = randomUUID();
		console.debug(`[${LOG_PREFIX}] Auth token generated`);

		// Try random ports until one works
		for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
			const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
			console.debug(`[${LOG_PREFIX}] Trying port ${port} (attempt ${i + 1}/${MAX_PORT_ATTEMPTS})`);
			try {
				await this.listen(port);
				this.port = port;
				console.debug(`[${LOG_PREFIX}] Listening on port ${port}`);
				this.writeLockFile();
				console.debug(`[${LOG_PREFIX}] Lock file written: ${this.lockFilePath}`);
				return;
			} catch (e: any) {
				const code = e?.code;
				if (code === "EADDRINUSE" || code === "EACCES") {
					console.debug(`[${LOG_PREFIX}] Port ${port} unavailable (${code}), retrying`);
					continue;
				}
				throw e;
			}
		}
		throw new Error("Could not find an available port");
	}

	private listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const httpServer = createServer();
			const wss = new WS.Server({ noServer: true });

			httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
				const token = req.headers["x-claude-code-ide-authorization"];
				if (token !== this.authToken) {
					console.warn(`[${LOG_PREFIX}] Rejected connection — invalid auth token`);
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
					socket.destroy();
					return;
				}
				console.debug(`[${LOG_PREFIX}] Upgrading connection — auth OK`);
				wss.handleUpgrade(req, socket, head, (conn) => {
					wss.emit("connection", conn, req);
				});
			});

			wss.on("connection", (conn: WSWebSocket) => {
				this.clients.add(conn);
				console.info(`[${LOG_PREFIX}] Client connected (total: ${this.clients.size})`);
				conn.on("message", (data) => this.handleMessage(conn, data.toString()));
				conn.on("close", () => {
					this.clients.delete(conn);
					console.info(`[${LOG_PREFIX}] Client disconnected (total: ${this.clients.size})`);
				});
				conn.on("error", (err) => {
					this.clients.delete(conn);
					console.error(`[${LOG_PREFIX}] Client error:`, err);
				});
			});

			httpServer.on("error", reject);
			httpServer.listen(port, "127.0.0.1", () => {
				this.httpServer = httpServer;
				this.wsServer = wss;
				resolve();
			});
		});
	}

	private stopServer() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		console.debug(`[${LOG_PREFIX}] Removing lock file`);
		this.removeLockFile();

		console.debug(`[${LOG_PREFIX}] Closing ${this.clients.size} client(s)`);
		for (const client of this.clients) {
			try { client.close(); } catch { /* ignore */ }
		}
		this.clients.clear();

		this.wsServer?.close();
		this.wsServer = null;
		this.httpServer?.close();
		this.httpServer = null;
		this.port = null;
		this.authToken = null;
	}

	// -----------------------------------------------------------------------
	// Lock file
	// -----------------------------------------------------------------------

	private get lockDir(): string {
		const configDir = process.env["CLAUDE_CONFIG_DIR"];
		if (configDir) return join(configDir, "ide");
		return join(homedir(), ".claude", "ide");
	}

	private get lockFilePath(): string {
		return join(this.lockDir, `${this.port}.lock`);
	}

	private getVaultPath(): string {
		return (this.app.vault.adapter as any).basePath as string;
	}

	private writeLockFile() {
		const dir = this.lockDir;
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

		const data = {
			pid: process.pid,
			workspaceFolders: [this.getVaultPath()],
			ideName: "Obsidian",
			transport: "ws",
			runningInWindows: false,
			authToken: this.authToken,
		};
		writeFileSync(this.lockFilePath, JSON.stringify(data), { mode: 0o600 });
		console.debug(`[${LOG_PREFIX}] Lock file contents:`, JSON.stringify({ ...data, authToken: data.authToken?.slice(0, 8) + "..." }));
	}

	private removeLockFile() {
		try {
			if (this.port && existsSync(this.lockFilePath)) unlinkSync(this.lockFilePath);
		} catch { /* best-effort cleanup */ }
	}

	// -----------------------------------------------------------------------
	// JSON-RPC message handling
	// -----------------------------------------------------------------------

	private handleMessage(ws: WSWebSocket, raw: string) {
		let msg: JsonRpcRequest;
		try {
			msg = JSON.parse(raw);
		} catch {
			console.warn(`[${LOG_PREFIX}] Received unparseable message`);
			this.sendError(ws, null, -32700, "Parse error");
			return;
		}

		if (msg.jsonrpc !== "2.0") {
			console.warn(`[${LOG_PREFIX}] Invalid JSON-RPC version: ${msg.jsonrpc}`);
			this.sendError(ws, msg.id ?? null, -32600, "Invalid Request");
			return;
		}

		// Notifications (no id) — just acknowledge silently
		if (msg.id === undefined || msg.id === null) {
			console.debug(`[${LOG_PREFIX}] ← notification: ${msg.method}`);
			return;
		}

		console.debug(`[${LOG_PREFIX}] ← request [${msg.id}]: ${msg.method}`);
		this.handleRequest(ws, msg);
	}

	private handleRequest(ws: WSWebSocket, req: JsonRpcRequest) {
		const { method, params, id } = req;

		switch (method) {
			case "initialize":
				return this.sendResult(ws, id!, {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {
						logging: {},
						prompts: { listChanged: true },
						resources: { subscribe: true, listChanged: true },
						tools: { listChanged: true },
					},
					serverInfo: {
						name: "claude-code-obsidian",
						version: PLUGIN_VERSION,
					},
				});

			case "prompts/list":
				return this.sendResult(ws, id!, { prompts: [] });

			case "resources/list":
				return this.sendResult(ws, id!, { resources: [] });

			case "tools/list":
				return this.sendResult(ws, id!, {
					tools: TOOLS.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
					})),
				});

			case "tools/call": {
				const toolName = (params as any)?.name as string;
				const toolArgs = ((params as any)?.arguments ?? {}) as Record<string, unknown>;
				console.debug(`[${LOG_PREFIX}]   tool: ${toolName}`, toolArgs);
				const tool = TOOLS.find((t) => t.name === toolName);
				if (!tool) {
					console.warn(`[${LOG_PREFIX}]   tool not found: ${toolName}`);
					return this.sendError(ws, id!, -32601, `Tool not found: ${toolName}`);
				}
				try {
					const result = tool.handler.call(this, toolArgs);
					console.debug(`[${LOG_PREFIX}]   → ${toolName} OK`);
					return this.sendResult(ws, id!, result);
				} catch (e: any) {
					console.error(`[${LOG_PREFIX}]   → ${toolName} ERROR:`, e.message);
					return this.sendError(ws, id!, -32000, e.message ?? "Tool execution failed");
				}
			}

			default:
				console.warn(`[${LOG_PREFIX}] Unknown method: ${method}`);
				return this.sendError(ws, id!, -32601, `Method not found: ${method}`);
		}
	}

	private sendResult(ws: WSWebSocket, id: string | number, result: unknown) {
		const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
		ws.send(JSON.stringify(msg));
	}

	private sendError(ws: WSWebSocket, id: string | number | null, code: number, message: string) {
		const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
		ws.send(JSON.stringify(msg));
	}

	private broadcast(method: string, params: unknown) {
		if (this.clients.size === 0) return;
		const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
		let sent = 0;
		for (const client of this.clients) {
			if (client.readyState === WS.OPEN) { client.send(msg); sent++; }
		}
		console.debug(`[${LOG_PREFIX}] → broadcast ${method} to ${sent}/${this.clients.size} client(s)`);
	}

	// -----------------------------------------------------------------------
	// Selection tracking
	// -----------------------------------------------------------------------

	private setupSelectionTracking() {
		console.debug(`[${LOG_PREFIX}] Setting up selection tracking (CM6 listener + active-leaf-change)`);

		// CM6 extension — fires on every selection change within any editor
		this.registerEditorExtension(
			EditorView.updateListener.of((update: ViewUpdate) => {
				if (update.selectionSet) this.scheduleSelectionUpdate();
			})
		);

		// Active leaf change — fires when switching between tabs/panes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				console.debug(`[${LOG_PREFIX}] Active leaf changed`);
				this.scheduleSelectionUpdate();
			})
		);

		console.debug(`[${LOG_PREFIX}] Selection tracking ready`);
	}

	private scheduleSelectionUpdate() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.updateSelection();
		}, DEBOUNCE_MS);
	}

	private updateSelection() {
		const sel = this.captureSelection();
		if (!sel) return;

		if (this.hasSelectionChanged(sel)) {
			this.latestSelection = sel;
			const label = sel.selection.isEmpty
				? `cursor @ ${sel.filePath}:${sel.selection.start.line + 1}`
				: `selection @ ${sel.filePath}:${sel.selection.start.line + 1}-${sel.selection.end.line + 1}`;
			console.debug(`[${LOG_PREFIX}] Selection changed: ${label}`);
			this.broadcast("selection_changed", sel);
		}
	}

	private captureSelection(): SelectionState | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) return null;

		const editor = view.editor;
		const filePath = join(this.getVaultPath(), view.file.path);
		const fileUrl = "file://" + filePath;

		if (editor.somethingSelected()) {
			const from = editor.getCursor("from");
			const to = editor.getCursor("to");
			return {
				text: editor.getSelection(),
				filePath,
				fileUrl,
				selection: {
					start: { line: from.line, character: from.ch },
					end: { line: to.line, character: to.ch },
					isEmpty: false,
				},
			};
		}

		const cursor = editor.getCursor();
		return {
			text: "",
			filePath,
			fileUrl,
			selection: {
				start: { line: cursor.line, character: cursor.ch },
				end: { line: cursor.line, character: cursor.ch },
				isEmpty: true,
			},
		};
	}

	private hasSelectionChanged(newSel: SelectionState): boolean {
		const old = this.latestSelection;
		if (!old) return true;
		if (old.filePath !== newSel.filePath) return true;
		if (old.text !== newSel.text) return true;
		const os = old.selection, ns = newSel.selection;
		return (
			os.start.line !== ns.start.line ||
			os.start.character !== ns.start.character ||
			os.end.line !== ns.end.line ||
			os.end.character !== ns.end.character
		);
	}

	// -----------------------------------------------------------------------
	// Tool handlers (bound to plugin instance via .call(this, ...))
	// -----------------------------------------------------------------------

	private handleGetCurrentSelection(): ToolResult {
		const sel = this.captureSelection();
		if (!sel) {
			return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "No active editor found" }) }] };
		}
		return { content: [{ type: "text", text: JSON.stringify({ success: true, ...sel }) }] };
	}

	private handleGetLatestSelection(): ToolResult {
		const sel = this.latestSelection ?? this.captureSelection();
		if (!sel) {
			return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "No selection available" }) }] };
		}
		return { content: [{ type: "text", text: JSON.stringify({ success: true, ...sel }) }] };
	}

	private handleGetOpenEditors(): ToolResult {
		const tabs: Record<string, unknown>[] = [];
		const activeFile = this.app.workspace.getActiveFile();

		this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const file = leaf.view.file;
			if (!file) return;

			const absPath = join(this.getVaultPath(), file.path);
			const isActive = activeFile?.path === file.path;

			const tab: Record<string, unknown> = {
				uri: "file://" + absPath,
				isActive,
				isPinned: false,
				isPreview: false,
				isDirty: false,
				label: file.name,
				groupIndex: 0,
				viewColumn: 1,
				isGroupActive: true,
				fileName: absPath,
				languageId: "markdown",
				lineCount: leaf.view.editor.lineCount(),
				isUntitled: false,
			};

			if (isActive && this.latestSelection?.selection) {
				tab.selection = {
					start: this.latestSelection.selection.start,
					end: this.latestSelection.selection.end,
					isReversed: false,
				};
			}

			tabs.push(tab);
		});

		return { content: [{ type: "text", text: JSON.stringify({ tabs }) }] };
	}

	private handleGetWorkspaceFolders(): ToolResult {
		const vaultPath = this.getVaultPath();
		const vaultName = this.app.vault.getName();
		return {
			content: [{
				type: "text",
				text: JSON.stringify({
					success: true,
					folders: [{ name: vaultName, uri: "file://" + vaultPath, path: vaultPath }],
					rootPath: vaultPath,
				}),
			}],
		};
	}

	private handleOpenFile(params: Record<string, unknown>): ToolResult {
		const filePath = params.filePath as string | undefined;
		if (!filePath) throw new Error("Missing filePath parameter");

		const vaultPath = this.getVaultPath();
		// Resolve to vault-relative path
		let relative = filePath;
		if (filePath.startsWith(vaultPath)) {
			relative = filePath.slice(vaultPath.length).replace(/^\//, "");
		}

		const file = this.app.vault.getAbstractFileByPath(relative);
		if (!file || !(file instanceof TFile)) throw new Error("File not found: " + filePath);

		const makeFrontmost = params.makeFrontmost !== false;

		// Open the file (async, but we fire-and-forget since MCP expects sync response)
		const leaf = this.app.workspace.getLeaf(false);
		leaf.openFile(file).then(() => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;

			// Handle line-based selection
			if (params.startLine !== undefined) {
				const startLine = (params.startLine as number) - 1; // Convert to 0-based
				const endLine = ((params.endLine as number | undefined) ?? (params.startLine as number)) - 1;
				view.editor.setCursor({ line: startLine, ch: 0 });
				view.editor.setSelection(
					{ line: startLine, ch: 0 },
					{ line: endLine, ch: view.editor.getLine(endLine).length }
				);
				view.editor.scrollIntoView(
					{ from: { line: startLine, ch: 0 }, to: { line: endLine, ch: 0 } },
					true
				);
			}

			// Handle text-pattern selection
			if (params.startText !== undefined) {
				const content = view.editor.getValue();
				const startIdx = content.indexOf(params.startText as string);
				if (startIdx !== -1) {
					const startPos = view.editor.offsetToPos(startIdx);
					let endPos;
					if (params.endText !== undefined) {
						const endIdx = content.indexOf(params.endText as string, startIdx);
						if (endIdx !== -1) {
							endPos = view.editor.offsetToPos(endIdx + (params.endText as string).length);
						}
					}
					if (!endPos) {
						endPos = view.editor.offsetToPos(startIdx + (params.startText as string).length);
					}
					view.editor.setSelection(startPos, endPos);
					view.editor.scrollIntoView({ from: startPos, to: endPos }, true);
				}
			}
		});

		if (makeFrontmost) {
			return { content: [{ type: "text", text: "Opened file: " + filePath }] };
		}

		return {
			content: [{
				type: "text",
				text: JSON.stringify({
					success: true,
					filePath,
					languageId: "markdown",
					lineCount: 0, // Unknown until opened
				}),
			}],
		};
	}
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: ToolDef[] = [
	// --- Implemented tools ---
	{
		name: "getCurrentSelection",
		description: "Get the current text selection in the editor",
		inputSchema: { type: "object", additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
		handler: ClaudeCodeIdePlugin.prototype["handleGetCurrentSelection"] as any,
	},
	{
		name: "getLatestSelection",
		description: "Get the most recent text selection (even if not in the active editor)",
		inputSchema: { type: "object", additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
		handler: ClaudeCodeIdePlugin.prototype["handleGetLatestSelection"] as any,
	},
	{
		name: "getOpenEditors",
		description: "Get list of currently open files",
		inputSchema: { type: "object", additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
		handler: ClaudeCodeIdePlugin.prototype["handleGetOpenEditors"] as any,
	},
	{
		name: "getWorkspaceFolders",
		description: "Get all workspace folders currently open in the IDE",
		inputSchema: { type: "object", additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
		handler: ClaudeCodeIdePlugin.prototype["handleGetWorkspaceFolders"] as any,
	},
	{
		name: "openFile",
		description: "Open a file in the editor and optionally select a range of text",
		inputSchema: {
			type: "object",
			"$schema": "http://json-schema.org/draft-07/schema#",
			properties: {
				filePath: { type: "string", description: "Path to the file to open" },
				preview: { type: "boolean", description: "Whether to open the file in preview mode", default: false },
				startLine: { type: "integer", description: "Optional: Line number to start selection" },
				endLine: { type: "integer", description: "Optional: Line number to end selection" },
				startText: { type: "string", description: "Text pattern to find the start of the selection range." },
				endText: { type: "string", description: "Text pattern to find the end of the selection range." },
				selectToEndOfLine: { type: "boolean", default: false },
				makeFrontmost: { type: "boolean", default: true },
			},
			required: ["filePath"],
			additionalProperties: false,
		},
		handler: ClaudeCodeIdePlugin.prototype["handleOpenFile"] as any,
	},
	// --- Deferred / stubbed tools ---
	{
		name: "openDiff",
		description: "Open a diff view comparing old file content with new file content",
		inputSchema: {
			type: "object",
			"$schema": "http://json-schema.org/draft-07/schema#",
			properties: {
				old_file_path: { type: "string" },
				new_file_path: { type: "string" },
				new_file_contents: { type: "string" },
				tab_name: { type: "string" },
			},
			required: ["old_file_path", "new_file_path", "new_file_contents", "tab_name"],
			additionalProperties: false,
		},
		handler: (params) => ({
			content: [{ type: "text", text: "" }],
			deferred: true,
			unique_key: params.tab_name as string,
		}),
	},
	{
		name: "getDiagnostics",
		description: "Get language diagnostics (errors, warnings) from the editor",
		inputSchema: {
			type: "object",
			"$schema": "http://json-schema.org/draft-07/schema#",
			properties: { uri: { type: "string", description: "Optional file URI to get diagnostics for." } },
			additionalProperties: false,
		},
		handler: () => ({ content: [{ type: "text", text: "[]" }] }),
	},
	{
		name: "checkDocumentDirty",
		description: "Check if a document has unsaved changes (is dirty)",
		inputSchema: {
			type: "object",
			"$schema": "http://json-schema.org/draft-07/schema#",
			properties: { filePath: { type: "string", description: "Path to the file to check" } },
			required: ["filePath"],
			additionalProperties: false,
		},
		handler: (params) => ({
			content: [{ type: "text", text: JSON.stringify({ success: true, filePath: params.filePath, isDirty: false, isUntitled: false }) }],
		}),
	},
	{
		name: "saveDocument",
		description: "Save a document with unsaved changes",
		inputSchema: {
			type: "object",
			"$schema": "http://json-schema.org/draft-07/schema#",
			properties: { filePath: { type: "string", description: "Path to the file to save" } },
			required: ["filePath"],
			additionalProperties: false,
		},
		handler: (params) => ({
			content: [{ type: "text", text: JSON.stringify({ success: true, filePath: params.filePath, saved: false, message: "Not supported" }) }],
		}),
	},
	{
		name: "closeAllDiffTabs",
		description: "Close all diff tabs in the editor",
		inputSchema: { type: "object", additionalProperties: false, "$schema": "http://json-schema.org/draft-07/schema#" },
		handler: () => ({ content: [{ type: "text", text: "CLOSED_0_DIFF_TABS" }] }),
	},
];
