# Changelog

## 0.2.0

- Fix openDiff handler to return deferred response instead of DIFF_REJECTED, allowing edit approvals to fall back to the terminal prompt
- Add deploy.sh script for building and copying plugin to an Obsidian vault

## 0.1.0

- Initial release
- WebSocket MCP server exposing Obsidian editor state to Claude Code CLI
- Selection tracking with CM6 listener and active-leaf-change events
- Tools: getCurrentSelection, getLatestSelection, getOpenEditors, getWorkspaceFolders, openFile
- Lock file discovery for automatic CLI connection
- Auth token validation on WebSocket upgrade
