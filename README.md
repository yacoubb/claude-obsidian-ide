# Claude Code IDE for Obsidian

An Obsidian plugin that connects Claude Code CLI to your editor. Claude gets to see which file you have open and what text you've selected, the same way it does in VS Code.

Under the hood, it implements the [IDE integration protocol](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md) that the official VS Code extension and [claudecode.nvim](https://github.com/coder/claudecode.nvim) use.

## What it does

The plugin runs a local WebSocket server and writes a lock file to `~/.claude/ide/<port>.lock`. When Claude Code starts, it reads the lock file, connects, and starts receiving editor state.

Specifically:

- Your cursor position and text selection are broadcast to Claude on every change
- Claude can query which files you have open
- Claude can open files in Obsidian and jump to specific lines

## Tools

| Tool | What it does |
|------|-------------|
| `getCurrentSelection` | Returns the active file, cursor position, and selected text |
| `getLatestSelection` | Same, but persists across focus changes |
| `getOpenEditors` | Lists open tabs |
| `getWorkspaceFolders` | Returns the vault path |
| `openFile` | Opens a file, optionally jumping to a line or text pattern |

These are stubbed (no-op responses, for protocol compatibility): `getDiagnostics`, `checkDocumentDirty`, `saveDocument`, `closeAllDiffTabs`.

`openDiff` returns a deferred response, which causes Claude Code to fall back to the terminal approval prompt for edit requests.

## Installation

```bash
git clone https://github.com/<your-username>/claude-obsidian-ide.git
cd claude-obsidian-ide
npm install
bash install.sh /path/to/vault
```

This builds the plugin and copies it into your vault's plugin directory. Enable "Claude Code IDE" in Settings > Community plugins.

## Connecting Claude Code

Claude Code discovers the plugin through the `CLAUDE_CODE_SSE_PORT` environment variable. VS Code sets this automatically in its integrated terminal. Obsidian doesn't, so you need to pass it yourself.

### Shell helper (recommended)

Add this to `~/.zshrc` or `~/.bashrc`:

```zsh
claude-obsidian() {
  local f port pid
  for f in "$HOME/.claude/ide"/*.lock(N); do
    if grep -q '"Obsidian"' "$f" 2>/dev/null && grep -q "$PWD" "$f" 2>/dev/null; then
      port="${f:t:r}"
      pid=$(grep -o '"pid":[0-9]*' "$f" | grep -o '[0-9]*')
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        CLAUDE_CODE_SSE_PORT="$port" command claude "$@"
        return $?
      fi
    fi
  done
  echo "No Obsidian IDE server found for $PWD"
  command claude "$@"
}
```

Run `claude-obsidian` from your vault directory instead of `claude`.

The function scans lock files for one that matches `ideName: "Obsidian"` and your current directory, checks the Obsidian process is still alive, and passes the port to Claude Code. If no server is found, it falls back to a normal session.

### Manual

```bash
cat ~/.claude/ide/*.lock | grep Obsidian
# grab the port from the filename, then:
CLAUDE_CODE_SSE_PORT=<port> claude
```

## How it works

1. On load, the plugin picks a random port, starts a WebSocket server on `127.0.0.1`, and writes a lock file with the port, auth token, and vault path.
2. Claude Code reads the lock file, connects over WebSocket, and authenticates with the token via the `x-claude-code-ide-authorization` header.
3. The protocol is JSON-RPC 2.0 over WebSocket (MCP spec `2024-11-05`).
4. Selection tracking uses a CodeMirror 6 `EditorView.updateListener` for cursor/selection changes and Obsidian's `active-leaf-change` event for tab switches. Updates are debounced at 100ms.
5. On unload, everything is torn down and the lock file is removed.

## Development

```bash
npm run dev              # watch mode with source maps
npm run build            # production build
bash install.sh <vault>  # build + copy to vault
```

## Requirements

- Obsidian 1.4.11+
- Desktop only (needs Node.js APIs for the WebSocket server)

## Credits

Protocol docs and reference implementation from [coder/claudecode.nvim](https://github.com/coder/claudecode.nvim).

## License

MIT
