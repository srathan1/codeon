// ============================================================
//  Markdown renderer
// ============================================================
import { escHtml, isSafeUrl } from './utils.js';

// L-8: monotonic counter for code-block DOM ids, replacing Math.random()
// (which had a small but real chance of colliding within one message).
let codeBlockIdCounter = 0;

/**
 * UI-3: table parsing helpers. Replaces a single monolithic regex (which
 * required the header/separator/body rows to be perfectly contiguous and
 * validated the separator row as a whole rather than per-column) with a
 * line-by-line scanner. Still not a full markdown parser — a cell
 * containing an unescaped literal `|` inside inline code/links will still
 * split incorrectly, same limitation any regex-based approach has — but
 * this now: supports `\|` as an escaped literal pipe within a cell,
 * validates each separator cell individually (`:?-+:?`) so alignment
 * markers in any valid position are accepted, and tolerates a row with a
 * different cell count instead of silently dropping the whole row.
 */
function isTableRowLine(line) {
    const t = line.trim();
    return t.startsWith('|') && t.endsWith('|') && t.length >= 2;
}

/** Split a table row into cells, honoring `\|` as an escaped literal pipe. */
function splitTableRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    const cells = [];
    let current = '';
    for (let i = 0; i < t.length; i++) {
        if (t[i] === '\\' && t[i + 1] === '|') {
            current += '|';
            i++;
        } else if (t[i] === '|') {
            cells.push(current.trim());
            current = '';
        } else {
            current += t[i];
        }
    }
    cells.push(current.trim());
    return cells;
}

function isTableSeparatorLine(line) {
    if (!isTableRowLine(line)) return false;
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

function renderTableBlock(headerLine, bodyLines) {
    const headers = splitTableRow(headerLine);
    let tableHtml = '<table><thead><tr>';
    headers.forEach(h => { tableHtml += `<th>${h}</th>`; });
    tableHtml += '</tr></thead><tbody>';
    bodyLines.forEach(line => {
        const cells = splitTableRow(line);
        tableHtml += '<tr>';
        for (let c = 0; c < headers.length; c++) {
            tableHtml += `<td>${cells[c] !== undefined ? cells[c] : ''}</td>`;
        }
        tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table>';
    return tableHtml;
}

/** Scan `html` line-by-line, replacing any GFM-style pipe tables found. */
function renderTables(html) {
    const lines = html.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        if (isTableRowLine(lines[i]) && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
            const bodyLines = [];
            let j = i + 2;
            while (j < lines.length && isTableRowLine(lines[j])) {
                bodyLines.push(lines[j]);
                j++;
            }
            out.push(renderTableBlock(lines[i], bodyLines));
            i = j;
        } else {
            out.push(lines[i]);
            i++;
        }
    }
    return out.join('\n');
}

/** Render markdown text to HTML. */
export function renderMarkdown(text) {
    let html = escHtml(text);

    // Code blocks (```lang ... ```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const langLabel = lang || 'code';
        const blockId = 'cb-' + (codeBlockIdCounter++);
        return `<div class="code-header"><span>${langLabel}</span><button class="copy-btn" data-copy="${blockId}">Copy</button></div><pre><code id="${blockId}">${code}</code></pre>`;
    });

    // Tables (pipe-delimited with separator row) — before inline code so backticks inside cells don't interfere
    html = renderTables(html);

    // Inline code (`...`)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold (**...** or __...)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic (*...* or _..._)
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Links [text](url) — P6-T9: only allow safe URL schemes. A markdown
    // link like [x](javascript:...) must NOT become a clickable javascript:
    // href. Unsafe schemes render as plain text (the label + inert URL).
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
        return isSafeUrl(url)
            ? `<a href="${url}" target="_blank">${label}</a>`
            : `${label} (${url})`;
    });

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr>');

    // Paragraphs (double newlines)
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs wrapping block elements
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>\s*(<h[1-4]>)/g, '$1');
    html = html.replace(/(<\/h[1-4]>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<blockquote>)/g, '$1');
    html = html.replace(/(<\/blockquote>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<hr>)/g, '$1');
    html = html.replace(/(<hr>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<div class="code-header">)/g, '$1');

    // Clean up paragraphs wrapping tables
    html = html.replace(/<p>\s*(<table>)/g, '$1');
    html = html.replace(/(<\/table>)\s*<\/p>/g, '$1');

    return html;
}
