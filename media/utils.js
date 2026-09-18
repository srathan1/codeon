// ============================================================
//  Utils — small, dependency-free string/HTML helpers shared
//  across the webview modules.
// ============================================================

/** Escape HTML special characters. */
export function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * P6-T9: allow only safe link schemes for rendered markdown links. Blocks
 * javascript:/data:/vbscript: and anything else that isn't an ordinary link.
 * Note: by the time this runs the URL has already been HTML-escaped, so a
 * scheme like "javascript" can't hide behind entities in the attribute.
 */
export function isSafeUrl(url) {
    const trimmed = String(url || '').trim();
    // Relative, root-relative, anchor, and workspace paths are fine.
    if (/^(?:[./#?]|[\w-]+\/)/.test(trimmed) && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        return true;
    }
    // Explicit scheme — allow only a known-good allowlist.
    return /^(?:https?|mailto|tel|vscode|file):/i.test(trimmed);
}

/** Format JSON for display in tool blocks. */
export function formatJsonPreview(jsonStr) {
    try {
        const obj = JSON.parse(jsonStr || '{}');
        return escHtml(JSON.stringify(obj, null, 2));
    } catch {
        return escHtml(jsonStr || '{}');
    }
}

/** Strip tool call markup and thinking tags from AI content. */
export function stripToolMarkupFromContent(content) {
    if (!content) return '';
    return content
        .replace(/​.*?​/g, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
        .trim();
}
