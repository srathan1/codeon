# Changelog

All notable changes to CodeOn are documented here.

## [0.1.1]

- Fix: "Configure Model" button (and the rest of the welcome-screen setup form) stopped responding after the first chat load/restore — event listeners were bound directly to elements that get replaced on every `loadMessages` call. Now wired via event delegation so it keeps working across reloads.

## [0.1.0]

Initial public release, renamed from an internal project ("Flexible Chat Interface").

- Always-on AI coding assistant for VS Code, built for self-hosted and OpenAI-compatible models (Ollama, LiteLLM, vLLM, and more) — no vendor lock-in
- 5 operational modes (Plan, Build, Code Review, Debug, Research) with a full tool system: file operations, git, process management, code intelligence (LSP, diagnostics, code actions), checkpoints, multi-agent orchestration, and MCP integration
- Policy engine with R0–R5 risk classes, per-tool approval, audit logging, and secret redaction
- Persistent chats with context compaction and automatic summarization
