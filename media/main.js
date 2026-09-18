// ============================================================
//  CodeOn — webview entry point (ES module)
//  utils/markdown/planModeBanner have been split into sibling
//  modules; the remaining sections (status, toolBlocks, chatList,
//  modelDropdown, composer, approval, retrievedContext,
//  messageRenderer, main) still live in this IIFE and are
//  extracted opportunistically as they get touched — see
//  NEW_FINDINGS_PRD.md's "media/main.js Split Recommendation".
// ============================================================
import { escHtml, isSafeUrl, formatJsonPreview, stripToolMarkupFromContent } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { showPlanModeBlocked, hidePlanModeBlocked, initPlanModeBanner } from './planModeBanner.js';

(function () {
    'use strict';

    // Default context window (tokens) pre-filled in the add/edit model forms
    // when the user hasn't set one. Mirrors DEFAULT_CONTEXT_WINDOW_SIZE in
    // src/provider/modelManager.ts (P6-T16 — context window is per-model now,
    // not a single global setting).
    const DEFAULT_CONTEXT_WINDOW_SIZE = 180000;

    // ============================================================
    //  Status indicator, typing, context ring, session stats, scrolling
    // ============================================================

    let _messagesArea = null;
    let _statusLine = null;
    let _statusDot = null;
    let _statusText = null;
    let _currentModeLabel = null;
    let _typingEl = null;

    /** Whether to auto-scroll on new content (mutable). */
    let autoScroll = true;

    /**
     * Initialise DOM references and attach the scroll listener.
     * L-8/dead-code cleanup: `charCount`/`emptyState` are accepted for
     * call-site compatibility but no longer stored — showEmpty/hideEmpty
     * re-query the DOM fresh instead of using cached refs, so the module-level
     * `_charCount`/`_emptyState` were write-only and have been removed.
     */
    function initStatus(messagesArea, statusLine, statusDot, statusText, _charCountUnused, _emptyStateUnused, currentModeLabel, getVscode, getMode) {
        _messagesArea = messagesArea;
        _statusLine = statusLine;
        _statusDot = statusDot;
        _statusText = statusText;
        _currentModeLabel = currentModeLabel;

        if (_messagesArea) {
            _messagesArea.addEventListener('scroll', () => {
                const atBottom = _messagesArea.scrollHeight - _messagesArea.clientHeight - _messagesArea.scrollTop < 30;
                autoScroll = atBottom;
            }, { passive: true });
        }

        // Click on error status to retry last message
        if (_statusLine) {
            _statusLine.addEventListener('click', () => {
                if (!_statusDot || _statusDot.className.indexOf('error') === -1) return;
                const allRows = _messagesArea.querySelectorAll('.msg-row .msg-avatar.user');
                if (allRows.length > 0) {
                    const lastUserRow = allRows[allRows.length - 1].closest('.msg-row');
                    const lastUserTextDiv = lastUserRow ? lastUserRow.querySelector('.msg-text') : null;
                    if (lastUserTextDiv) {
                        const lastText = lastUserTextDiv.textContent.trim();
                        _statusText.textContent = 'Retrying...';
                        getVscode().postMessage({ command: 'sendMessage', text: lastText, mode: getMode() });
                    }
                }
            });
        }
    }

    /** Rotating status quotes shown while AI is active. */
    const _activeQuotes = [
        'Hang on, just a min...',
        'Working on it...',
        'Cooking up something special...',
        'Weaving words together...',
        'Crunching tokens like nuts...',
        'Putting the puzzle pieces together...',
        'Almost there... maybe...',
        'Still figuring it out...',
        'Brewing ideas like coffee...',
        'Drafting thoughts at light speed...',
        'Connecting dots across dimensions...',
        'Mulling over options like a chef...',
        'Crafting the perfect reply...',
        'Deep in thought, send snacks...',
        'Tapping into the collective unconscious...',
        'Reticulating splines...',
        'Consulting the oracle...',
        'Aligning the stars...',
        'Negotiating with the language model...',
        'Generating response...',
        'Processing your request...',
        'Thinking through this...',
    ];
    let _activeQuoteIndex = 0;
    let _activeQuoteInterval = null;
    let _typewriterTimeout = null;
    let _typewriterTargetText = '';
    let _typewriterPos = 0;

    /** Start cycling through status quotes (idempotent). */
    function _startActiveQuotes(text) {
        if (_activeQuoteInterval) return; // already rotating
        _activeQuoteIndex = 0;
        if (text) {
            _typewriterTargetText = text;
            _typewriterPos = 0;
            if (_statusText) _statusText.textContent = '';
            _typeNextChar();
        }
        _activeQuoteInterval = setInterval(() => {
            _activeQuoteIndex = (_activeQuoteIndex + 1) % _activeQuotes.length;
            _typewriterTargetText = _activeQuotes[_activeQuoteIndex];
            _typewriterPos = 0;
            if (_statusText) _statusText.textContent = '';
            _typeNextChar();
        }, 5000);
    }

    /** Type the next character of the current target text. */
    function _typeNextChar() {
        if (!_statusText || _typewriterPos >= _typewriterTargetText.length) return;
        clearTimeout(_typewriterTimeout);
        _statusText.textContent = _typewriterTargetText.slice(0, _typewriterPos + 1);
        _typewriterPos++;
        _typewriterTimeout = setTimeout(_typeNextChar, 40);
    }

    /** Stop cycling status quotes. */
    function _stopActiveQuotes() {
        if (_activeQuoteInterval) {
            clearInterval(_activeQuoteInterval);
            _activeQuoteInterval = null;
        }
        clearTimeout(_typewriterTimeout);
    }

    /** Set the status dot colour + text. Auto-rotates quotes for 'active' state unless rotate=false. */
    function setStatus(state, text, rotate) {
        if (!_statusDot || !_statusText) return;
        _statusDot.className = 'status-dot ' + state;
        if (_statusLine) {
            if (state === 'error') {
                _statusLine.classList.add('error');
            } else {
                _statusLine.classList.remove('error');
            }
        }
        if (state === 'active' && rotate !== false) {
            _startActiveQuotes(text);
        } else {
            _stopActiveQuotes();
            _statusText.textContent = text || '';
        }
    }

    /** Show the typing indicator dots. */
    function showTyping() {
        if (_typingEl) return;
        if (!_messagesArea) return;

        const row = document.createElement('div');
        row.className = 'msg-row';
        row.id = 'typingIndicator';

        const avatar = document.createElement('div');
        avatar.className = 'msg-avatar ai';
        avatar.textContent = getAssistantInitials();

        const body = document.createElement('div');
        body.className = 'msg-body';

        const dots = document.createElement('div');
        dots.className = 'typing-dots';
        dots.innerHTML = '<span></span><span></span><span></span>';

        body.appendChild(dots);

        // Stop button next to typing dots. Posts stopGeneration directly (same
        // message the composer's own Stop button sends) instead of calling an
        // `onStopGeneration` callback — that identifier is only a local
        // parameter inside initComposer(), a different function; referenced
        // from here (a sibling top-level function) it was always undefined,
        // so `typeof onStopGeneration === 'function'` silently evaluated to
        // false and the click did nothing.
        const typeStopBtn = document.createElement('button');
        typeStopBtn.className = 'typing-stop-btn';
        typeStopBtn.innerHTML = '&#x23F9;'; // ⏹ stop icon
        typeStopBtn.title = 'Stop generation';
        typeStopBtn.addEventListener('click', () => {
            const vs = (typeof vscode !== 'undefined' && vscode && typeof vscode.postMessage === 'function')
                ? vscode
                : window.__vscode_api;
            if (vs && typeof vs.postMessage === 'function') {
                vs.postMessage({ command: 'stopGeneration' });
            }
        });
        body.appendChild(typeStopBtn);

        row.appendChild(avatar);
        row.appendChild(body);
        _messagesArea.appendChild(row);
        _typingEl = row;
        scrollToBottom();
    }

    /** Remove the typing indicator. */
    function removeTyping() {
        if (_typingEl) {
            _typingEl.remove();
            _typingEl = null;
        }
    }

    /** Update the mode label text and the mode indicator bar. */
    function updateModeLabel(mode) {
        if (!_currentModeLabel) return;
        const labels = {
            'plan': 'Plan',
            'build': 'Build',
            'code-review': 'Review',
            'debug': 'Debug',
            'research': 'Research'
        };
        _currentModeLabel.textContent = labels[mode] || mode;

        // Update top bar brand (mode dot + label)
        const topBar = document.getElementById('topBar');
        const brandLabel = document.getElementById('brandLabel');
        if (topBar) topBar.setAttribute('data-mode', mode);
        if (brandLabel) brandLabel.textContent = labels[mode] || mode;
    }

    /** Show the empty / welcome state. */
    function showEmpty() {
        const el = _messagesArea ? _messagesArea.querySelector('#emptyState') : null;
        if (el) el.style.display = 'flex';
    }

    /** Hide the empty / welcome state. */
    function hideEmpty() {
        const el = _messagesArea ? _messagesArea.querySelector('#emptyState') : null;
        if (el) el.style.display = 'none';
    }

    /** Scroll the messages area to the bottom. */
    function scrollToBottom(force) {
        if (!_messagesArea) return;
        requestAnimationFrame(() => {
            if (!autoScroll && !force) return;
            _messagesArea.scrollTop = _messagesArea.scrollHeight;
        });
    }

    /** Format a token count for display (e.g. 1234 → "1.2k"). */
    function formatTokens(n) {
        if (n >= 1000) {
            return (n / 1000).toFixed(1) + 'k';
        }
        return n.toString();
    }

    /** Format a duration in ms as e.g. "0.8s", "12.4s". */
    function formatDuration(ms) {
        return (ms / 1000).toFixed(1) + 's';
    }

    /** Small "12.4s · 3.2k tok" caption shown under a finished AI response
     * (replaces the old cumulative session-stats line that lived in the
     * composer — per-turn info in context is more useful than a running
     * total that was never actionable there). Returns null if there's
     * nothing to show. */
    function createStatsCaption(durationMs, tokens) {
        if (!(durationMs > 0)) return null;
        const parts = [formatDuration(durationMs)];
        if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
        const el = document.createElement('div');
        el.className = 'msg-stats-caption';
        el.textContent = parts.join(' · ');
        return el;
    }

    /** Update the context-ring SVG gauge + tooltip data. */
    function updateContextRing(used, limit, msgCount, summaryCount) {
        const ring = document.getElementById('contextRingProgress');
        const label = document.getElementById('contextRingLabel');
        if (!ring) return;

        const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
        const circumference = 2 * Math.PI * 15.915; // ~100
        const dashLen = (pct / 100) * circumference;

        ring.setAttribute('stroke-dasharray', `${dashLen} ${circumference}`);

        // Color based on usage
        let color = 'var(--vscode-editorInfo-foreground, #3794ff)';
        if (pct > 90) color = 'var(--vscode-editorError-foreground, #f48771)';
        else if (pct > 70) color = 'var(--vscode-editorWarning-foreground, #d7ba7d)';
        ring.setAttribute('stroke', color);

        // Show percentage inside ring only at high usage (hides clutter)
        if (label) {
            if (pct > 30) {
                label.textContent = Math.round(pct) + '%';
                label.style.color = color;
            } else {
                label.textContent = '';
            }
        }

        // Update tooltip — single summary line
        const usageLine = document.getElementById('ctxUsageLine');
        if (usageLine) {
            usageLine.textContent = `${formatTokens(used || 0)} / ${formatTokens(limit || 0)} tokens used`;
        }
    }

    /** Show/hide the expand history button based on whether a transcript exists. */
    function updateExpandHistoryButton(hasTranscript) {
        const btn = document.getElementById('expandHistoryBtn');
        if (!btn) return;
        btn.style.display = hasTranscript ? '' : 'none';
    }

    /** Update the session stats pill. */
    function updateSessionStats(requestCount, totalTokens, avgLatencyMs, errorCount) {
        let statsEl = document.getElementById('sessionStats');
        if (!statsEl) return;
        if (requestCount === 0) {
            statsEl.textContent = '';
            return;
        }
        const parts = [];
        parts.push(`${requestCount} req`);
        parts.push(`${formatTokens(totalTokens)} tok`);
        if (avgLatencyMs > 0) parts.push(`${avgLatencyMs}ms`);
        if (errorCount > 0) parts.push(`${errorCount} err`);
        statsEl.textContent = parts.join(' · ');
    }

    // ============================================================
    //  Tool block rendering (add / update)
    // ============================================================

    /** Mutable map: toolId → DOM element. */
    let toolBlocksMap = {};

    /** Tools that should render in compact (summary-only) mode. */
    const compactTools = new Set([
        'read_file', 'list_dir', 'grep_search', 'glob',
        'list_directory', 'web_fetch', 'apply_patch',
        'search_files', 'execute_command', 'write_file', 'edit_file'
    ]);

    /** Tools that mutate files — eligible for "Show Diff" button. */
    const fileMutationTools = new Set(['apply_patch', 'write_file', 'edit_file']);

    /** Parse "+12 -3" from tool output header and render as colored badges. */
    function addLineDiffBadge(block, output) {
        // Remove any existing badge
        const existing = block.querySelector('.line-diff-badge');
        if (existing) existing.remove();

        // Extract diff pattern from first line of output
        const m = output.match(/\+([\d]+)\s+-([\d]+)/);
        if (!m) return;
        const added = parseInt(m[1]);
        const removed = parseInt(m[2]);
        if (added === 0 && removed === 0) return;

        const badge = document.createElement('span');
        badge.className = 'line-diff-badge';
        let html = '';
        if (added > 0) html += `<span class="diff-added">+${added}</span>`;
        if (removed > 0) html += `<span class="diff-removed">-${removed}</span>`;
        badge.innerHTML = html;

        const header = block.querySelector('.tool-header');
        if (header) header.appendChild(badge);
    }

    /** Render tool output with highlighted diff lines (+ green, - red). */
    function renderDiffOutput(output) {
        const lines = output.split('\n');
        let inDiff = false;
        return lines.map(line => {
            if (line.startsWith('--- ') || line.startsWith('+++ ')) {
                inDiff = true;
                return `<span class="diff-filename">${escHtml(line)}</span>`;
            }
            if (line.startsWith('@@')) {
                inDiff = true;
                return `<span class="diff-hunk">${escHtml(line)}</span>`;
            }
            if (inDiff && line.startsWith('+')) {
                return `<span class="diff-added-line">${escHtml(line)}</span>`;
            }
            if (inDiff && line.startsWith('-')) {
                return `<span class="diff-removed-line">${escHtml(line)}</span>`;
            }
            if (inDiff && line.startsWith(' ')) {
                return `<span class="diff-context">${escHtml(line)}</span>`;
            }
            // Non-diff lines (headers like "File updated: ...")
            return escHtml(line);
        }).join('\n');
    }

    /** Check if a summary string looks like a file path (not a command or pattern). */
    function isFilePath(summary) {
        if (!summary) return false;
        // File paths typically contain a dot (extension) or start with ./ or have /
        return /(\.|\/|\\)/.test(summary) && !summary.includes(' ') && !summary.startsWith('^') && !summary.includes('|');
    }

    /** Create and append a tool-block element. */
    function addToolBlock(toolId, name, argsStr, messagesArea, scrollToBottomFn) {
        const isCompact = compactTools.has(name);
        const block = document.createElement('div');
        block.className = `tool-block running${isCompact ? ' compact' : ''}`;
        block.id = 'tool-' + toolId;

        let argsObj = {};
        let summary = '';
        try {
            argsObj = JSON.parse(argsStr || '{}');
            // Build a descriptive summary from args
            if (argsObj.path) summary = argsObj.path;
            else if (argsObj.file_path || argsObj.filePath) summary = argsObj.file_path || argsObj.filePath;
            else if (argsObj.command) summary = argsObj.command.slice(0, 80);
            else if (argsObj.pattern) summary = argsObj.pattern;
            else {
                const keys = Object.keys(argsObj);
                if (keys.length > 0) {
                    const firstVal = argsObj[keys[0]];
                    summary = typeof firstVal === 'string' ? firstVal.slice(0, 80) : JSON.stringify(firstVal).slice(0, 80);
                }
            }
        } catch {}

        // Icon per tool type
        const toolIcons = {
            read_file: '📄', list_dir: '📁', search_files: '🔍', grep_search: '🔍',
            apply_patch: '✏️', execute_command: '⚙️', glob: '🔎', web_fetch: '🌐',
            write_file: '📝'
        };
        const icon = toolIcons[name] || '🔧';

        const filePathSummary = isFilePath(summary) ? summary : '';
        const summaryHtml = summary
            ? filePathSummary
                ? `<span class="tool-summary clickable" title="Click to open file">${escHtml(summary)}</span>`
                : `<span class="tool-summary">${escHtml(summary)}</span>`
            : '';

        if (isCompact) {
            block.innerHTML = `
                <div class="tool-header">
                    <span class="tool-icon">${icon}</span>
                    <span class="tool-name">${escHtml(name)}</span>
                    ${summaryHtml}
                    <span class="tool-status-icon">\u27ef</span>
                </div>
                <div class="tool-body"></div>
            `;
            // Store the original file path for later use (diff button, etc.)
            if (filePathSummary) block.dataset.filePath = filePathSummary;

            // Click to expand compact blocks after they have content
            block.querySelector('.tool-header').addEventListener('click', (e) => {
                // If clicking a clickable file path, open it instead of toggling
                if (e.target.classList.contains('clickable')) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'openFile', relPath: filePathSummary });
                    return;
                }
                const body = block.querySelector('.tool-body');
                if (body.classList.contains('has-content')) {
                    body.classList.toggle('visible');
                }
            });
        } else {
            const formattedJson = formatJsonPreview(argsStr);
            block.innerHTML = `
                <div class="tool-header">
                    <span class="tool-chevron open">\u25b6</span>
                    <span class="tool-name">${escHtml(name)}</span>
                    ${summaryHtml}
                    <span class="tool-status-icon">\u27ef</span>
                </div>
                <div class="tool-body visible"><pre>${formattedJson}</pre></div>
            `;
            if (filePathSummary) block.dataset.filePath = filePathSummary;

            block.querySelector('.tool-header').addEventListener('click', (e) => {
                if (e.target.classList.contains('clickable')) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'openFile', relPath: filePathSummary });
                    return;
                }
                const body = block.querySelector('.tool-body');
                const chevron = block.querySelector('.tool-chevron');
                body.classList.toggle('visible');
                chevron.classList.toggle('open');
            });
        }

        messagesArea.appendChild(block);
        toolBlocksMap[toolId] = block;
        scrollToBottomFn();
    }

    /** Update an existing tool block with output / result. */
    function updateToolBlock(toolId, output, success, error, scrollToBottomFn, autoApprovedBy) {
        const block = toolBlocksMap[toolId];
        if (!block) return;
        block.className = block.className.replace(/\brunning\b/, '') + ` ${success ? 'success' : 'error'}`;
        block.querySelector('.tool-status-icon').textContent = success ? '\u2713' : '\u2717';

        // Show auto-approved badge when tool was bypassed by session/workspace rule
        if (autoApprovedBy && !block.querySelector('.auto-approved-badge')) {
            const badge = document.createElement('span');
            badge.className = 'auto-approved-badge';
            badge.title = autoApprovedBy === 'session'
                ? 'Auto-approved for this session'
                : 'Always allowed in this workspace';
            badge.textContent = autoApprovedBy === 'session' ? '\u2705 Session' : '\u2705 Workspace';
            const header = block.querySelector('.tool-header');
            if (header) header.appendChild(badge);
        }
        const body = block.querySelector('.tool-body');
        if (body) {
            // For compact tools, show truncated output in the body (hidden by default)
            const isCompact = block.classList.contains('compact');
            if (isCompact && output && !error) {
                // Store full output, show preview hint
                const lines = output.split('\n').length;

                // For file mutation tools, render diff-highlighted output
                const toolName = block.querySelector('.tool-name')?.textContent || '';
                const isFileMutation = fileMutationTools.has(toolName);

                if (isFileMutation && success) {
                    // Extract old content from the unified diff for "Show Diff"
                    // The output format is: "File updated: path (+N -M)\n\nBefore hash: ...\nAfter hash: ...\n\n--- a/path\n+++ b/path\n@@ ..."
                    const diffContent = extractDiffWithOldContent(output);
                    body.innerHTML = `<pre>${renderDiffOutput(output)}</pre>`;
                    if (diffContent.oldContent !== '') {
                        block.dataset.oldContent = diffContent.oldContent;
                    }
                } else {
                    body.textContent = output;
                }

                body.classList.add('has-content');
                // Update summary to show size info + line diff badges
                const summaryEl = block.querySelector('.tool-summary');
                if (summaryEl && lines > 3) {
                    const existing = summaryEl.textContent;
                    // For file mutation tools, skip the "(N lines)" hint — the +N/-M badge is accurate enough
                    if (!isFileMutation) {
                        // For list_dir, show item count instead of line count
                        let hint = `${lines} lines`;
                        try {
                            const parsed = JSON.parse(output);
                            if (Array.isArray(parsed)) {
                                const dirs = parsed.filter(e => e.is_directory).length;
                                const files = parsed.length - dirs;
                                hint = `${files} file${files !== 1 ? 's' : ''}, ${dirs} dir${dirs !== 1 ? 's' : ''}`;
                            }
                        } catch {}
                        summaryEl.textContent = existing + ` (${hint})`;
                    }
                }
                // Show line diff badge from output header (e.g. "+12 -3")
                addLineDiffBadge(block, output);

                // Add "Show Diff" button for successful file mutations
                if (isFileMutation && success) {
                    addDiffButton(block, toolName);
                }
            } else {
                body.classList.add('visible');
                body.innerHTML = error ? `<span class="error-text">Error: ${escHtml(error)}</span>` : escHtml(output || '');
            }
        }
        const chevron = block.querySelector('.tool-chevron');
        if (chevron) chevron.classList.add('open');
        scrollToBottomFn();
    }

    /** Extract old content from a unified diff in tool output.
     * Reconstructs pre-edit content by replaying the diff in reverse.
     * For "Show Diff" we only need the old content as a whole file —
     * VS Code comparison view works on full files, not patches.
     */
    function extractDiffWithOldContent(output) {
        const lines = output.split('\n');
        const oldLines = [];
        let inDiff = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('--- ') || line.startsWith('+++ ')) {
                inDiff = true;
                continue;
            }
            if (!line.startsWith('@@')) {
                if (!inDiff) continue;
            }
            if (line.startsWith('@@')) {
                inDiff = true;
                continue;
            }
            if (!inDiff) continue;

            if (line.startsWith('+')) {
                // Added line — not in old content, skip
            } else if (line.startsWith('-')) {
                // Removed line — was in old content
                oldLines.push(line.slice(1));
            } else if (line.startsWith(' ')) {
                // Context line — in both
                oldLines.push(line.slice(1));
            } else {
                // End of diff (e.g., blank line followed by non-diff content)
                if (line === '') {
                    // Could be end of diff or empty context; keep going
                    continue;
                }
            }
        }

        return { oldContent: oldLines.join('\n') };
    }

    /** Add a small "diff" icon button next to the line diff badge. */
    function addDiffButton(block, toolName) {
        // Avoid duplicates
        if (block.querySelector('.diff-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'diff-btn';
        btn.textContent = '\u{1f4cf}';  // 📏 chart/compare icon
        btn.title = 'Show Diff';

        const header = block.querySelector('.tool-header');
        if (header) header.appendChild(btn);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const relPath = block.dataset.filePath || '';
            const oldContent = block.dataset.oldContent || '';
            if (relPath && oldContent) {
                vscode.postMessage({
                    command: 'showDiff',
                    relPath: relPath,
                    oldContent: oldContent
                });
            }
        });
    }

    // ============================================================
    //  Chat list rendering
    // ============================================================

    /** Format a timestamp into a relative / short string. */
    function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        const diff = now - d;

        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';

        const month = d.getMonth() + 1;
        const day = d.getDate();
        const hour = d.getHours().toString().padStart(2, '0');
        const min = d.getMinutes().toString().padStart(2, '0');
        return `${month}/${day} ${hour}:${min}`;
    }

    /** Clear and rebuild the chat list DOM. */
    function renderChatList(chats, activeId, chatList, vscode, chatListPanel) {
        chatList.innerHTML = '';

        if (!chats || chats.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chat-list-empty';
            empty.style.cssText = 'padding:12px 8px;color:var(--vscode-descriptionForeground,#858585);font-size:12px;text-align:center;';
            empty.textContent = 'No chats yet — click + to start one';
            chatList.appendChild(empty);
            return;
        }

        // Group by workspace label
        const groups = new Map();
        for (const chat of chats) {
            const ws = chat.workspaceLabel || '';
            if (!groups.has(ws)) groups.set(ws, []);
            groups.get(ws).push(chat);
        }

        // Determine which workspace owns the active chat
        const currentWorkspace = (() => {
            for (const chat of chats) {
                if (chat.id === activeId) return chat.workspaceLabel || '';
            }
            return null;
        })();

        // Render collapsible workspace groups
        groups.forEach((groupChats, wsLabel) => {
            const isCurrent = wsLabel === currentWorkspace;
            const isEmpty = groupChats.length === 0;
            const collapsed = !isCurrent && !isEmpty; // Collapse non-current workspaces that have chats

            // Workspace header (clickable toggle)
            const header = document.createElement('div');
            header.className = 'chat-workspace-header' + (isCurrent ? ' chat-workspace-header-current' : '');
            header.style.cursor = 'pointer';

            const chevron = document.createElement('span');
            chevron.className = 'chat-ws-chevron';
            chevron.textContent = collapsed ? '\u25B6' : '\u25BC'; // ▶ collapsed, ▼ expanded
            chevron.style.fontSize = '9px';
            chevron.style.marginRight = '4px';
            chevron.style.transition = 'transform 0.15s';

            const labelSpan = document.createElement('span');
            labelSpan.textContent = wsLabel || 'Global';
            labelSpan.style.flex = '1';

            const countBadge = document.createElement('span');
            countBadge.className = 'chat-ws-count';
            countBadge.textContent = groupChats.length;
            countBadge.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground,#858585);margin-left:4px;';

            header.appendChild(chevron);
            header.appendChild(labelSpan);
            header.appendChild(countBadge);
            chatList.appendChild(header);

            // Chat container for this workspace
            const container = document.createElement('div');
            container.className = 'chat-ws-group';
            if (collapsed) container.style.display = 'none';

            if (isEmpty) {
                // Show home hint for workspaces with no chats
                const homeHint = document.createElement('div');
                homeHint.className = 'chat-ws-home';
                homeHint.style.cssText = 'padding:8px 12px 4px;font-size:11px;color:var(--vscode-descriptionForeground,#858585);text-align:center;cursor:pointer;';
                homeHint.textContent = '+ New chat here';
                homeHint.addEventListener('click', () => {
                    if (chatListPanel) chatListPanel.style.display = 'none';
                    vscode.postMessage({ command: 'newChat' });
                });
                container.appendChild(homeHint);
            } else {
                groupChats.forEach(chat => {
                    const item = document.createElement('div');
                    item.className = 'chat-item' + (chat.id === activeId ? ' active' : '');

                    const left = document.createElement('div');
                    left.className = 'chat-item-left';

                    const singleLine = document.createElement('div');
                    singleLine.className = 'chat-item-oneliner';

                    const modeDot = document.createElement('span');
                    modeDot.className = 'chat-item-mode-dot';
                    const chatMode = chat.mode || 'plan';
                    if (chatMode === 'build' || chatMode === 'debug') {
                        modeDot.style.color = '#4ec9b0';
                    } else if (chatMode === 'plan') {
                        modeDot.style.color = '#dcdcaa';
                    } else {
                        modeDot.style.color = '#569cd6';
                    }
                    modeDot.textContent = '\u2022 ';

                    const title = document.createElement('span');
                    title.className = 'chat-item-title';
                    title.textContent = chat.title || 'New Chat';

                    const time = document.createElement('span');
                    time.className = 'chat-item-time';
                    time.textContent = formatTime(chat.updatedAt);

                    singleLine.appendChild(modeDot);
                    singleLine.appendChild(title);
                    singleLine.appendChild(time);
                    left.appendChild(singleLine);

                    const del = document.createElement('button');
                    del.className = 'chat-item-delete';
                    del.textContent = '\u00d7';
                    del.title = 'Delete chat';
                    del.addEventListener('click', e => {
                        e.stopPropagation();
                        e.preventDefault();
                        showConfirmDialog('Delete Chat', 'Delete this chat? This cannot be undone.', () => {
                            vscode.postMessage({ command: 'deleteChat', chatId: chat.id });
                        });
                    });

                    item.appendChild(left);
                    item.appendChild(del);

                    item.addEventListener('click', () => {
                        // Auto-hide chat list on selection
                        if (chatListPanel) chatListPanel.style.display = 'none';
                        vscode.postMessage({ command: 'switchChat', chatId: chat.id });
                    });

                    item.addEventListener('dblclick', e => {
                        if (del.contains(e.target)) return;
                        const newName = prompt('Rename chat:', chat.title);
                        if (newName && newName.trim()) {
                            vscode.postMessage({ command: 'renameChat', chatId: chat.id, title: newName.trim() });
                        }
                    });

                    container.appendChild(item);
                });
            }

            chatList.appendChild(container);

            // Toggle collapse on header click
            header.addEventListener('click', () => {
                const isCollapsed = container.style.display === 'none';
                container.style.display = isCollapsed ? '' : 'none';
                chevron.textContent = isCollapsed ? '\u25BC' : '\u25B6';
            });
        });
    }

    // ============================================================
    //  Model dropdown
    // ============================================================

    // --- Shared mutable state ---
    let addModelFormVisible = false;
    let editModelFormVisible = false;
    let modelProvidersCache = {};
    let modelsCache = [];

    /** Show a confirmation dialog (replaces native confirm() which is blocked in sandboxed webviews). */
    function showConfirmDialog(title, message, onConfirm) {
        // Remove existing dialog if any
        const existing = document.getElementById('confirmDialogOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'confirmDialogOverlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 10000;
            display: flex; align-items: center; justify-content: center;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: var(--vscode-editor-background, #1e1e1e);
            border: 1px solid var(--vscode-editorWidget-border, #454545);
            border-radius: 8px; padding: 20px; min-width: 360px; max-width: 480px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        `;

        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText = `
            font-size: 14px; font-weight: 600; color: var(--vscode-foreground, #cccccc);
            margin-bottom: 10px;
        `;

        const msgEl = document.createElement('div');
        msgEl.textContent = message;
        msgEl.style.cssText = `
            font-size: 13px; color: var(--vscode-descriptionForeground, #858585);
            white-space: pre-wrap; line-height: 1.5; margin-bottom: 18px;
        `;

        const btnRow = document.createElement('div');
        btnRow.style.cssText = `display: flex; gap: 8px; justify-content: flex-end;`;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            padding: 4px 16px; border-radius: 4px; font-size: 13px; cursor: pointer;
            background: var(--vscode-button-secondaryBackground, #313131);
            color: var(--vscode-button-secondaryForeground, #cccccc);
            border: 1px solid var(--vscode-editorWidget-border, #454545);
        `;
        cancelBtn.addEventListener('click', () => overlay.remove());

        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = `
            padding: 4px 16px; border-radius: 4px; font-size: 13px; cursor: pointer;
            background: #c42b1d; color: #fff; border: none;
        `;
        okBtn.addEventListener('click', () => { overlay.remove(); onConfirm(); });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        dialog.appendChild(titleEl);
        dialog.appendChild(msgEl);
        dialog.appendChild(btnRow);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Close on overlay click (not dialog click)
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.remove();
        });

        // Focus OK button
        okBtn.focus();
    }

    /** Group models by provider and render dropdown options with edit icons. */
    function renderModelDropdown(providers, models, currentModel, modelDropdown) {
        modelProvidersCache = providers || {};
        modelsCache = models || [];

        // Remove existing dynamic model options (preserve "Add Model" button)
        modelDropdown.querySelectorAll('.model-option:not([data-action="add"]), .model-provider-group').forEach(el => el.remove());
        hideAddModelForm();

        // Don't re-add current model if it's not in the saved list — it was likely deleted
        // Only show it if it has a known provider
        const currentProvider = providers && Object.keys(providers).length > 0
            ? (models.find(m => m.name === currentModel)?.provider || models[0]?.provider)
            : null;
        if (currentModel && currentProvider && !models.some(m => m.name === currentModel)) {
            models = [{ name: currentModel, provider: currentProvider }, ...models];
        }

        // Group models by provider
        const grouped = {};
        models.forEach(m => {
            const p = m.provider || 'Default';
            if (!grouped[p]) grouped[p] = [];
            grouped[p].push(m);
        });

        const addBtn = modelDropdown.querySelector('[data-action="add"]');
        const providerCount = Object.keys(grouped).length;

        // Only show "Reset All" if there are models to reset
        if (models.length > 0) {
            let resetBtn = modelDropdown.querySelector('[data-action="reset"]');
            if (!resetBtn) {
                resetBtn = document.createElement('div');
                resetBtn.setAttribute('data-action', 'reset');
                resetBtn.className = 'model-option';
                resetBtn.style.borderTop = '1px solid var(--vscode-editorWidget-border, #454545)';
                resetBtn.style.color = '#f44747';
                resetBtn.style.fontWeight = '600';
                resetBtn.style.justifyContent = 'center';
                resetBtn.textContent = 'Reset All Models';
                resetBtn.style.cursor = 'pointer';
                resetBtn.style.padding = '8px 12px';
                resetBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    showConfirmDialog(
                        'Reset All Models',
                        'Delete ALL saved models and providers?\nYou will need to re-add your model.',
                        () => vscode.postMessage({ command: 'resetAllModels' })
                    );
                });
                modelDropdown.appendChild(resetBtn);
            }
        }

        Object.keys(grouped).sort().forEach(providerName => {
            const groupModels = grouped[providerName];

            // Always show provider group header with delete button when there are models
            const groupRow = document.createElement('div');
            groupRow.className = 'model-provider-group';
            groupRow.style.display = 'flex';
            groupRow.style.alignItems = 'center';
            groupRow.style.justifyContent = 'space-between';
            groupRow.style.gap = '4px';

            const labelSpan = document.createElement('span');
            labelSpan.textContent = providerName;
            labelSpan.style.overflow = 'hidden';
            labelSpan.style.textOverflow = 'ellipsis';
            labelSpan.style.whiteSpace = 'nowrap';

            const delIcon = document.createElement('span');
            delIcon.className = 'model-option-edit';
            delIcon.textContent = '\u{1F5D1}';  // 🗑 trash
            delIcon.title = `Delete "${providerName}" and its ${groupModels.length} model(s)`;
            delIcon.style.color = '#f44747';
            delIcon.style.cursor = 'pointer';
            delIcon.style.flexShrink = '0';
            delIcon.addEventListener('click', e => {
                e.stopPropagation();
                showConfirmDialog(
                    `Delete "${providerName}"`,
                    `Delete this provider and its ${groupModels.length} model(s)?`,
                    () => vscode.postMessage({ command: 'deleteProvider', providerName })
                );
            });

            groupRow.appendChild(labelSpan);
            groupRow.appendChild(delIcon);
            if (addBtn) modelDropdown.insertBefore(groupRow, addBtn);
            else modelDropdown.appendChild(groupRow);

            groupModels.forEach(m => {
                const opt = createModelOption(m, providerName, currentModel, providerCount > 1);
                if (addBtn) modelDropdown.insertBefore(opt, addBtn);
                else modelDropdown.appendChild(opt);
            });
        });
    }

    /** Create a model dropdown option with edit icon. */
    function createModelOption(m, providerName, currentModel, showProvider) {
        const opt = document.createElement('div');
        opt.className = 'model-option' + (m.name === currentModel ? ' active' : '');

        const labelSpan = document.createElement('span');
        labelSpan.className = 'model-option-label';
        const displayName = m.nickname || m.name;
        labelSpan.textContent = displayName + (showProvider ? ` (${providerName})` : '');
        if (m.nickname) {
            labelSpan.title = m.name;
        }

        // Click on the entire option row switches the model
        opt.addEventListener('click', (e) => {
            if (e.target.classList.contains('model-option-edit')) return;
            vscode.postMessage({ command: 'switchModel', modelName: m.name, providerName: m.provider });
        });
        opt.appendChild(labelSpan);

        // Edit icon (pencil) — opens provider config for editing (includes delete)
        const editIcon = document.createElement('span');
        editIcon.className = 'model-option-edit';
        editIcon.textContent = '\u270E';  // ✎ pencil
        editIcon.title = 'Edit / Delete model';
        editIcon.addEventListener('click', e => {
            e.stopPropagation();
            showEditProviderForm(m.name, m.provider, modelSelectorEl, vscode, modelProvidersCache);
        });
        opt.appendChild(editIcon);

        return opt;
    }

    /** Hide and remove the add model form. */
    function hideAddModelForm() {
        addModelFormVisible = false;
        editModelFormVisible = false;
        const form = document.getElementById('addModelForm');
        if (form) form.remove();
    }

    /** Show form to edit model name + provider details. */
    function showEditProviderForm(modelName, providerName, modelDropdown, vscode, modelProvidersCacheRef) {
        const cache = modelProvidersCacheRef || modelProvidersCache;
        if (addModelFormVisible || editModelFormVisible) return;
        editModelFormVisible = true;

        // Remove existing form if any
        hideAddModelForm();

        const provider = cache[providerName] || {};

        const form = document.createElement('div');
        form.id = 'addModelForm';
        form.className = 'add-model-form';
        const existingModel = modelsCache.find(mm => mm.name === modelName && mm.provider === providerName) || {};
        const existingNickname = existingModel.nickname || '';
        const existingContextWindow = existingModel.contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE;
        form.innerHTML = `
            <div class="add-model-field">
                <label class="add-model-label">Model</label>
                <input type="text" id="editModelName" value="${escHtml(modelName)}" placeholder="Model name" autocomplete="off"/>
            </div>
            <div class="add-model-field">
                <label class="add-model-label">Nickname (optional)</label>
                <input type="text" id="editModelNickname" value="${escHtml(existingNickname)}" placeholder="e.g. Jarvis, Copilot" autocomplete="off"/>
            </div>
            <div class="add-model-field">
                <label class="add-model-label">Context window (tokens)</label>
                <input type="number" id="editModelContextWindow" value="${existingContextWindow}" min="1000" step="1000" placeholder="180000" autocomplete="off"/>
            </div>
            <div class="add-model-field">
                <label class="add-model-label">Provider</label>
                <select id="editProviderSelect">
                    ${Object.keys(cache).sort().map(p => `<option value="${escHtml(p)}"${p === providerName ? ' selected' : ''}>${escHtml(p)}</option>`).join('')}
                    <option value="__new__">+ New Provider...</option>
                </select>
            </div>
            <div class="add-model-field provider-fields" id="editProviderFields" style="display:none;">
                <input type="text" id="editNewProviderName" placeholder="Provider name" autocomplete="off"/>
                <input type="text" id="editNewProviderEndpoint" placeholder="Endpoint URL" autocomplete="off"/>
                <input type="password" id="editNewProviderApiKey" placeholder="API key" autocomplete="off"/>
            </div>
            <div class="add-model-field provider-fields" id="editExistingProviderFields">
                <label class="add-model-label">${escHtml(providerName)} details</label>
                <input type="text" id="editProviderEndpoint" placeholder="Endpoint URL" value="${escHtml(provider.endpoint || '')}" autocomplete="off"/>
                <input type="password" id="editProviderApiKey" placeholder="API key (leave blank to keep)" autocomplete="off"/>
            </div>
            <div class="add-model-actions">
                <button class="action-btn-sm" id="cancelEditProvider">Cancel</button>
                <button class="action-btn-sm danger" id="deleteEditModel" title="Delete this model">\u{1F5D1}</button>
                <button class="action-btn-sm primary" id="confirmEditProvider">Save</button>
            </div>
        `;
        modelDropdown.appendChild(form);

        const select = document.getElementById('editProviderSelect');
        const newFields = document.getElementById('editProviderFields');
        const existingFields = document.getElementById('editExistingProviderFields');

        function toggleProviderFields() {
            const isNew = select.value === '__new__';
            newFields.style.display = isNew ? '' : 'none';
            existingFields.style.display = isNew ? 'none' : '';
        }
        select.addEventListener('change', toggleProviderFields);

        document.getElementById('cancelEditProvider').addEventListener('click', hideAddModelForm);

        // Delete model (with confirmation)
        document.getElementById('deleteEditModel').addEventListener('click', () => {
            showConfirmDialog(
                `Delete "${modelName}"`,
                `Remove this model from your saved list?`,
                () => vscode.postMessage({
                    command: 'deleteModel',
                    modelName,
                    providerName
                })
            );
        });

        document.getElementById('confirmEditProvider').addEventListener('click', () => {
            const newModelName = (document.getElementById('editModelName')?.value || '').trim();
            if (!newModelName) return;

            let targetProvider = select.value;
            let providerEndpoint = '';
            let providerApiKey = '';

            if (targetProvider === '__new__') {
                targetProvider = (document.getElementById('editNewProviderName')?.value || '').trim() || newModelName;
                providerEndpoint = (document.getElementById('editNewProviderEndpoint')?.value || '').trim();
                providerApiKey = (document.getElementById('editNewProviderApiKey')?.value || '').trim();
            } else {
                providerEndpoint = (document.getElementById('editProviderEndpoint')?.value || '').trim();
                providerApiKey = (document.getElementById('editProviderApiKey')?.value || '').trim();
            }

            const rawNickname = (document.getElementById('editModelNickname')?.value || '').trim();
            const contextWindowRaw = parseInt(document.getElementById('editModelContextWindow')?.value || '', 10);
            const contextWindowSize = Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? contextWindowRaw : DEFAULT_CONTEXT_WINDOW_SIZE;

            vscode.postMessage({
                command: 'updateModel',
                oldModelName: modelName,
                oldProviderName: providerName,
                newModelName,
                newProviderName: targetProvider,
                providerEndpoint,
                providerApiKey,
                nickname: rawNickname || null,
                contextWindowSize
            });
        });

        // Focus model name input and scroll form into view
        setTimeout(() => {
            const input = document.getElementById('editModelName');
            if (input) input.focus();
            modelDropdown.scrollTop = modelDropdown.scrollHeight;
        }, 50);
    }

    /** Show add model form with provider select. */
    function showAddModelForm(modelDropdown, vscode) {
        if (addModelFormVisible || editModelFormVisible) return;
        addModelFormVisible = true;

        // Remove existing form if any
        hideAddModelForm();

        const providerNames = Object.keys(modelProvidersCache).sort();

        const form = document.createElement('div');
        form.id = 'addModelForm';
        form.className = 'add-model-form';
        form.innerHTML = `
            <div class="add-model-field">
                <label class="add-model-label">Provider</label>
                <select id="addModelProviderSelect">
                    <option value="__new__">+ New Provider</option>
                    ${providerNames.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('')}
                </select>
            </div>
            <div class="add-model-field provider-fields" id="providerFields" style="display:none;">
                <input type="text" id="newProviderName" placeholder="Provider (e.g. OpenAI)" autocomplete="off"/>
                <input type="text" id="newProviderEndpoint" placeholder="Endpoint URL" autocomplete="off"/>
                <input type="password" id="newProviderApiKey" placeholder="API key" autocomplete="off"/>
            </div>
            <div class="add-model-field">
                <input type="text" id="newModelName" placeholder="Model name (e.g. gpt-4o)" autocomplete="off"/>
            </div>
            <div class="add-model-field">
                <label class="add-model-label">Context window (tokens)</label>
                <input type="number" id="newModelContextWindow" value="${DEFAULT_CONTEXT_WINDOW_SIZE}" min="1000" step="1000" placeholder="180000" autocomplete="off"/>
            </div>
            <div class="add-model-actions">
                <button class="action-btn-sm" id="cancelAddModel">Cancel</button>
                <button class="action-btn-sm primary" id="confirmAddModel">Add</button>
            </div>
        `;
        modelDropdown.appendChild(form);

        const select = document.getElementById('addModelProviderSelect');
        const providerFields = document.getElementById('providerFields');

        // Toggle provider fields visibility
        function toggleProviderFields2() {
            providerFields.style.display = select.value === '__new__' ? '' : 'none';
        }
        select.addEventListener('change', toggleProviderFields2);
        toggleProviderFields2();

        document.getElementById('cancelAddModel').addEventListener('click', hideAddModelForm);
        document.getElementById('confirmAddModel').addEventListener('click', () => {
            const modelName = (document.getElementById('newModelName')?.value || '').trim();
            if (!modelName) return;
            const contextWindowRaw = parseInt(document.getElementById('newModelContextWindow')?.value || '', 10);
            const contextWindowSize = Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? contextWindowRaw : DEFAULT_CONTEXT_WINDOW_SIZE;

            if (select.value === '__new__') {
                // New provider + model
                const providerName = (document.getElementById('newProviderName')?.value || '').trim() || modelName;
                const providerEndpoint = (document.getElementById('newProviderEndpoint')?.value || '').trim();
                const providerApiKey = (document.getElementById('newProviderApiKey')?.value || '').trim();
                vscode.postMessage({
                    command: 'addModel',
                    providerName,
                    providerEndpoint,
                    providerApiKey,
                    modelName,
                    contextWindowSize
                });
            } else {
                // Existing provider + new model
                vscode.postMessage({
                    command: 'addModelToProvider',
                    providerName: select.value,
                    modelName,
                    contextWindowSize
                });
            }
        });

        // Focus model name input
        setTimeout(() => document.getElementById('newModelName')?.focus(), 50);
    }

    /** Wire up the configure form (welcome screen). */
    function initConfigureForm(vscode) {
        // All DOM lookups done inside this function
        const configureModelBtn = document.getElementById('configureModelBtn');
        const configureForm = document.getElementById('configureForm');
        const cancelConfigureBtn = document.getElementById('cancelConfigureBtn');
        const saveConfigureBtn = document.getElementById('saveConfigureBtn');
        const addModelRowBtn = document.getElementById('addModelRowBtn');
        const configureModelRows = document.getElementById('configureModelRows');

        /** Add a dynamic model input row to the configure form. */
        function addModelRow() {
            if (!configureModelRows) return;
            const row = document.createElement('div');
            row.className = 'configure-model-row';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'configure-model-input';
            input.placeholder = 'e.g. gpt-4o';
            input.autocomplete = 'off';
            const contextInput = document.createElement('input');
            contextInput.type = 'number';
            contextInput.className = 'configure-model-context-input';
            contextInput.placeholder = 'Context window';
            contextInput.title = 'Context window (tokens)';
            contextInput.min = '1000';
            contextInput.step = '1000';
            contextInput.value = String(DEFAULT_CONTEXT_WINDOW_SIZE);
            contextInput.autocomplete = 'off';
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'configure-remove-btn';
            removeBtn.textContent = '\u00D7';  // ×
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', () => row.remove());
            row.appendChild(input);
            row.appendChild(contextInput);
            row.appendChild(removeBtn);
            configureModelRows.appendChild(row);
            input.focus();
        }

        if (configureModelBtn) {
            configureModelBtn.addEventListener('click', () => {
                configureModelBtn.style.display = 'none';
                if (configureForm) configureForm.style.display = '';
                // Seed first model row
                addModelRow();
                setTimeout(() => {
                    const nameInput = document.getElementById('configureProviderName');
                    if (nameInput) nameInput.focus();
                }, 50);
            });
        }

        if (cancelConfigureBtn) {
            cancelConfigureBtn.addEventListener('click', () => {
                if (configureForm) configureForm.style.display = 'none';
                if (configureModelBtn) configureModelBtn.style.display = '';
                // Clear model rows on cancel
                if (configureModelRows) configureModelRows.innerHTML = '';
                // Clear other fields
                const providerName = document.getElementById('configureProviderName');
                if (providerName) providerName.value = '';
                const providerEndpoint = document.getElementById('configureProviderEndpoint');
                if (providerEndpoint) providerEndpoint.value = '';
                const providerApiKey = document.getElementById('configureProviderApiKey');
                if (providerApiKey) providerApiKey.value = '';
            });
        }

        if (addModelRowBtn) {
            addModelRowBtn.addEventListener('click', addModelRow);
        }

        if (saveConfigureBtn) {
            saveConfigureBtn.addEventListener('click', () => {
                const providerName = (document.getElementById('configureProviderName')?.value || '').trim();
                const providerEndpoint = (document.getElementById('configureProviderEndpoint')?.value || '').trim();
                const providerApiKey = (document.getElementById('configureProviderApiKey')?.value || '').trim();

                // Collect model name + context window from all dynamic rows
                const modelRowEls = configureModelRows ? configureModelRows.querySelectorAll('.configure-model-row') : [];
                const models = [];
                modelRowEls.forEach(rowEl => {
                    const nameVal = (rowEl.querySelector('.configure-model-input')?.value || '').trim();
                    if (nameVal.length === 0) return;
                    const contextRaw = parseInt(rowEl.querySelector('.configure-model-context-input')?.value || '', 10);
                    const contextWindowSize = Number.isFinite(contextRaw) && contextRaw > 0 ? contextRaw : DEFAULT_CONTEXT_WINDOW_SIZE;
                    models.push({ name: nameVal, contextWindowSize });
                });

                if (!providerName || models.length === 0) return;

                vscode.postMessage({
                    command: 'bulkAddModels',
                    providerName,
                    providerEndpoint,
                    providerApiKey,
                    models
                });
            });
        }
    }

    // ============================================================
    //  Composer — slash commands, mode, sending, attachment, keyboard
    // ============================================================

    // --- Shared mutable state ---
    let attachedFiles = [];
    let currentMode = 'plan';
    let assistantName = 'Assistant';

    /** Return 2-letter initials from the assistant name for the avatar. */
    function getAssistantInitials() {
        const parts = assistantName.replace(/[^a-zA-Z\s]/g, '').split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return assistantName.slice(0, 2).toUpperCase();
    }

    let slashMenuEl = null;
    let slashSelectedIndex = -1;

    // --- Slash commands ---
    const SLASH_COMMANDS = [
        { cmd: '/new', label: 'New Chat' },
        { cmd: '/plan', label: 'Plan Mode' },
        { cmd: '/build', label: 'Build Mode' },
        { cmd: '/review', label: 'Review Mode' },
        { cmd: '/debug', label: 'Debug Mode' },
        { cmd: '/research', label: 'Research Mode' },
        { cmd: '/compact', label: 'Compact Context' },
        { cmd: '/logs', label: 'Show Logs' },
        { cmd: '/index', label: 'Rebuild Index' },
        { cmd: '/settings', label: 'Open Settings' },
    ];

    // --- Internal helpers ---

    function showSlashMenu(matches) {
        hideSlashMenu();
        slashSelectedIndex = -1;

        const inputWrapper = document.getElementById('composer');
        if (!inputWrapper) return;

        slashMenuEl = document.createElement('div');
        slashMenuEl.className = 'slash-menu';

        matches.forEach((match, i) => {
            const item = document.createElement('div');
            item.className = 'slash-menu-item';
            item.innerHTML = `<span class="cmd">${escHtml(match.cmd)}</span><span class="label">${escHtml(match.label)}</span>`;
            item.addEventListener('click', () => {
                match.action();
                match.messageInput.value = '';
                match.messageInput.style.height = 'auto';
                if (match.charCount) match.charCount.textContent = '';
                hideSlashMenu();
            });
            item.addEventListener('mouseenter', () => {
                slashSelectedIndex = i;
                updateSlashSelection();
            });
            slashMenuEl.appendChild(item);
        });

        // Attach references needed inside click handler closure
        matches.forEach((match, i) => {
            match.messageInput = window._composerMessageInput;
            match.charCount = window._composerCharCount;
        });

        inputWrapper.appendChild(slashMenuEl);
    }

    function hideSlashMenu() {
        if (slashMenuEl) {
            slashMenuEl.remove();
            slashMenuEl = null;
        }
        slashSelectedIndex = -1;
    }

    function updateSlashSelection() {
        if (!slashMenuEl) return;
        const items = slashMenuEl.querySelectorAll('.slash-menu-item');
        items.forEach((item, i) => {
            item.classList.toggle('selected', i === slashSelectedIndex);
        });
        const selected = slashMenuEl.querySelector('.slash-menu-item.selected');
        if (selected) selected.scrollIntoView({ block: 'nearest' });
    }

    /** Wire up all composer event listeners. */
    function initComposer(opts) {
        const {
            messageInput,
            sendBtn,
            stopBtn,
            attachBtn,
            fileInput,
            charCount,
            messagesArea,
            modeDropdownBtn,
            modeDropdownPanel,
            currentModeLabel,
            attachedFilesDiv,
            vscode,
            callbacks
        } = opts;

        const {
            onSendMessage,
            onStopGeneration,
            onAttachFile,
            scrollToBottom: cbScrollToBottom,
            hideEmpty: cbHideEmpty,
            removeTyping: cbRemoveTyping,
            setStatus: cbSetStatus,
            showTyping: cbShowTyping,
            renderAttachedFiles: cbRenderAttachedFiles
        } = callbacks;

        // Store refs globally so showSlashMenu closures can access them
        window._composerMessageInput = messageInput;
        window._composerCharCount = charCount;

        // --- Mode label updater (also updates mode indicator bar) ---
        function updateModeLabelLocal(mode) {
            const labels = {
                'plan': 'Plan',
                'build': 'Build',
                'code-review': 'Review',
                'debug': 'Debug',
                'research': 'Research'
            };
            if (currentModeLabel) {
                currentModeLabel.textContent = labels[mode] || mode;
            }

            // Update top bar brand (mode dot + label)
            const topBar = document.getElementById('topBar');
            const brandLabel = document.getElementById('brandLabel');
            if (topBar) topBar.setAttribute('data-mode', mode);
            if (brandLabel) brandLabel.textContent = labels[mode] || mode;
        }

        // --- Build slash command actions (close over currentMode & vscode) ---
        const slashCommands = SLASH_COMMANDS.map(cmd => ({
            ...cmd,
            action: null // assigned below
        }));

        slashCommands[0].action = () => vscode.postMessage({ command: 'newChat' });
        slashCommands[1].action = () => { currentMode = 'plan'; updateModeLabelLocal('plan'); localStorage.setItem('currentMode', 'plan'); hideSlashMenu(); };
        slashCommands[2].action = () => { currentMode = 'build'; updateModeLabelLocal('build'); localStorage.setItem('currentMode', 'build'); hideSlashMenu(); };
        slashCommands[3].action = () => { currentMode = 'code-review'; updateModeLabelLocal('code-review'); localStorage.setItem('currentMode', 'code-review'); hideSlashMenu(); };
        slashCommands[4].action = () => { currentMode = 'debug'; updateModeLabelLocal('debug'); localStorage.setItem('currentMode', 'debug'); hideSlashMenu(); };
        slashCommands[5].action = () => { currentMode = 'research'; updateModeLabelLocal('research'); localStorage.setItem('currentMode', 'research'); hideSlashMenu(); };
        slashCommands[6].action = () => vscode.postMessage({ command: 'compact' });
        slashCommands[7].action = () => vscode.postMessage({ command: 'openLogs' });
        slashCommands[8].action = () => vscode.postMessage({ command: 'rebuildIndex' });
        slashCommands[9].action = () => vscode.postMessage({ command: 'openSettings' });

        // --- Restore saved mode ---
        const savedMode = localStorage.getItem('currentMode');
        if (savedMode) currentMode = savedMode;
        updateModeLabelLocal(currentMode);

        // Focus input on init
        messageInput.focus();

        // --- Mode dropdown ---
        modeDropdownBtn.addEventListener('click', e => {
            e.stopPropagation();
            modeDropdownPanel.classList.toggle('open');
        });

        document.querySelectorAll('.mode-option').forEach(opt => {
            opt.addEventListener('click', () => {
                currentMode = opt.dataset.mode;
                updateModeLabelLocal(currentMode);
                localStorage.setItem('currentMode', currentMode);
                modeDropdownPanel.classList.remove('open');
            });
        });

        // --- Interaction mode dropdown (Ask / Auto-edit / Relaxed) ---
        const interactionModeBtn = document.getElementById('interactionModeBtn');
        const interactionModeDropdown = document.getElementById('interactionModeDropdown');
        const interactionModeIcon = document.getElementById('interactionModeIcon');
        const interactionModeLabel = document.getElementById('interactionModeLabel');
        let currentInteractionMode = 'ask';

        const interactionIcons = { ask: '🔒', autoedit: '✏️', relaxed: '⚡' };
        const interactionLabels = { ask: 'Ask all', autoedit: 'Allow edits', relaxed: 'Relaxed' };

        function updateInteractionMode(mode) {
            currentInteractionMode = mode;
            if (interactionModeIcon) interactionModeIcon.textContent = interactionIcons[mode] || '🔒';
            if (interactionModeLabel) interactionModeLabel.textContent = interactionLabels[mode] || 'Ask all';
            if (interactionModeBtn) interactionModeBtn.title = mode === 'ask' ? 'Ask (approve every tool call)' : mode === 'autoedit' ? 'Auto-edit (prompt for edits)' : 'Relaxed (only prompt for commands)';
            localStorage.setItem('interactionMode', mode);
            // Update active state in dropdown
            document.querySelectorAll('.interaction-mode-option').forEach(el => {
                el.classList.toggle('active', el.dataset.mode === mode);
            });
        }

        if (interactionModeBtn) {
            interactionModeBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (interactionModeDropdown) interactionModeDropdown.classList.toggle('open');
            });
        }

        document.querySelectorAll('.interaction-mode-option').forEach(opt => {
            opt.addEventListener('click', () => {
                updateInteractionMode(opt.dataset.mode);
                if (interactionModeDropdown) interactionModeDropdown.classList.remove('open');
                vscode.postMessage({ command: 'setInteractionMode', mode: opt.dataset.mode });
            });
        });

        // --- Close dropdowns / slash menu on outside click ---
        document.addEventListener('click', e => {
            if (!modeDropdownPanel.contains(e.target) && e.target !== modeDropdownBtn) {
                modeDropdownPanel.classList.remove('open');
            }
            const intModeBtn = document.getElementById('interactionModeBtn');
            const intModeDropdown = document.getElementById('interactionModeDropdown');
            if (intModeDropdown && intModeBtn && !intModeDropdown.contains(e.target) && e.target !== intModeBtn) {
                intModeDropdown.classList.remove('open');
            }
            if (slashMenuEl && !slashMenuEl.contains(e.target) && e.target !== messageInput) {
                hideSlashMenu();
            }
        });

        // --- Stop button ---
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                onStopGeneration();
            });
        }

        // --- File attachment ---
        attachBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', e => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            const file = files[0];
            const reader = new FileReader();
            reader.onload = ev => {
                const content = ev.target.result;
                attachedFiles.push({ name: file.name, content, size: file.size });
                cbRenderAttachedFiles();
                onAttachFile(file.name, content);
            };
            reader.readAsText(file);
            fileInput.value = '';
        });

        // --- Keyboard handler (Enter to send, slash nav) ---
        messageInput.addEventListener('keydown', e => {
            const text = messageInput.value.trim();

            // Handle slash command navigation
            if (slashMenuEl && slashMenuEl.querySelector('.slash-menu-item')) {
                const items = slashMenuEl.querySelectorAll('.slash-menu-item');
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    slashSelectedIndex = Math.min(slashSelectedIndex + 1, items.length - 1);
                    updateSlashSelection();
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    slashSelectedIndex = Math.max(slashSelectedIndex - 1, 0);
                    updateSlashSelection();
                    return;
                }
                if (e.key === 'Tab') {
                    e.preventDefault();
                    if (slashSelectedIndex >= 0 && slashSelectedIndex < items.length) {
                        const match = slashCommands.find(c => c.label === items[slashSelectedIndex].querySelector('.label').textContent);
                        if (match) {
                            messageInput.value = match.cmd + ' ';
                            hideSlashMenu();
                        }
                    } else if (items.length > 0) {
                        const firstMatch = slashCommands[0];
                        messageInput.value = firstMatch.cmd + ' ';
                        hideSlashMenu();
                    }
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    hideSlashMenu();
                    return;
                }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Check for exact slash command match
                if (text.startsWith('/')) {
                    const matched = slashCommands.find(c => c.cmd === text.toLowerCase());
                    if (matched) {
                        matched.action();
                        messageInput.value = '';
                        messageInput.style.height = 'auto';
                        if (charCount) charCount.textContent = '';
                        hideSlashMenu();
                        return;
                    }
                }
                doSendMessage();
            }
        });

        // --- Auto-resize textarea + slash menu ---
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
            if (charCount) {
                charCount.textContent = messageInput.value.length > 0 ? messageInput.value.length + ' chars' : '';
            }

            // Show/hide slash menu
            const text = messageInput.value.trim();
            if (text.startsWith('/')) {
                const partial = text.toLowerCase();
                const matches = slashCommands.filter(c => c.cmd.startsWith(partial));
                if (matches.length > 0 && partial !== '/') {
                    showSlashMenu(matches);
                } else if (partial === '/') {
                    showSlashMenu(slashCommands);
                } else {
                    hideSlashMenu();
                }
            } else {
                hideSlashMenu();
            }
        });

        // --- Send button ---
        sendBtn.addEventListener('click', doSendMessage);

        // --- Pending message bar buttons ---
        const pendingClearAll = document.getElementById('pendingClearAll');
        if (pendingClearAll) pendingClearAll.addEventListener('click', () => clearQueue());
        const pendingSendNow = document.getElementById('pendingSendNow');
        if (pendingSendNow) pendingSendNow.addEventListener('click', () => {
            if (pendingQueue.length > 0) {
                const textToSend = pendingQueue.shift().text;
                renderPendingQueue();
                vscode.postMessage({
                    command: 'forceSendMessage',
                    text: textToSend,
                    mode: currentMode
                });
            }
        });

        // --- Suggestion chips (event delegation) ---
        messagesArea.addEventListener('click', e => {
            const chip = e.target.closest('.suggestion-chip');
            if (chip && chip.dataset.text) {
                messageInput.value = chip.dataset.text;
                doSendMessage();
            }
        });

        // --- sendMessage logic ---
        function doSendMessage() {
            const text = messageInput.value.trim();
            if (!text && attachedFiles.length === 0) return;

            // If AI is currently working, queue as pending message instead.
            // isProcessing is the authoritative flag (survives the gaps between
            // tool turns where isStreaming is false and no typing indicator is
            // shown) — checking only isStreaming/typingIndicator let a message
            // slip through mid-turn straight to the backend, which silently
            // no-ops it (already processing), so it looked like sent messages
            // did nothing.
            if (isProcessing || isStreaming || document.getElementById('typingIndicator')) {
                addToQueue(text, messagesArea, scrollToBottom, hideEmpty, vscode);
                messageInput.value = '';
                messageInput.style.height = 'auto';
                if (charCount) charCount.textContent = '';
                return;
            }

            cbHideEmpty();
            onSendMessage(text);

            messageInput.value = '';
            messageInput.style.height = 'auto';
            if (charCount) charCount.textContent = '';

            // Clear any stale streaming state from a previous interrupted response
            cbRemoveTyping();
            const staleStream = document.getElementById('streamMsg');
            if (staleStream) staleStream.remove();

            cbSetStatus('active', 'Connecting...');
            autoScroll = true;

            attachedFiles = [];
            cbRenderAttachedFiles();
            cbShowTyping();
        }
    }

    // ============================================================
    //  Tool approval UI
    // ============================================================

    /** Mutable: current pending approval request, or null. */
    let pendingApproval = null;
    /** Queue for approval requests that arrive while the webview is mid-reinit. */
    let _queuedApproval = null;

    /** Flush any queued approval request after webview becomes ready. */
    function flushQueuedApproval(messagesArea, vscode, scrollToBottomFn) {
        if (_queuedApproval) {
            const q = _queuedApproval;
            _queuedApproval = null;
            showApprovalRequest(q.toolId, q.toolName, q.argsJson, q.riskLevel, q.riskClass, messagesArea, vscode, scrollToBottomFn, q.agentId);
        }
    }

    /** Set of toolIds that currently have visible approval cards (survives DOM rebuilds). */
    const activeApprovalToolIds = new Set();

    /** Show an approval card in the messages area. `agentId` (P6-T14), when set, means
     * the request came from a sub-agent's tool call rather than the main conversation. */
    function showApprovalRequest(toolId, toolName, argsJson, riskLevel, riskClass, messagesArea, vscode, scrollToBottomFn, agentId) {
        // Guard: DOM may be stale after webview reinit — fall back to live lookup.
        // Note: acquireVsCodeApi() can only be called once, so we never re-acquire.
        if (!messagesArea || !messagesArea.appendChild) {
            messagesArea = document.getElementById('messages');
        }
        if (!messagesArea || !vscode || typeof vscode.postMessage !== 'function') {
            // Try global fallback (set at IIFE init) when the closure-held vscode is stale
            if (!vscode || typeof vscode.postMessage !== 'function') {
                vscode = window.__vscode_api;
            }
            if (!messagesArea || !vscode || typeof vscode.postMessage !== 'function') {
                // Webview is mid-reinit — queue for flush once ready.
                _queuedApproval = { toolId, toolName, argsJson, riskLevel, riskClass, agentId };
                return;
            }
        }

        // Deduplicate: if a card for this toolId already exists in DOM or is tracked, skip
        if (activeApprovalToolIds.has(toolId)) {
            return;
        }
        if (document.getElementById('approvalCard-' + toolId)) {
            activeApprovalToolIds.add(toolId);
            return;
        }

        pendingApproval = { toolId, toolName, argsJson };
        activeApprovalToolIds.add(toolId);
        const card = document.createElement('div');
        card.className = `approval-card ${riskLevel || 'moderate'}`;
        card.id = 'approvalCard-' + toolId;

        let argsPreview = '{}';
        try {
            const args = JSON.parse(argsJson || '{}');
            argsPreview = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v)}`).join(', ');
        } catch {}

        const riskLabel = riskClass || riskLevel || 'moderate';
        card.innerHTML = `
            <div class="approval-header">
                <span class="approval-icon">${(riskLevel === 'dangerous') ? '⚠️' : '🔧'}</span>
                <span class="approval-title">${escHtml(toolName)}</span>
                <span class="approval-risk ${riskLevel}">${escHtml(riskLabel)}</span>
            </div>
            ${agentId ? `<div class="approval-agent-tag">🤖 Requested by sub-agent <code>${escHtml(agentId)}</code></div>` : ''}
            <div class="approval-args">${escHtml(argsPreview)}</div>
            <div class="approval-actions">
                <button class="approval-btn approve" data-scope="once">Approve once</button>
                <button class="approval-btn approve-session" data-scope="session">Allow for session</button>
                <button class="approval-btn approve-workspace" data-scope="workspace">Always allow</button>
                <button class="approval-btn reject" data-scope="once">Reject</button>
            </div>
        `;

        // Store toolId on the card so each card's buttons reference the correct tool — avoids
        // bugs when multiple approval cards coexist and the shared pendingApproval variable points
        // to a different tool than the one whose button was clicked.
        card.dataset.toolId = toolId;
        card.dataset.toolName = toolName;

        // Wire up all buttons
        card.querySelectorAll('.approval-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const scope = btn.getAttribute('data-scope') || 'once';
                const isApproved = !btn.classList.contains('reject');
                // Use the toolId stored on this specific card, not the shared pendingApproval variable
                const clickedToolId = card.dataset.toolId;
                const clickedToolName = card.dataset.toolName;

                if (isApproved && (scope === 'session' || scope === 'workspace')) {
                    // Show brief inline confirmation before sending response
                    const confirmEl = document.createElement('div');
                    confirmEl.className = 'approval-confirm-toast';
                    confirmEl.textContent = scope === 'session'
                        ? `✅ ${escHtml(clickedToolName)} will be auto-approved for this session`
                        : `✅ ${escHtml(clickedToolName)} will always be allowed in this workspace`;
                    card.parentNode.insertBefore(confirmEl, card.nextSibling);
                    setTimeout(() => confirmEl.remove(), 2500);
                }

                removeApprovalCardByToolId(clickedToolId);
                vscode.postMessage({
                    command: 'toolApprovalResponse',
                    toolId: clickedToolId,
                    approved: isApproved,
                    scope: scope
                });
                // Clear shared state only if this card was the current pending approval
                if (pendingApproval && pendingApproval.toolId === clickedToolId) {
                    pendingApproval = null;
                }
            });
        });

        // Sticky bar above the composer, not inline in the scrolling chat — a
        // pending approval must never get pushed out of view by other tool
        // calls/messages that stream in below it while it's still waiting.
        const approvalBar = document.getElementById('approvalBar');
        if (approvalBar) {
            approvalBar.appendChild(card);
        } else {
            // Fallback (approvalBar missing for some reason) — old behavior.
            messagesArea.appendChild(card);
            if (typeof scrollToBottomFn === 'function') scrollToBottomFn();
        }
    }

    /** Remove the approval card for a specific toolId from the DOM. */
    function removeApprovalCardByToolId(toolId) {
        activeApprovalToolIds.delete(toolId);
        const el = document.getElementById('approvalCard-' + toolId);
        if (el) el.remove();
        // Also remove any leftover generic card (backward compat)
        const legacy = document.getElementById('approvalCard');
        if (legacy) legacy.remove();
    }

    /** Remove the approval card from the DOM. */
    function removeApprovalCard() {
        if (pendingApproval) {
            removeApprovalCardByToolId(pendingApproval.toolId);
        } else {
            // Fallback: remove any legacy card
            const legacy = document.getElementById('approvalCard');
            if (legacy) legacy.remove();
        }
    }

    // ============================================================
    //  Retrieved context chips & edit mode
    // ============================================================
    //  Question card (ask_user_question tool)
    // ============================================================

    /** Pending question state */
    let pendingQuestion = null;

    // ------------------------------------------------------------------
    // Agent cards (sub-agent visibility)
    // ------------------------------------------------------------------

    /** Per-agent card state: agentId → {card, toolCount, turn, startTime} */
    const _agentCards = new Map();

    /** Render or update an agent card in the messages area. */
    function showAgentCard(agentId, prompt, toolAllowlist, messagesArea, scrollToBottomFn) {
        let cardState = _agentCards.get(agentId);
        if (cardState && cardState.card.parentNode) {
            return cardState;
        }

        const card = document.createElement('div');
        card.className = 'agent-card';
        card.id = 'agentCard-' + agentId;

        const header = document.createElement('div');
        header.className = 'agent-card-header';
        header.innerHTML = '<span class="agent-card-icon">🤖</span><span class="agent-card-title">' + escHtml(prompt.slice(0, 120)) + '</span><span class="agent-card-status agent-status-running">Running…</span>';

        // Cancel button — calls stop_agent via vscode postMessage
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'agent-card-cancel';
        cancelBtn.innerHTML = '&#x23F9;'; // ⏹ stop icon
        cancelBtn.title = 'Stop this agent';
        cancelBtn.addEventListener('click', () => {
            if (vscode && typeof vscode.postMessage === 'function') {
                vscode.postMessage({ command: 'stopAgent', agentId: agentId });
            }
            const statusEl = header.querySelector('.agent-card-status');
            if (statusEl) { statusEl.textContent = 'Cancelling...'; statusEl.className = 'agent-card-status agent-status-stopping'; }
            cancelBtn.disabled = true;
            cancelBtn.style.opacity = '0.4';
        });
        header.appendChild(cancelBtn);

        const tools = document.createElement('div');
        tools.className = 'agent-card-tools';
        tools.textContent = 'Tools: ' + (toolAllowlist || []).join(', ');

        const progress = document.createElement('div');
        progress.className = 'agent-card-progress';

        card.appendChild(header);
        card.appendChild(tools);
        card.appendChild(progress);

        messagesArea.appendChild(card);

        cardState = { card, toolCount: 0, turn: 0, startTime: Date.now() };
        _agentCards.set(agentId, cardState);

        if (typeof scrollToBottomFn === 'function') scrollToBottomFn();
        return cardState;
    }

    /** Update an agent card with a progress event. */
    function updateAgentCard(agentId, event, messagesArea, scrollToBottomFn) {
        const cardState = _agentCards.get(agentId);
        if (!cardState) return;
        const card = cardState.card;
        const statusEl = card.querySelector('.agent-card-status');
        const progressEl = card.querySelector('.agent-card-progress');

        if (event.type === 'turn_start') {
            cardState.turn = event.turn || 0;
            if (statusEl) statusEl.textContent = 'Thinking… (turn ' + (cardState.turn + 1) + ')';
        }

        if (event.type === 'tool_call') {
            cardState.toolCount++;
            if (statusEl) { statusEl.textContent = 'Working…'; statusEl.className = 'agent-card-status agent-status-working'; }
            const item = document.createElement('div');
            item.className = 'agent-progress-item agent-progress-tool';
            item.textContent = '🔧 ' + escHtml(event.toolName || '');
            progressEl.appendChild(item);
        }

        if (event.type === 'tool_result') {
            const lastItem = progressEl.lastElementChild;
            if (lastItem) {
                lastItem.className = 'agent-progress-item agent-progress-done';
                const output = (event.output || '').slice(0, 300);
                if (output) {
                    const detail = document.createElement('span');
                    detail.className = 'agent-progress-detail';
                    detail.textContent = ' — ' + escHtml(output);
                    lastItem.appendChild(detail);
                }
            }
        }

        if (event.type === 'completed') {
            if (statusEl) { statusEl.textContent = 'Done'; statusEl.className = 'agent-card-status agent-status-done'; }
            const elapsed = ((Date.now() - cardState.startTime) / 1000).toFixed(1);
            const summary = document.createElement('div');
            summary.className = 'agent-card-summary';
            summary.textContent = cardState.toolCount + ' tool call' + (cardState.toolCount !== 1 ? 's' : '') + ', ' + (cardState.turn + 1) + ' turn' + (cardState.turn !== 0 ? 's' : '') + ', ' + elapsed + 's';
            card.appendChild(summary);
            if (event.output) {
                const outputDiv = document.createElement('div');
                outputDiv.className = 'agent-card-output';
                outputDiv.innerHTML = renderMarkdown(event.output);
                card.appendChild(outputDiv);
            }

        // Hide the stop/cancel button on terminal states
        const doneBtn = card.querySelector('.agent-card-cancel');
        if (doneBtn) { doneBtn.style.display = 'none'; }
        }

        if (event.type === 'error') {
            if (statusEl) { statusEl.textContent = 'Error'; statusEl.className = 'agent-card-status agent-status-error'; }
            const errDiv = document.createElement('div');
            errDiv.className = 'agent-card-error';
            errDiv.textContent = escHtml(event.error || 'Unknown error');
            card.appendChild(errDiv);

        // Hide the stop/cancel button on terminal states
        const errBtn = card.querySelector('.agent-card-cancel');
        if (errBtn) { errBtn.style.display = 'none'; }
        }
        if (event.type === 'partial_output') {
            // Show live progress from a running sub-agent
            let partialDiv = card.querySelector('.agent-card-partial-output');
            if (!partialDiv) {
                partialDiv = document.createElement('div');
                partialDiv.className = 'agent-card-partial-output';
                partialDiv.style.cssText = 'margin-top:8px;padding:8px;font-size:12px;opacity:0.7;border-left:2px solid var(--vscode-progressBar-background,#007acc);';
                const pLabel = document.createElement('div');
                pLabel.textContent = 'Progress:';
                pLabel.style.fontWeight = 'bold';
                partialDiv.appendChild(pLabel);
                const newPContent = document.createElement('div');
                newPContent.className = 'agent-card-partial-content';
                partialDiv.appendChild(newPContent);
                card.appendChild(partialDiv);
            }
            const pContent = partialDiv.querySelector('.agent-card-partial-content');
            if (pContent && event.output) {
                pContent.innerHTML = renderMarkdown(event.output);
            }
        }
        if (event.type === 'timeout') {
            if (statusEl) { statusEl.textContent = 'Timed out'; statusEl.className = 'agent-card-status agent-status-error'; }
            const toDiv = document.createElement('div');
            toDiv.className = 'agent-card-error';
            toDiv.textContent = 'Agent timed out. Consider increasing timeoutMs.';
            card.appendChild(toDiv);
        }
        if (event.type === 'stopped') {
            if (statusEl) { statusEl.textContent = 'Stopped'; statusEl.className = 'agent-card-status agent-status-stopped'; }
            const stopDiv = document.createElement('div');
            stopDiv.className = 'agent-card-summary';
            stopDiv.textContent = 'Agent was stopped by user.';
            card.appendChild(stopDiv);

        // Hide the stop/cancel button on terminal states
        const stoppedBtn = card.querySelector('.agent-card-cancel');
        if (stoppedBtn) { stoppedBtn.style.display = 'none'; }
        }

        if (typeof scrollToBottomFn === 'function') scrollToBottomFn();
    }

    /**
     * Render a static, read-only agent card reconstructed from persisted
     * history (on chat load/reload) — no live progress list, since that part
     * is inherently ephemeral, but the same visual treatment and final state
     * as the live card, built from data that's already in the stored
     * transcript. `info` is `{ prompt, toolAllowlist, result, outerError }`
     * gathered by the pre-pass in loadMessages; any field may be missing
     * (e.g. spawn_agent without a later wait_for_agent call).
     */
    function renderStaticAgentCard(agentId, info, messagesArea) {
        const card = document.createElement('div');
        card.className = 'agent-card agent-card-static';
        card.id = 'agentCard-' + agentId;

        const header = document.createElement('div');
        header.className = 'agent-card-header';

        const result = info.result || null;
        let statusLabel = 'Spawned';
        let statusClass = 'agent-status-working';
        if (result) {
            if (result.cancelled) {
                statusLabel = 'Cancelled'; statusClass = 'agent-status-stopped';
            } else if (result.timedOut) {
                statusLabel = 'Still running (last checked)'; statusClass = 'agent-status-working';
            } else if (info.outerError || result.error) {
                statusLabel = 'Error'; statusClass = 'agent-status-error';
            } else if (result.status === 'completed') {
                statusLabel = 'Done'; statusClass = 'agent-status-done';
            } else if (result.status) {
                statusLabel = result.status;
            }
        } else {
            statusLabel = 'No result recorded'; statusClass = 'agent-status-working';
        }

        const promptText = (info.prompt || '').slice(0, 120) || '(sub-agent)';
        header.innerHTML = '<span class="agent-card-icon">🤖</span>' +
            '<span class="agent-card-title">' + escHtml(promptText) + '</span>' +
            '<span class="agent-card-status ' + statusClass + '">' + escHtml(statusLabel) + '</span>';
        card.appendChild(header);

        if (info.toolAllowlist && info.toolAllowlist.length) {
            const tools = document.createElement('div');
            tools.className = 'agent-card-tools';
            tools.textContent = 'Tools: ' + info.toolAllowlist.join(', ');
            card.appendChild(tools);
        }

        if (result && typeof result.toolUsageCount === 'number') {
            const summary = document.createElement('div');
            summary.className = 'agent-card-summary';
            summary.textContent = result.toolUsageCount + ' tool call' + (result.toolUsageCount !== 1 ? 's' : '');
            card.appendChild(summary);
        }

        const outputText = (result && (result.loopOutput || result.partialOutput)) || '';
        if (outputText) {
            const outputDiv = document.createElement('div');
            outputDiv.className = 'agent-card-output';
            outputDiv.innerHTML = renderMarkdown(outputText);
            card.appendChild(outputDiv);
        }

        const errorText = info.outerError || (result && result.error) || '';
        if (errorText) {
            const errDiv = document.createElement('div');
            errDiv.className = 'agent-card-error';
            errDiv.textContent = errorText;
            card.appendChild(errDiv);
        }

        messagesArea.appendChild(card);
    }

    /** Show an inline question card in the messages area. */
    function showQuestionCard(questionId, questionText, options, multiSelect, messagesArea, vscode, scrollToBottomFn) {
        // Remove existing question card if any
        const existing = document.getElementById('questionCard');
        if (existing) existing.remove();

        pendingQuestion = { questionId };

        const card = document.createElement('div');
        card.className = 'question-card';
        card.id = 'questionCard';

        const questionEl = document.createElement('div');
        questionEl.className = 'question-text';
        questionEl.textContent = questionText;
        card.appendChild(questionEl);

        if (options && options.length > 0) {
            const optionsContainer = document.createElement('div');
            optionsContainer.className = 'question-options';

            options.forEach((opt, i) => {
                const optBtn = document.createElement('button');
                optBtn.className = `question-option question-option-${i}`;
                optBtn.innerHTML = `<span class="question-option-letter">${String.fromCharCode(65 + i)}</span><div class="question-option-content"><span class="question-option-label">${escHtml(opt.label)}</span>${opt.description ? `<span class="question-option-desc">${escHtml(opt.description)}</span>` : ''}</div>`;

                optBtn.addEventListener('click', () => {
                    if (multiSelect) {
                        optBtn.classList.toggle('selected');
                    } else {
                        // Single select — auto-submit
                        optionsContainer.querySelectorAll('.question-option').forEach(o => o.classList.remove('selected'));
                        optBtn.classList.add('selected');
                        vscode.postMessage({
                            command: 'questionResponse',
                            questionId,
                            answer: opt.label
                        });
                        card.remove();
                        pendingQuestion = null;
                    }
                });

                optionsContainer.appendChild(optBtn);
            });

            card.appendChild(optionsContainer);

            if (multiSelect) {
                const submitRow = document.createElement('div');
                submitRow.className = 'question-submit-row';
                const submitBtn = document.createElement('button');
                submitBtn.className = 'question-submit-btn';
                submitBtn.textContent = 'Submit';
                submitBtn.addEventListener('click', () => {
                    const selected = [];
                    optionsContainer.querySelectorAll('.question-option.selected').forEach(el => {
                        const m = el.className.match(/question-option-(\d+)/);
                        if (m) selected.push(options[parseInt(m[1])]?.label);
                    });
                    vscode.postMessage({
                        command: 'questionResponse',
                        questionId,
                        answer: selected.length === 1 ? selected[0] : selected
                    });
                    card.remove();
                    pendingQuestion = null;
                });
                submitRow.appendChild(submitBtn);
                card.appendChild(submitRow);
            }
        }

        // Text input for free-form answers
        const inputRow = document.createElement('div');
        inputRow.className = 'question-input-row';
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'question-text-input';
        textInput.placeholder = options ? 'Or type a custom answer...' : 'Type your answer...';
        const sendBtn2 = document.createElement('button');
        sendBtn2.className = 'question-send-btn';
        sendBtn2.textContent = 'Send';
        sendBtn2.addEventListener('click', () => {
            const val = textInput.value.trim();
            if (val) {
                vscode.postMessage({
                    command: 'questionResponse',
                    questionId,
                    answer: val
                });
                card.remove();
                pendingQuestion = null;
            }
        });
        textInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') sendBtn2.click();
        });
        inputRow.appendChild(textInput);
        inputRow.appendChild(sendBtn2);
        card.appendChild(inputRow);

        // Append to messages area
        messagesArea.appendChild(card);

        requestAnimationFrame(() => scrollToBottomFn());
        textInput.focus();
    }

    // ============================================================

    /** Show a bar of removable context-chip pills above the composer. */
    function showRetrievedContext(chunks, messagesArea, vscode, scrollToBottomFn) {
        // Remove existing container
        const existing = document.getElementById('retrievedContextBar');
        if (existing) existing.remove();

        if (!chunks || chunks.length === 0) return;

        const bar = document.createElement('div');
        bar.id = 'retrievedContextBar';
        bar.className = 'retrieved-context-bar';
        bar.innerHTML = '<span class="retrieved-context-label">📌 Pinned context:</span>';

        for (const chunk of chunks) {
            const chip = document.createElement('span');
            chip.className = 'context-chip';
            const name = chunk.filePath.split('/').pop();
            chip.textContent = `${name} (${chunk.startLine}-${chunk.endLine})`;
            chip.title = chunk.filePath;
            chip.style.cursor = 'pointer';
            chip.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'removeRetrievedChunk',
                    filePath: chunk.filePath
                });
                chip.remove();
                if (bar.children.length <= 1) bar.remove();
            });
            bar.appendChild(chip);
        }

        // Insert above the input area
        const composer = document.getElementById('composer');
        if (composer && messagesArea) {
            messagesArea.parentNode.insertBefore(bar, composer);
        } else if (messagesArea) {
            messagesArea.parentNode.appendChild(bar);
        }

        scrollToBottomFn();
    }

    /** Pre-fill the message input with selected text and show an editing hint. */
    function enterEditMode(filePath, startLine, endLine, selectedText, messageInput, setStatusFn) {
        // Pre-fill input with edit context and focus
        if (messageInput) {
            messageInput.value = selectedText || '';
            messageInput.focus();
        }

        // Show a hint in status line
        setStatusFn('active', `Editing ${filePath} (${startLine}-${endLine}) — describe your changes`, false);
        setTimeout(() => setStatusFn('done', 'Ready'), 3000);
    }

    // ============================================================
    //  Message rendering — add, stream, finalize, load, action bar
    // ============================================================

    /** Accumulated raw streaming text for the current turn. */
    let streamBuffer = '';

    /** Whether a stream is currently active. */
    let isStreaming = false;

    /** Whether the backend is still working (streaming + tool turns + summarization).
        Single source of truth for stop / send button visibility. */
    let isProcessing = false;

    // ============================================================
    //  Pending message queue (bullet list) — outer scope for message handler access
    // ============================================================

    let pendingQueue = [];

    function renderPendingQueue() {
        const bar = document.getElementById('pendingMessageBar');
        const list = document.getElementById('pendingQueueList');
        if (!bar || !list) return;

        if (pendingQueue.length === 0) {
            bar.style.display = 'none';
            const inputBox = document.getElementById('messageInput')?.closest('.input-box');
            if (inputBox) inputBox.style.borderRadius = '8px';
            return;
        }

        bar.style.display = 'flex';
        const inputBoxEl = document.getElementById('messageInput')?.closest('.input-box');
        if (inputBoxEl) inputBoxEl.style.borderRadius = '0 0 8px 8px';

        list.innerHTML = '';
        pendingQueue.forEach((item, idx) => {
            const el = document.createElement('div');
            el.className = 'pending-queue-item';
            el.innerHTML = `
                <span class="pending-queue-bullet"></span>
                <span class="pending-queue-text">${escHtml(item.text)}</span>
                <button class="pending-queue-dismiss" data-idx="${idx}" title="Remove">✕</button>
            `;
            list.appendChild(el);
        });

        // Wire dismiss buttons
        list.querySelectorAll('.pending-queue-dismiss').forEach(btn => {
            btn.addEventListener('click', () => {
                const removed = pendingQueue.splice(parseInt(btn.dataset.idx), 1);
                // The message was never sent — remove its optimistic chat
                // bubble too, or it would linger in the chat as if it had been.
                removed.forEach(removeQueuedMessageRow);
                renderPendingQueue();
            });
        });
    }

    function addToQueue(text, messagesArea, scrollToBottomFn, hideEmptyFn, vscode) {
        // Show the user's message in the chat immediately (optimistic) and
        // keep a reference to its row so cancelling the queue can remove it
        // again — it was never actually sent, so it must not linger in chat.
        const row = addMessage(text, 'user', messagesArea, scrollToBottomFn, hideEmptyFn, vscode);
        pendingQueue.push({ text, row });
        renderPendingQueue();
    }

    /** Remove a queued message's optimistic chat bubble, if it has one. */
    function removeQueuedMessageRow(item) {
        if (item && item.row && item.row.parentNode) {
            item.row.remove();
        }
    }

    function clearQueue() {
        pendingQueue.forEach(removeQueuedMessageRow);
        pendingQueue = [];
        renderPendingQueue();
    }

    /** Create a message row and append it to the messages area. `stats`, when
     * given, is {durationMs, tokens} for the "12.4s · 3.2k tok" caption. */
    function addMessage(text, sender, messagesArea, scrollToBottomFn, hideEmptyFn, vscode, isPartial, stats) {
        hideEmptyFn();

        const row = document.createElement('div');
        row.className = 'msg-row';

        const avatar = document.createElement('div');
        avatar.className = `msg-avatar ${sender}`;
        avatar.textContent = sender === 'ai' ? 'AI' : 'U';

        const body = document.createElement('div');
        body.className = 'msg-body';

        const roleLabel = document.createElement('div');
        roleLabel.className = `msg-role ${sender}`;
        roleLabel.textContent = sender === 'ai' ? assistantName : 'You';

        // Hide role label when consecutive messages are from the same sender, show "..." instead
        const lastRow = messagesArea.querySelector('.msg-row:last-child');
        if (lastRow) {
            const lastAvatar = lastRow.querySelector('.msg-avatar');
            if (lastAvatar && lastAvatar.classList.contains(sender)) {
                roleLabel.textContent = '…';
                roleLabel.className = `msg-role ${sender} msg-role-continuation`;
            }
        }

        const textDiv = document.createElement('div');
        textDiv.className = 'msg-text';
        textDiv.innerHTML = renderMarkdown(text);

        body.appendChild(roleLabel);
        body.appendChild(textDiv);

        // Interrupted badge for partial messages restored after reload
        if (isPartial) {
            const badge = document.createElement('div');
            badge.className = 'interrupted-badge';
            badge.textContent = '\u26A0 Message was incomplete — stream interrupted';
            body.appendChild(badge);
        }

        // Add action bar for AI messages
        if (sender === 'ai') {
            const actions = createActionBar(text, messagesArea, vscode);
            body.appendChild(actions);
            if (stats) {
                const caption = createStatsCaption(stats.durationMs, stats.tokens);
                if (caption) body.appendChild(caption);
            }
        }

        row.appendChild(avatar);
        row.appendChild(body);
        messagesArea.appendChild(row);
        scrollToBottomFn(true); // Force scroll for explicit messages
        return row;
    }

    /** Create an action bar with copy and (optionally) regenerate buttons. */
    function createActionBar(text, messagesArea, vscode) {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';

        // Copy button
        // UI-1: was a clipboard emoji (📋), which reads as "paste" rather
        // than "copy" -- a plain text label avoids the wrong-icon ambiguity.
        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = '\u2713';
                setTimeout(() => copyBtn.textContent = 'Copy', 1500);
            });
        });
        actions.appendChild(copyBtn);

        // Regenerate button (only on last AI message)
        const aiRows = messagesArea.querySelectorAll('.msg-row .msg-avatar.ai');
        const isLastAi = aiRows.length > 0 && aiRows[aiRows.length - 1].closest('.msg-row') === actions.closest('.msg-row');
        if (isLastAi) {
            const regenBtn = document.createElement('button');
            regenBtn.className = 'action-btn';
            regenBtn.textContent = '\u21BB'; // ↻
            regenBtn.title = 'Regenerate';
            regenBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'regenerate' });
            });
            actions.appendChild(regenBtn);
        }

        return actions;
    }

    /** Debounce timer for markdown rendering during streaming. */
    let _renderTimer = null;
    let _lastStreamRenderAt = 0; // P6-T10: throttle timestamp for stream renders
    const RENDER_INTERVAL_MS = 120;

    /** Extract <thinking>...</thinking> blocks from raw text, return {thinking, rest}. */
    function _splitThinking(raw) {
        const m = raw.match(/^(<thinking>[\s\S]*?<\/thinking>)\s*/i);
        if (m) {
            const thinking = m[1];
            const rest = raw.slice(m[0].length);
            return { thinking, rest };
        }
        // Partial tag not yet closed
        const openIdx = raw.toLowerCase().indexOf('<thinking>');
        if (openIdx >= 0) {
            const closeIdx = raw.toLowerCase().indexOf('</thinking>', openIdx);
            if (closeIdx < 0) {
                // Still opening — everything from <thinking> is thinking content
                return { thinking: raw.slice(openIdx), rest: raw.slice(0, openIdx) };
            }
        }
        return { thinking: '', rest: raw };
    }

    /** Flush the debounced markdown render immediately. Shows thinking as a collapsed block. */
    function flushStreamRender(scrollToBottomFn) {
        if (_renderTimer) {
            clearTimeout(_renderTimer);
            _renderTimer = null;
        }
        const textDiv = document.getElementById('streamText');
        if (textDiv && streamBuffer) {
            const { thinking, rest } = _splitThinking(streamBuffer);

            // Update thinking block if present
            let thinkingEl = document.getElementById('streamThinking');
            if (thinking) {
                if (!thinkingEl) {
                    thinkingEl = document.createElement('div');
                    thinkingEl.id = 'streamThinking';
                    thinkingEl.className = 'thinking-block';
                    thinkingEl.innerHTML = '<span class="thinking-header">🧠 Reasoning…</span><div class="thinking-content"></div>';
                    textDiv.parentNode.insertBefore(thinkingEl, textDiv);
                    // Toggle on click
                    thinkingEl.querySelector('.thinking-header').addEventListener('click', () => {
                        thinkingEl.classList.toggle('expanded');
                    });
                }
                thinkingEl.querySelector('.thinking-content').textContent =
                    thinking.replace(/<\/?thinking>/gi, '').trim();
            } else if (thinkingEl) {
                thinkingEl.remove();
            }

            // Render visible content
            textDiv.innerHTML = renderMarkdown(rest || '');
        }
        if (scrollToBottomFn) scrollToBottomFn();
    }

    /** Handle an incoming streaming chunk. */
    function streamChunk(chunk, messagesArea, setStatusFn, showTypingFn, removeTypingFn, scrollToBottomFn) {
        let streamRow = document.getElementById('streamMsg');
        if (!streamRow) {
            // First chunk — trim leading newlines only (preserve indentation for code blocks)
            chunk = chunk.replace(/^\r?\n+/g, '');
            if (!chunk) return;

            removeTypingFn();
            isStreaming = true;
            setStatusFn('active');

            streamRow = document.createElement('div');
            streamRow.className = 'msg-row';
            streamRow.id = 'streamMsg';

            const avatar = document.createElement('div');
            avatar.className = 'msg-avatar ai';
            avatar.textContent = getAssistantInitials();

            const body = document.createElement('div');
            body.className = 'msg-body';

            const roleLabel = document.createElement('div');
            roleLabel.className = 'msg-role ai';
            roleLabel.textContent = assistantName;

            // Hide role label if previous message was also from AI, show "..." instead
            const lastRow = messagesArea.querySelector('.msg-row:last-child');
            if (lastRow) {
                const lastAvatar = lastRow.querySelector('.msg-avatar');
                if (lastAvatar && lastAvatar.classList.contains('ai')) {
                    roleLabel.textContent = '…';
                    roleLabel.className = 'msg-role ai msg-role-continuation';
                }
            }

            const textDiv = document.createElement('div');
            textDiv.className = 'msg-text';
            textDiv.id = 'streamText';

            body.appendChild(roleLabel);
            body.appendChild(textDiv);

            // Add action bar placeholder (will be updated in finalizeStream)
            const actions = document.createElement('div');
            actions.className = 'msg-actions';
            actions.id = 'streamActions';
            body.appendChild(actions);

            streamRow.appendChild(avatar);
            streamRow.appendChild(body);
            messagesArea.appendChild(streamRow);
        }

        streamBuffer += chunk;

        // P6-T10: proper throttle. `flushStreamRender` nulls `_renderTimer`
        // internally, and the old code reassigned the timer without clearing it,
        // so a burst of chunks orphaned N timers and re-rendered the whole buffer
        // once per chunk. Render immediately when no timer is pending; otherwise
        // coalesce into a single trailing render one interval later.
        if (_renderTimer) {
            clearTimeout(_renderTimer);
            _renderTimer = null;
        }
        if (!_lastStreamRenderAt || (Date.now() - _lastStreamRenderAt) >= RENDER_INTERVAL_MS) {
            _lastStreamRenderAt = Date.now();
            flushStreamRender(scrollToBottomFn);
        } else {
            _renderTimer = setTimeout(() => {
                _lastStreamRenderAt = Date.now();
                flushStreamRender(scrollToBottomFn);
            }, RENDER_INTERVAL_MS);
        }
    }

    /** Finalize a streaming turn. */
    function finalizeStream(interrupted, messagesArea, setStatusFn, scrollToBottomFn, vscode, durationMs, tokens) {
        isStreaming = false;
        const streamRow = document.getElementById('streamMsg');
        if (!streamRow) {
            // Tool-only turn, no streamed text. The backend posts streamEnd
            // after EVERY tool-calling turn (not just the final one) so the
            // stream bubble finalizes before tool blocks render — this does
            // NOT mean the overall turn is done. Only reset to "Ready" if
            // nothing is still running; otherwise a turn with more tool calls
            // ahead (e.g. a long wait_for_agent) would flash "Ready" and
            // leave it there, even though the assistant is still working.
            // The next real progress update (status/toolCall/etc.) will
            // correct the display once something happens — this just avoids
            // stomping the current state in between.
            if (!isProcessing) {
                setStatusFn('done', 'Ready');
            }
            return;
        }
        const textDiv = document.getElementById('streamText');
        let plainText = streamBuffer;

        // Trim trailing blank lines (models often emit \n\n before tool calls).
        // Re-render markdown from trimmed plain text to keep HTML in sync.
        plainText = plainText.replace(/\s+$/, '');
        const finalHtml = renderMarkdown(plainText);

        /* Convert streamRow in-place to a proper AI message.
         * Do NOT move it — with streamEnd sent before tool calls each turn,
         * the DOM order is already sequential: AI text → tool blocks → next AI text. */
        streamRow.removeAttribute('id');
        streamRow.className = 'msg-row';
        streamRow.innerHTML = '';

        const avatar = document.createElement('div');
        avatar.className = 'msg-avatar ai';
        avatar.textContent = getAssistantInitials();

        const body = document.createElement('div');
        body.className = 'msg-body';

        const roleLabel = document.createElement('div');
        roleLabel.className = 'msg-role ai';
        roleLabel.textContent = assistantName;

        // Hide if previous message was also from AI, show "..." instead
        const prevRow = streamRow.previousElementSibling?.closest('.msg-row');
        if (prevRow) {
            const prevAvatar = prevRow.querySelector('.msg-avatar');
            if (prevAvatar && prevAvatar.classList.contains('ai')) {
                roleLabel.textContent = '…';
                roleLabel.className = 'msg-role ai msg-role-continuation';
            }
        }

        const newTextDiv = document.createElement('div');
        newTextDiv.className = 'msg-text';
        newTextDiv.innerHTML = finalHtml;

        body.appendChild(roleLabel);
        body.appendChild(newTextDiv);

        if (interrupted) {
            const notice = document.createElement('div');
            notice.className = 'interrupted-notice';
            notice.textContent = '\u23f9 Stopped by user';
            body.appendChild(notice);
        }

        body.appendChild(createActionBar(plainText || '', messagesArea, vscode));
        const caption = createStatsCaption(durationMs, tokens);
        if (caption) body.appendChild(caption);

        streamRow.appendChild(avatar);
        streamRow.appendChild(body);

        streamBuffer = '';
        _lastStreamRenderAt = 0; // reset throttle so the next turn renders immediately
        if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
        scrollToBottomFn();
    }

    /** Show a compact result banner in the messages area. Auto-dismisses after 8 seconds. */
    function showCompactBanner(messagesArea, beforeTokens, afterTokens, compressed, dropped, retrievedTokensDropped) {
        // Remove existing banner if any
        const existing = document.getElementById('compactBanner');
        if (existing) existing.remove();

        const savedScrollTop = messagesArea.scrollTop;
        const savedScrollHeight = messagesArea.scrollHeight;

        const banner = document.createElement('div');
        banner.id = 'compactBanner';
        // P6-T11: guard against beforeTokens === 0 (compact at ~0 tokens → NaN%).
        const savedPct = beforeTokens > 0
            ? Math.max(0, Math.round(((beforeTokens - afterTokens) / beforeTokens) * 100))
            : 0;
        const detailParts = [];
        if (compressed > 0) detailParts.push(`${compressed} messages summarized`);
        if (dropped > 0) detailParts.push(`${dropped} messages dropped`);
        if (retrievedTokensDropped > 0) detailParts.push(`${Math.round(retrievedTokensDropped / 1000)}K retrieved context cleared`);

        banner.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;margin:8px 0;
                background:rgba(56,139,253,0.08);border:1px solid rgba(56,139,253,0.2);
                border-radius:6px;font-size:12px;color:var(--vscode-foreground,#cccccc);">
                <span style="font-size:16px;">📦</span>
                <span><strong>Compacted</strong> — ${Math.round(beforeTokens / 1000)}K → ${Math.round(afterTokens / 1000)}K tokens (${savedPct}% freed)</span>
                ${detailParts.length > 0 ? `<span style="color:var(--vscode-descriptionForeground,#858585);margin-left:auto;">${detailParts.join(', ')}</span>` : ''}
                <button class="compact-banner-close" style="background:none;border:none;color:var(--vscode-descriptionForeground,#858585);cursor:pointer;font-size:14px;padding:0 4px;">✕</button>
            </div>
        `;

        messagesArea.insertBefore(banner, messagesArea.firstChild);

        // Restore scroll position so the banner doesn't jump the view
        messagesArea.scrollTop = messagesArea.scrollHeight - savedScrollHeight + savedScrollTop;

        // Close button
        banner.querySelector('.compact-banner-close')?.addEventListener('click', () => banner.remove());

        // Auto-dismiss after 8 seconds
        setTimeout(() => {
            if (banner.parentElement) {
                banner.style.transition = 'opacity 0.5s';
                banner.style.opacity = '0';
                setTimeout(() => banner.remove(), 500);
            }
        }, 8000);
    }

    /**
     * Live compaction progress — previously the only feedback during
     * compaction was a status-line text that could sit unchanged for many
     * seconds while a batch's summarization API call was in flight, with no
     * total to compare "batch N" against, AND it briefly lived inline at the
     * top of the scrolling chat — immediately scrolled out of view by anyone
     * looking at the composer, which is exactly why it looked like "no
     * status" at all. #compactProgressBar is a sticky element above the
     * composer (same placement pattern as #approvalBar), always visible
     * regardless of scroll position, updated in place on each
     * compactProgress message with a real percentage toward the compact
     * target.
     */
    function showCompactProgress(round, maxRounds, beforeTokens, currentTokens, targetTokens, detail) {
        const el = document.getElementById('compactProgressBar');
        if (!el) return;

        const denom = Math.max(1, beforeTokens - targetTokens);
        const pct = Math.max(0, Math.min(100, Math.round(((beforeTokens - currentTokens) / denom) * 100)));

        if (!el.querySelector('.compact-progress-label')) {
            el.innerHTML = `
                <div class="compact-progress-row">
                    <span>📦</span>
                    <span class="compact-progress-label"></span>
                    <span class="compact-progress-pct"></span>
                </div>
                <div class="compact-progress-track">
                    <div class="compact-progress-fill"></div>
                </div>
            `;
        }
        el.style.display = 'flex';

        const label = el.querySelector('.compact-progress-label');
        const pctEl = el.querySelector('.compact-progress-pct');
        const fill = el.querySelector('.compact-progress-fill');
        const roundLabel = maxRounds ? `round ${round}/${maxRounds}` : 'starting';
        if (label) label.textContent = `Compacting — ${roundLabel}${detail ? ' — ' + detail : ''} (${Math.round(currentTokens / 1000)}K → ${Math.round(targetTokens / 1000)}K target)`;
        if (pctEl) pctEl.textContent = pct + '%';
        if (fill) fill.style.width = pct + '%';
    }

    /** Hide the live compaction progress bar, if present. */
    function removeCompactProgress() {
        const el = document.getElementById('compactProgressBar');
        if (el) el.style.display = 'none';
    }

    /** Load restored messages from storage into the messages area. */
    function loadMessages(messages, mode, messagesArea, hideEmptyFn, showEmptyFn, updateModeLabelFn, scrollToBottomFn, vscode, preserveAgentCards) {
        // Preserve child elements that are managed independently of message history.
        // innerHTML = '' destroys all children including emptyState.
        // (Approval cards live in the separate #approvalBar now, not here —
        // they survive this reset for free, no save/restore needed.)
        const emptyEl = document.getElementById('emptyState');
        const emptyClone = emptyEl ? emptyEl.cloneNode(true) : null;
        // Save the live question card too
        let savedQuestionCard = null;
        if (pendingQuestion) {
            const questionCard = document.getElementById('questionCard');
            if (questionCard) {
                savedQuestionCard = questionCard;
                questionCard.remove();
            }
        }
        messagesArea.innerHTML = '';
        if (emptyClone) messagesArea.appendChild(emptyClone);
        // Restore the question card on top of messages
        if (savedQuestionCard && pendingQuestion) {
            messagesArea.appendChild(savedQuestionCard);
        }

        // Clear stale agent cards when loading a new chat's message history —
        // they belong to the previous chat and should not persist across
        // switches. Skipped when preserveAgentCards is set (the backend told
        // us this reload is a same-chat resync — e.g. a panel visibility
        // toggle mid-turn — not an actual chat switch): a running sub-agent's
        // live card has no persisted history to reconstruct from yet (that
        // only exists once its wait_for_agent result lands), so clearing it
        // here would permanently lose its in-progress output.
        if (!preserveAgentCards) {
            for (const [agentId, cardState] of _agentCards) {
                if (cardState.card.parentNode) {
                    cardState.card.remove();
                }
            }
            _agentCards.clear();
        }

        Object.keys(toolBlocksMap).forEach(k => delete toolBlocksMap[k]);

        if (mode) {
            updateModeLabelFn(mode);
        }

        if (!messages || messages.length === 0) {
            showEmptyFn();
            return;
        }

        hideEmptyFn();

        // Build a map of tool_call_id → result from role:tool messages
        const toolResults = new Map();
        for (const m of messages) {
            if (m.role === 'tool' && m.tool_call_id) {
                try {
                    const parsed = JSON.parse(m.content);
                    toolResults.set(m.tool_call_id, parsed);
                } catch {
                    toolResults.set(m.tool_call_id, { success: true, output: m.content });
                }
            }
        }

        // Pre-pass: reconstruct sub-agent runs from history so they render as a
        // proper (static, read-only) agent card on reload instead of a plain
        // JSON tool block. This is purely a rendering decision — it reads the
        // SAME data that's already in the persisted transcript (nothing new is
        // added to what's sent to the model). Keyed by agentId, gathered across
        // possibly-separate spawn_agent / wait_for_agent tool calls.
        const agentRuns = new Map();
        for (const m of messages) {
            if (m.role !== 'assistant' || !m.tool_calls) continue;
            for (const tc of m.tool_calls) {
                const fn = tc.function || {};
                if (fn.name !== 'spawn_agent' && fn.name !== 'wait_for_agent') continue;

                let args = {};
                try { args = JSON.parse(fn.arguments || '{}'); } catch {}

                const outer = toolResults.get(tc.id);
                let inner = null;
                if (outer && typeof outer.output === 'string') {
                    try { inner = JSON.parse(outer.output); } catch {}
                }

                if (fn.name === 'spawn_agent') {
                    const agentId = inner && inner.id;
                    if (!agentId) continue;
                    const existing = agentRuns.get(agentId) || {};
                    agentRuns.set(agentId, {
                        ...existing,
                        prompt: args.prompt || existing.prompt || (inner && inner.prompt) || '',
                        toolAllowlist: (args.toolAllowlist || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
                    });
                } else {
                    // wait_for_agent — agentId comes from the call's ARGUMENTS,
                    // not the result (the result may omit it on some error paths).
                    const agentId = args.agentId;
                    if (!agentId) continue;
                    const existing = agentRuns.get(agentId) || {};
                    agentRuns.set(agentId, {
                        ...existing,
                        result: inner || existing.result || null,
                        outerError: (outer && outer.error) || existing.outerError,
                    });
                }
            }
        }
        const renderedAgentIds = new Set();

        for (const m of messages) {
            if (m.role === 'system') continue;
            if (m.role === 'tool') continue;

            if (m.role === 'user') {
                addMessage(m.content, 'user', messagesArea, scrollToBottomFn, hideEmptyFn, vscode);
            } else if (m.role === 'assistant') {
                /* Render AI text first, then tool blocks (matches live streaming order). */
                const visible = m.content ? stripToolMarkupFromContent(m.content) : '';
                if (visible) {
                    addMessage(visible, 'ai', messagesArea, scrollToBottomFn, hideEmptyFn, vscode, m._partial);
                }

                if (m.tool_calls && m.tool_calls.length > 0) {
                    for (const tc of m.tool_calls) {
                        const fn0 = tc.function || {};

                        // Sub-agent lifecycle calls render as a static, read-only
                        // agent card (reconstructed from the same persisted data)
                        // instead of a plain JSON tool block.
                        if (fn0.name === 'spawn_agent' || fn0.name === 'wait_for_agent') {
                            let callArgs = {};
                            try { callArgs = JSON.parse(fn0.arguments || '{}'); } catch {}
                            const outerResult = toolResults.get(tc.id) || null;
                            let agentId = null;
                            if (fn0.name === 'wait_for_agent') {
                                agentId = callArgs.agentId || null;
                            } else if (outerResult && typeof outerResult.output === 'string') {
                                try { agentId = JSON.parse(outerResult.output).id || null; } catch {}
                            }
                            if (agentId) {
                                if (renderedAgentIds.has(agentId)) continue; // already rendered via an earlier call
                                renderedAgentIds.add(agentId);
                                renderStaticAgentCard(agentId, agentRuns.get(agentId) || {}, messagesArea);
                                continue;
                            }
                            // No agentId resolvable — fall through to generic rendering below.
                        }

                        const block = document.createElement('div');
                        const fn = tc.function || {};
                        const isCompact = compactTools.has(fn.name);
                        const result = toolResults.get(tc.id) || null;
                        const isSuccess = result ? result.success !== false : true;

                        // Icon per tool type
                        const toolIcons = {
                            read_file: '\ud83d\udcc4', list_dir: '\ud83d\udcc1', search_files: '\ud83d\udd0d', grep_search: '\ud83d\udd0d',
                            apply_patch: '\u270f\ufe0f', execute_command: '\u2699\ufe0f', glob: '\ud83d\udd0e', web_fetch: '\ud83c\udf10',
                            write_file: '\ud83d\udcdd', edit_file: '\u270f\ufe0f', git_status: '\ud83d\udee3\ufe0f', git_commit: '\u2705',
                            git_diff: '\ud83d\udd0d', git_log: '\ud83d\udcdc', git_stage: '\ud83d\udce6', git_unstage: '\ud83d\udce5',
                            create_checkpoint: '\ud83d\udcbe', list_checkpoints: '\ud83d\udccb', restore_checkpoint: '\ud83d\udd04'
                        };
                        const icon = toolIcons[fn.name] || '\ud83d\udd27';

                        let argsSummary = '';
                        let argsParsed = {};
                        try {
                            argsParsed = JSON.parse(fn.arguments || '{}');
                            if (argsParsed.path) argsSummary = argsParsed.path;
                            else if (argsParsed.file_path || argsParsed.filePath) argsSummary = argsParsed.file_path || argsParsed.filePath;
                            else if (argsParsed.command) argsSummary = argsParsed.command.slice(0, 80);
                            else if (argsParsed.pattern) argsSummary = argsParsed.pattern;
                            else if (argsParsed.label) argsSummary = argsParsed.label;
                            else {
                                const keys = Object.keys(argsParsed);
                                if (keys.length > 0) {
                                    const firstVal = argsParsed[keys[0]];
                                    argsSummary = typeof firstVal === 'string' ? firstVal.slice(0, 80) : JSON.stringify(firstVal).slice(0, 80);
                                }
                            }
                        } catch {}

                        // Get tool output for body
                        let toolOutput = '';
                        let toolError = '';
                        if (result) {
                            toolOutput = result.output || '';
                            toolError = result.error || '';
                        }

                        if (isCompact) {
                            const statusIcon = isSuccess ? '\u2713' : '\u2717';
                            block.className = `tool-block ${isSuccess ? 'success' : 'error'} compact`;
                            block.innerHTML = `
                                <div class="tool-header">
                                    <span class="tool-icon">${icon}</span>
                                    <span class="tool-name">${escHtml(fn.name || 'tool')}</span>
                                    ${argsSummary ? `<span class="tool-summary">${escHtml(argsSummary)}</span>` : ''}
                                    <span class="tool-status-icon">${statusIcon}</span>
                                </div>
                                <div class="tool-body"></div>
                            `;
                            // Show output in body if available (hidden by default, click to reveal)
                            if (toolOutput || toolError) {
                                const body = block.querySelector('.tool-body');
                                body.textContent = toolError || toolOutput;
                                body.classList.add('has-content');
                                block.querySelector('.tool-header').addEventListener('click', () => {
                                    body.classList.toggle('visible');
                                });
                            }
                        } else {
                            const statusIcon = isSuccess ? '\u2713' : '\u2717';
                            block.className = `tool-block ${isSuccess ? 'success' : 'error'}`;
                            const bodyContent = toolError
                                ? `<span class="error-text">Error: ${escHtml(toolError)}</span>`
                                : toolOutput
                                    ? escHtml(toolOutput)
                                    : escHtml(fn.arguments || '');
                            block.innerHTML = `
                                <div class="tool-header">
                                    <span class="tool-chevron open">\u25b6</span>
                                    <span class="tool-name">${escHtml(fn.name || 'tool')}</span>
                                    ${argsSummary ? `<span class="tool-summary">${escHtml(argsSummary)}</span>` : ''}
                                    <span class="tool-status-icon">${statusIcon}</span>
                                </div>
                                <div class="tool-body visible">${bodyContent}</div>
                            `;
                            block.querySelector('.tool-header').addEventListener('click', () => {
                                const body = block.querySelector('.tool-body');
                                const chevron = block.querySelector('.tool-chevron');
                                body.classList.toggle('visible');
                                chevron.classList.toggle('open');
                            });
                        }

                        messagesArea.appendChild(block);
                    }
                }
            }
        }

        scrollToBottomFn();
    }

    /** Render attached file pills with remove buttons. */
    function renderAttachedFiles(files, attachedFilesDiv) {
        attachedFilesDiv.innerHTML = '';
        files.forEach((f, i) => {
            const pill = document.createElement('span');
            pill.className = 'file-pill';
            pill.innerHTML = `\ud83d\udcc4 ${escHtml(f.name)} <span class="remove-file" data-index="${i}">\u00d7</span>`;
            attachedFilesDiv.appendChild(pill);
        });

        attachedFilesDiv.querySelectorAll('.remove-file').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index);
                files.splice(idx, 1);
                renderAttachedFiles(files, attachedFilesDiv);
            });
        });
    }

    // ============================================================
    //  Main — Entry point, DOM wiring, message loop
    // ============================================================

    const vscode = acquireVsCodeApi();
    // Expose globally so the heartbeat outside the IIFE can use it.
    window.__vscode_api = vscode;
    window._vscode = vscode;

    // --- DOM refs ---
    const messagesArea       = document.getElementById('messages');
    const messageInput       = document.getElementById('messageInput');
    const sendBtn            = document.getElementById('sendBtn');
    const stopBtn            = document.getElementById('stopBtn');
    const attachBtn          = document.getElementById('attachBtn');
    const fileInput          = document.getElementById('fileInput');
    const emptyState         = document.getElementById('emptyState');
    const statusLine         = document.getElementById('statusLine');
    const statusDot          = document.getElementById('statusDot');
    const statusText         = document.getElementById('statusText');
    const charCount          = document.getElementById('charCount');
    const attachedFilesDiv   = document.getElementById('attachedFiles');

    // Chat list
    const chatListPanel      = document.getElementById('chatListPanel');
    const chatListEl         = document.getElementById('chatList');
    const toggleChatList     = document.getElementById('toggleChatList');

    // Mode dropdown in composer
    const modeDropdownBtn    = document.getElementById('modeDropdownBtn');
    const modeDropdownPanel  = document.getElementById('modeDropdown');
    const currentModeLabel   = document.getElementById('currentModeLabel');

    // Model selector
    const modelSelectorBtn   = document.getElementById('modelDropdownBtn');
    const modelSelectorEl    = document.getElementById('modelDropdown');

    // Settings
    const settingsBtn        = document.getElementById('settingsBtn');

    // State
    let activeChatId = null;
    let chatListVisible = false;

    // --- Init sub-modules ---
    initStatus(messagesArea, statusLine, statusDot, statusText, charCount, emptyState, currentModeLabel, () => vscode, () => currentMode);

    // --- Composer init ---
    initComposer({
        messageInput,
        sendBtn,
        stopBtn,
        attachBtn,
        fileInput,
        charCount,
        messagesArea,
        modeDropdownBtn,
        modeDropdownPanel,
        currentModeLabel,
        attachedFilesDiv,
        vscode,
        callbacks: {
            onSendMessage(text) {
                addMessage(text, 'user', messagesArea, scrollToBottom, hideEmpty, vscode);

                messageInput.value = '';
                messageInput.style.height = 'auto';
                if (charCount) charCount.textContent = '';

                // Clear stale streaming state
                removeTyping();
                const staleStream = document.getElementById('streamMsg');
                if (staleStream) staleStream.remove();
                streamBuffer = '';

                setStatus('active', 'Connecting...');
                autoScroll = true;

                vscode.postMessage({
                    command: 'sendMessage',
                    text,
                    mode: currentMode
                });

                attachedFiles = [];
                renderAttachedFiles(attachedFiles, attachedFilesDiv);
                showTyping();
            },
            onStopGeneration() {
                vscode.postMessage({ command: 'stopGeneration' });
            },
            onAttachFile(name, content) {
                attachedFiles.push({ name, content });
                renderAttachedFiles(attachedFiles, attachedFilesDiv);
            },
            scrollToBottom: scrollToBottom,
            hideEmpty: hideEmpty,
            removeTyping: removeTyping,
            setStatus: setStatus,
            showTyping: showTyping,
            renderAttachedFiles: () => renderAttachedFiles(attachedFiles, attachedFilesDiv),
        }
    });

    // --- Init configure form (welcome screen) ---
    initConfigureForm(vscode);

    // --- Chat list panel (dropdown) ---
    if (chatListPanel) chatListPanel.style.display = 'none';

    if (toggleChatList) {
        toggleChatList.addEventListener('click', (e) => {
            e.stopPropagation();
            chatListVisible = !chatListVisible;
            if (chatListPanel) {
                chatListPanel.style.display = chatListVisible ? '' : 'none';
            }
        });
    }

    // Close chat list dropdown on click outside
    document.addEventListener('click', (e) => {
        if (chatListPanel && chatListVisible &&
            !chatListPanel.contains(e.target) &&
            !toggleChatList?.contains(e.target)) {
            chatListVisible = false;
            chatListPanel.style.display = 'none';
        }
    });

    // Prevent clicks inside the dropdown from closing it
    chatListPanel?.addEventListener('click', (e) => e.stopPropagation());

    // New chat button
    document.getElementById('newChatBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'newChat' });
    });

    // Settings button
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'openSettings' });
        });
    }

    // Model selector dropdown
    if (modelSelectorBtn && modelSelectorEl) {
        modelSelectorBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (modelSelectorEl.classList.contains('open')) {
                modelSelectorEl.classList.remove('open');
                hideAddModelForm();
            } else {
                modeDropdownPanel.classList.remove('open');
                vscode.postMessage({ command: 'listModels' });
                modelSelectorEl.classList.add('open');
            }
        });
    }

    // Wire up "Add Model" button in dropdown (event delegation)
    if (modelSelectorEl) {
        modelSelectorEl.addEventListener('click', e => {
            const addBtn = e.target.closest('[data-action="add"]');
            if (addBtn) {
                showAddModelForm(modelSelectorEl, vscode);
            }
        });
    }

    // Close dropdowns on outside click
    document.addEventListener('click', e => {
        // Close model dropdown
        if (modelSelectorEl && !modelSelectorEl.contains(e.target) && e.target !== modelSelectorBtn && !(modelSelectorBtn && modelSelectorBtn.contains(e.target))) {
            modelSelectorEl.classList.remove('open');
            hideAddModelForm();
        }
        // Close mode dropdown
        const modeDropdown = document.getElementById('modeDropdownPanel');
        const modeBtn = document.getElementById('modeSelectorBtn');
        if (modeDropdown && modeBtn && !modeDropdown.contains(e.target) && !modeBtn.contains(e.target)) {
            modeDropdown.classList.remove('open');
        }
    });

    // --- Suggestion chips (event delegation) ---
    messagesArea.addEventListener('click', e => {
        const chip = e.target.closest('.suggestion-chip');
        if (chip && chip.dataset.text) {
            messageInput.value = chip.dataset.text;
            messageInput.focus();
        }
    });

    // --- Copy button delegation (code blocks) ---
    messagesArea.addEventListener('click', e => {
        const copyBtn = e.target.closest('.copy-btn');
        if (!copyBtn) return;
        const id = copyBtn.dataset.copy;
        const codeEl = document.getElementById(id);
        if (codeEl) {
            navigator.clipboard.writeText(codeEl.textContent).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = 'Copy', 1500);
            });
        }
    });

    // --- Message handler ---
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
            case 'receiveMessage':
                removeTyping();
                addMessage(msg.text, 'ai', messagesArea, scrollToBottom, hideEmpty, vscode, false,
                    (typeof msg.durationMs === 'number') ? { durationMs: msg.durationMs, tokens: msg.tokens } : null);
                if (msg.isError) {
                    setStatus('error', 'Error — click to retry');
                    sendBtn.disabled = false;
                } else if (!isProcessing) {
                    // Same class of bug as finalizeStream's tool-only branch:
                    // receiveMessage can render an assistant text message that
                    // is NOT the end of the turn (e.g. an early-exit notice),
                    // so only claim "Ready" when nothing is actually still
                    // running — otherwise this stomps a genuinely still-active
                    // turn's status/Stop-button state with a false "done."
                    setStatus('done', 'Ready');
                    sendBtn.disabled = false;
                }
                break;

            case 'streamChunk':
                // Drop stray chunks that arrived after we switched chats.
                // If streaming stopped but we got a chunk, it belongs to an old turn.
                if (!isStreaming && !isProcessing) {
                    console.debug('[chat] Dropping stray streamChunk — no active stream');
                    break;
                }
                streamChunk(msg.text, messagesArea, setStatus, showTyping, removeTyping, scrollToBottom);
                break;

            case 'fileAttached':
                break;

            case 'fileError':
                addMessage('\u26a0 ' + msg.error, 'ai', messagesArea, scrollToBottom, hideEmpty, vscode);
                break;

            case 'configLoaded':
                // Hide loading spinner only — do NOT show empty state here.
                // The loadMessages handler (sent immediately after) controls
                // whether the empty state or message history is visible.
                const loadingIndicator = document.getElementById('loadingIndicator');
                if (loadingIndicator) loadingIndicator.style.display = 'none';

                if (msg.defaultMode) {
                    currentMode = msg.defaultMode;
                    updateModeLabel(msg.defaultMode);
                    // Hide plan mode banner when switching to build mode
                    if (msg.defaultMode !== 'plan') {
                        hidePlanModeBlocked();
                    }
                }
                if (msg.modelName) {
                    const modelNameLabel = document.getElementById('modelNameLabel');
                    if (modelNameLabel) {
                        modelNameLabel.textContent = msg.modelNickname || msg.modelName;
                    }
                }
                if (msg.modelName) {
                    const subtitle = document.getElementById('emptySubtitle');
                    if (subtitle) {
                        subtitle.textContent = `Powered by ${msg.modelName} — ask a question, review code, debug an issue, or plan architecture.`;
                    }
                }
                // Restore interaction mode from backend config
                // Store context window size for the context ring
                if (msg.contextWindowSize) {
                    window._ctxLimit = msg.contextWindowSize;
                }

                if (msg.interactionMode) {
                    const intBtn = document.getElementById('interactionModeBtn');
                    const intDropdown = document.getElementById('interactionModeDropdown');
                    if (typeof updateInteractionMode === 'function') {
                        updateInteractionMode(msg.interactionMode);
                    } else {
                        // Fallback: set icon/label directly if function not available yet
                        const icons = { ask: '🔒', autoedit: '✏️', relaxed: '⚡' };
                        const labels = { ask: 'Ask all', autoedit: 'Allow edits', relaxed: 'Relaxed' };
                        const iconEl = document.getElementById('interactionModeIcon');
                        const labelEl = document.getElementById('interactionModeLabel');
                        if (iconEl) iconEl.textContent = icons[msg.interactionMode] || '🔒';
                        if (labelEl) labelEl.textContent = labels[msg.interactionMode] || 'Ask all';
                    }
                }
                // Update assistant display name
                if (msg.assistantName) {
                    assistantName = msg.assistantName;
                }
                break;

            case 'assistantNameChanged':
                if (msg.assistantName) {
                    assistantName = msg.assistantName;
                    // Only affects future messages — existing messages keep their original name/avatar
                }
                break;

            case 'modelsList':
                renderModelDropdown(msg.providers || {}, msg.models || [], msg.currentModel || '', modelSelectorEl);

                // Update button label to match current model (show nickname if set)
                const modelNameLabel = document.getElementById('modelNameLabel');
                if (modelNameLabel && msg.currentModel) {
                    const cachedModel = (msg.models || []).find(m => m.name === msg.currentModel);
                    modelNameLabel.textContent = cachedModel?.nickname || msg.currentModel;
                }

                // Show/hide configure CTA based on whether models exist
                const emptyConfigure = document.getElementById('emptyConfigure');
                const emptySuggestions = document.getElementById('emptySuggestions');
                const emptyCapabilities = document.getElementById('emptyCapabilities');
                if (emptyConfigure && emptySuggestions && emptyCapabilities) {
                    const hasModels = (msg.models || []).length > 0;
                    emptyConfigure.style.display = hasModels ? 'none' : '';
                    emptySuggestions.style.display = hasModels ? '' : 'none';
                    emptyCapabilities.style.display = hasModels ? '' : 'none';
                }
                if (!(msg.models || []).length) {
                    if (modelNameLabel) modelNameLabel.textContent = 'No model';
                }
                break;

            case 'modelSwitched':
                if (msg.modelName) {
                    const modelNameLabel2 = document.getElementById('modelNameLabel');
                    if (modelNameLabel2) {
                        modelNameLabel2.textContent = msg.modelNickname || msg.modelName;
                    }
                }
                modelSelectorEl.classList.remove('open');
                hideAddModelForm();
                vscode.postMessage({ command: 'listModels' });
                break;

            case 'status':
                // Only compact()'s per-round posts carry chatId; normal
                // sendMessage() status updates don't set it and pass through
                // unaffected (msg.chatId == null short-circuits the check).
                if (msg.chatId != null && activeChatId != null && msg.chatId !== activeChatId) {
                    console.debug('[chat] Dropping status for non-active chat', msg.chatId);
                    break;
                }
                if (msg.text === 'ok' || msg.text === '') {
                    if (!isStreaming && !isProcessing) {
                        setStatus('done', 'Ready');
                        sendBtn.disabled = false;
                    }
                } else if (msg.text) {
                    setStatus('active', msg.text);
                    sendBtn.disabled = true;
                    if (!document.getElementById('typingIndicator')) {
                        showTyping();
                    }
                }
                break;

            case 'setStatus':
                // Explicit status reset from backend (chat switch / new chat).
                setStatus(msg.state, msg.text);
                isProcessing = false;
                isStreaming = false;
                if (stopBtn && sendBtn) {
                    stopBtn.style.display = 'none';
                    sendBtn.style.display = '';
                    sendBtn.disabled = false;
                }
                break;

            case 'toolStatus':
                setStatus('active', msg.text || '');
                break;

            case 'toolCall':
                if (!isProcessing) {
                    console.debug('[chat] Dropping stray toolCall — not processing');
                    break;
                }
                addToolBlock(msg.toolId, msg.toolName, msg.args, messagesArea, scrollToBottom);
                break;

            case 'toolResult':
                if (!isProcessing) {
                    console.debug('[chat] Dropping stray toolResult — not processing');
                    break;
                }
                updateToolBlock(msg.toolId, msg.output, msg.success, msg.error, scrollToBottom, msg.autoApprovedBy);
                break;

            case 'clearMessages':
                {
                    const emptyEl = document.getElementById('emptyState');
                    const emptyClone = emptyEl ? emptyEl.cloneNode(true) : null;
                    // Approval cards live in #approvalBar now, not here — they
                    // survive this reset for free, no save/restore needed.
                    messagesArea.innerHTML = '';
                    if (emptyClone) messagesArea.appendChild(emptyClone);
                    toolBlocksMap = {};
                    // Also clear agent cards so they don't leak into the new chat
                    for (const [, cs] of _agentCards) { if (cs.card.parentNode) cs.card.remove(); }
                    _agentCards.clear();
                    // Reset streaming/processing state for the new chat
                    isStreaming = false;
                    isProcessing = false;
                    streamBuffer = '';
                    // Reset context ring to 0 tokens — tokenCount will follow with correct limit
                    updateContextRing(0, window._ctxLimit || 128000);
                    break;
                }

            case 'loadMessages':
                {
                    const hasMsgRows = messagesArea.querySelector('.msg-row');
                    // Whether the backend says a turn is still genuinely in
                    // flight (sent explicitly as msg.processing — the backend
                    // is the authority here, e.g. after a panel visibility
                    // toggle mid-turn, as opposed to an actual chat switch).
                    // Declared at this scope so it's available both to the
                    // button-state guard below AND to loadMessages() further
                    // down, which uses it to decide whether to preserve a
                    // still-running sub-agent's live card.
                    const stillProcessing = Boolean(msg.forceReload) && msg.processing === true;
                    if (!hasMsgRows || msg.forceReload) {
                        if (msg.forceReload) {
                            removeTyping();
                            const streamRow = document.getElementById('streamMsg');
                            if (streamRow) streamRow.remove();
                            removeApprovalCard();
                            pendingApproval = null;
                            streamBuffer = '';

                            // Previously this block unconditionally zeroed
                            // isProcessing and then checked that same
                            // just-zeroed flag, so the guard below was always a
                            // no-op: every forceReload hid the Stop button and
                            // showed Send even while the backend kept running,
                            // which then caused every subsequent toolCall/toolResult
                            // to be dropped (gated on isProcessing) and left the
                            // chat looking permanently stuck.
                            if (!stillProcessing) {
                                isStreaming = false;
                                isProcessing = false;
                                clearQueue();
                                if (stopBtn && sendBtn) {
                                    stopBtn.style.display = 'none';
                                    sendBtn.style.display = '';
                                    sendBtn.disabled = false;
                                }
                            }
                            attachedFiles = [];
                            renderAttachedFiles(attachedFiles, attachedFilesDiv);
                        }
                        // Set assistant name before rendering messages
                        if (msg.assistantName) {
                            assistantName = msg.assistantName;
                        }
                        loadMessages(
                            msg.messages,
                            msg.mode,
                            messagesArea,
                            hideEmpty,
                            showEmpty,
                            updateModeLabel,
                            scrollToBottom,
                            vscode,
                            stillProcessing
                        );
                        // Update expand history button visibility
                        updateExpandHistoryButton(msg.hasTranscript);
                    }
                    break;
                }

            case 'activeChatChanged':
                // Track which chat is active so we can drop stray messages
                // from a previous chat whose promises may still be resolving.
                activeChatId = msg.chatId;
                // #compactProgressBar lives outside the scrollable messages
                // area (so it can't be scrolled out of view), which means it
                // does NOT get cleared by loadMessages()'s innerHTML reset
                // the way stray in-scroll-area content would be. If a chat
                // switch interrupts a running compact(), it now bails out
                // server-side without ever sending compactDone (see
                // conversationManager.ts) — so without this, the bar would
                // otherwise be stuck showing "Compacting..." forever.
                removeCompactProgress();
                break;

            case 'chatList':
                renderChatList(msg.chats, msg.activeChatId, chatListEl, vscode, chatListPanel);
                activeChatId = msg.activeChatId;
                break;

            case 'tokenCount':
                window._ctxLimit = msg.limit; // Persist for compactDone
                updateContextRing(msg.used, msg.limit, msg.msgCount, msg.summaryCount);
                break;

            case 'interactionModeChanged':
                if (msg.mode && typeof updateInteractionMode === 'function') {
                    updateInteractionMode(msg.mode);
                }
                break;

            case 'sessionStats':
                updateSessionStats(msg.requestCount, msg.totalTokens, msg.avgLatencyMs, msg.errorCount);
                break;

            case 'toolApprovalRequest':
                showApprovalRequest(msg.toolId, msg.toolName, msg.args, msg.riskLevel, msg.riskClass, document.getElementById('messages'), vscode, scrollToBottom, msg.agentId);
                break;

            case 'planModeToolBlocked':
                showPlanModeBlocked(String(msg.toolId), String(msg.toolName));
                setStatus('active', 'Waiting for plan mode decision...', false);
                break;

            case 'agentSpawn':
                if (!isProcessing) {
                    console.debug('[chat] Dropping stray agentSpawn — not processing');
                    break;
                }
                // P5-T5 (restored): drop progress from an agent that belongs to a
                // different chat (e.g. a background agent from a conversation we
                // switched away from) so its card doesn't render into this one.
                if (msg.chatId != null && activeChatId != null && msg.chatId !== activeChatId) {
                    console.debug('[chat] Dropping agentSpawn for non-active chat', msg.chatId);
                    break;
                }
                showAgentCard(String(msg.agentId), String(msg.prompt || ''), msg.toolAllowlist || [], messagesArea, scrollToBottom);
                break;

            case 'agentProgress':
                if (!isProcessing) {
                    console.debug('[chat] Dropping stray agentProgress — not processing');
                    break;
                }
                if (msg.chatId != null && activeChatId != null && msg.chatId !== activeChatId) {
                    console.debug('[chat] Dropping agentProgress for non-active chat', msg.chatId);
                    break;
                }
                updateAgentCard(String(msg.agentId), { type: msg.type, toolName: msg.toolName, toolId: msg.toolId, output: msg.output, turn: msg.turn, error: msg.error }, messagesArea, scrollToBottom);
                break;

            case 'showQuestion':
                showQuestionCard(String(msg.questionId), String(msg.question), msg.options || [], msg.multiSelect || false, messagesArea, vscode, scrollToBottom);
                setStatus('active', 'Waiting for your answer...', false);
                break;

            case 'removeQuestion':
                // Dismiss the question card once the extension side is done waiting
                // (answered elsewhere, or the turn was cancelled). Only remove the
                // card if it still matches this questionId, so a stale removal for
                // an old question can't wipe a newer one.
                if (pendingQuestion && (!msg.questionId || pendingQuestion.questionId === msg.questionId)) {
                    const qc = document.getElementById('questionCard');
                    if (qc) qc.remove();
                    pendingQuestion = null;
                }
                break;

            case 'streamEnd':
                finalizeStream(msg.interrupted, messagesArea, setStatus, scrollToBottom, vscode, msg.durationMs, msg.tokens);
                break;

            case 'compactStart':
                // Drop stray compact events from a chat we've since switched
                // away from — compact() runs multiple real API calls and has
                // no way to know the user switched chats mid-flight; without
                // this the progress banner (and the final compactDone one)
                // could render into whatever chat happens to be on screen by
                // the time each message arrives, not the one being compacted.
                // Same pattern already used for agentSpawn/agentProgress.
                if (msg.chatId != null && activeChatId != null && msg.chatId !== activeChatId) {
                    console.debug('[chat] Dropping compactStart for non-active chat', msg.chatId);
                    break;
                }
                setStatus('active', 'Compacting conversation...', false);
                showCompactProgress(0, Number(msg.maxRounds) || 0, Number(msg.beforeTokens), Number(msg.beforeTokens), Number(msg.targetTokens), 'starting');
                break;

            case 'compactProgress':
                if (msg.chatId != null && activeChatId != null && msg.chatId !== activeChatId) {
                    console.debug('[chat] Dropping compactProgress for non-active chat', msg.chatId);
                    break;
                }
                showCompactProgress(Number(msg.round), Number(msg.maxRounds), Number(msg.beforeTokens), Number(msg.currentTokens), Number(msg.targetTokens), String(msg.detail || ''));
                break;

            case 'compactStopped':
                // User clicked Stop mid-compact, on the SAME chat that's
                // still active (a chat switch is handled separately by
                // activeChatChanged, since compact() never posts this for
                // that case — see conversationManager.ts).
                if (msg.chatId != null && activeChatId != null && msg.chatId !== activeChatId) {
                    break;
                }
                removeCompactProgress();
                setStatus('done', 'Compaction stopped');
                break;

            case 'compactDone':
                // Do NOT re-render messages — the visible chat area already shows the full
                // transcript. Re-rendering from compacted apiMessages would wipe out
                // summarized turns the user still wants to see. Just update the UI overlays.
                if (msg.chatId != null && activeChatId != null && msg.chatId !== activeChatId) {
                    console.debug('[chat] Dropping compactDone for non-active chat', msg.chatId);
                    break;
                }

                removeCompactProgress();

                // P6-ish fix: "already under target" (nothing to summarize or
                // drop because the chat was already smaller than the compact
                // target) previously rendered as the exact same
                // "Compacted — NK -> NK tokens" text as a genuine no-progress
                // failure — indistinguishable from a bug. Give it its own
                // message and skip the banner (there's no before/after
                // comparison worth showing when nothing changed by design).
                if (msg.alreadyUnderTarget) {
                    const targetK = Math.round(Number(msg.targetTokens) / 1000);
                    const usedK = Math.round(Number(msg.beforeTokens) / 1000);
                    setStatus('done', `Already compact — ${usedK}K is under the ${targetK}K target, nothing to summarize or drop`);
                    updateExpandHistoryButton(true);
                    break;
                }

                // Show a visual banner inside the message area
                showCompactBanner(messagesArea, Number(msg.beforeTokens), Number(msg.afterTokens), Number(msg.totalCompressed), Number(msg.totalDropped), Number(msg.retrievedTokensDropped));

                // Update context ring with new token count (use stored limit if available)
                const ctxLimit = window._ctxLimit || 128000;
                updateContextRing(Number(msg.afterTokens), ctxLimit);

                // Set final status
                let doneMsg = `Compacted — ${Math.round(Number(msg.beforeTokens) / 1000)}K → ${Math.round(Number(msg.afterTokens) / 1000)}K tokens`;
                if (msg.totalCompressed > 0) doneMsg += ` (${msg.totalCompressed} summarized)`;
                if (msg.totalDropped > 0) doneMsg += ` (${msg.totalDropped} dropped)`;
                if (msg.retrievedTokensDropped > 0) doneMsg += ` (${Math.round(Number(msg.retrievedTokensDropped) / 1000)}K retrieved context cleared)`;
                setStatus('done', doneMsg);

                // Show expand button — compaction created a transcript
                updateExpandHistoryButton(true);
                break;

            case 'retrievedContext':
                showRetrievedContext(msg.chunks, messagesArea, vscode, scrollToBottom);
                break;

            case 'setEditMode':
                enterEditMode(msg.filePath, msg.startLine, msg.endLine, msg.selectedText, messageInput, setStatus);
                break;

            case 'showStopBtn':
                if (stopBtn && sendBtn) {
                    stopBtn.style.display = '';
                    sendBtn.style.display = 'none';
                }
                isStreaming = true;
                break;

            case 'processingState':
                // Single source of truth for button visibility.
                // Survives streamEnd between tool turns and visibility toggles.
                isProcessing = Boolean(msg.processing);
                if (stopBtn && sendBtn) {
                    if (isProcessing) {
                        stopBtn.style.display = '';
                        sendBtn.style.display = 'none';
                        sendBtn.disabled = true;
                    } else {
                        stopBtn.style.display = 'none';
                        sendBtn.style.display = '';
                        sendBtn.disabled = false;
                    }
                }
                break;

            case 'hideStopBtn':
                if (stopBtn && sendBtn) {
                    stopBtn.style.display = 'none';
                    sendBtn.style.display = '';
                    sendBtn.disabled = false;
                }
                isStreaming = false;
                isProcessing = false;
                // Auto-send first queued message when AI finishes (unless user stopped manually)
                if (!msg.wasStopped && pendingQueue.length > 0) {
                    const textToSend = pendingQueue.shift().text;
                    renderPendingQueue();
                    setTimeout(() => {
                        vscode.postMessage({
                            command: 'sendMessage',
                            text: textToSend,
                            mode: currentMode
                        });
                    }, 300);
                }
                break;

            case 'regenerate':
                removeTyping();
                const streamRow2 = document.getElementById('streamMsg');
                if (streamRow2) streamRow2.remove();
                isStreaming = false;
                setStatus('active', 'Regenerating...');

                const allRows = messagesArea.querySelectorAll('.msg-row .msg-avatar.user');
                if (allRows.length > 0) {
                    const lastUserRow = allRows[allRows.length - 1].closest('.msg-row');
                    const lastUserTextDiv = lastUserRow?.querySelector('.msg-text');
                    if (lastUserTextDiv) {
                        const lastText = lastUserTextDiv.textContent.trim();
                        vscode.postMessage({
                            command: 'sendMessage',
                            text: lastText,
                            mode: currentMode
                        });
                    }
                }
                break;

            case 'rebuildIndex':
                setStatus('active', 'Rebuilding index...');
                vscode.postMessage({ command: 'rebuildIndex' });
                break;

            case 'openLogs':
                vscode.postMessage({ command: 'openLogs' });
                break;

            case 'modelsReset':
                modelSelectorEl.classList.remove('open');
                hideAddModelForm();
                break;

            case 'expandHistory':
                // Backend sent the full transcript — re-render all messages
                if (msg.messages && msg.messages.length > 0) {
                    removeTyping();
                    const streamRow3 = document.getElementById('streamMsg');
                    if (streamRow3) streamRow3.remove();
                    loadMessages(
                        msg.messages,
                        null,
                        messagesArea,
                        hideEmpty,
                        showEmpty,
                        updateModeLabel,
                        scrollToBottom,
                        vscode
                    );
                    // Hide the expand button now that history is expanded
                    updateExpandHistoryButton(false);
                }
                break;
        }
    });

    // --- Init ---
    const savedMode = localStorage.getItem('currentMode');
    if (savedMode) currentMode = savedMode;
    updateModeLabel(currentMode);
    initPlanModeBanner(vscode);
    messageInput.focus();
    vscode.postMessage({ command: 'getConfig' });

    // Safety net: if configLoaded doesn't arrive within 3s, hide the spinner
    // and show the empty state so the user isn't stuck on a blank loading screen.
    setTimeout(() => {
        const li = document.getElementById('loadingIndicator');
        if (li && li.style.display !== 'none') {
            li.style.display = 'none';
            const es = document.getElementById('emptyState');
            if (es) es.style.display = '';
        }
    }, 3000);

    // Expand history button — sends command to backend to get full transcript
    const expandHistoryBtn = document.getElementById('expandHistoryBtn');
    if (expandHistoryBtn) {
        expandHistoryBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'expandHistory' });
        });
    }

    // Fix copy in webview: ensure clipboard contains the user's actual text selection.
    // VS Code webviews sometimes grab CSS resource URIs instead of selected text.
    // Strategy: always let the native copy run (no preventDefault), then silently
    // overwrite with navigator.clipboard.writeText so the real selection wins even
    // when the browser captured markup/URIs.
    document.addEventListener('copy', (e) => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (text.length === 0) return;

        // Path A — spec-compliant clipboardData (most webview contexts).
        // Write plain text over whatever the browser grabbed (markup, URIs, etc.).
        if (e.clipboardData) {
            e.preventDefault();
            e.clipboardData.setData('text/plain', text);
            return;
        }

        // Path B — clipboardData is null (sandboxed webview).
        // navigator.clipboard requires a secure context + user gesture.
        // The copy event IS the user gesture, so the call succeeds synchronously
        // in Chrome/Electron >= 66.  Fire-and-forget: if it fails silently the
        // native copy (which we did NOT preventDefault) already delivered
        // whatever the browser captured.
        try { navigator.clipboard.writeText(text); } catch (_) {}
    });

    // Flush any approval that arrived during reinit, now that DOM is ready.
    flushQueuedApproval(messagesArea, vscode, scrollToBottom);

    // Signal backend that the webview DOM is fully initialized.
    vscode.postMessage({ command: 'webviewReady' });

})();

// Keep a top-level heartbeat so the extension host can detect if this
// webview context is still alive after a visibility toggle.
window.addEventListener('message', (e) => {
    if (e.data && e.data.command === 'ping') {
        const hb_vscode = window.__vscode_api;
        if (hb_vscode) hb_vscode.postMessage({ command: 'pong' });
    }
});
