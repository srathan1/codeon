// ============================================================
//  Plan mode blocked banner
// ============================================================

/** Current pending plan-mode block tool ID, or null. */
let pendingPlanBlockToolId = null;

/** Show the plan-mode blocked banner with the tool name. */
export function showPlanModeBlocked(toolId, toolName) {
    pendingPlanBlockToolId = toolId;
    const banner = document.getElementById('planModeBanner');
    const toolNameSpan = document.getElementById('planModeToolName');
    if (banner && toolNameSpan) {
        toolNameSpan.textContent = toolName;
        banner.style.display = '';
    }
}

/** Hide and clear the plan-mode blocked banner. */
export function hidePlanModeBlocked() {
    const banner = document.getElementById('planModeBanner');
    if (banner) banner.style.display = 'none';
    pendingPlanBlockToolId = null;
}

/** Wire up plan-mode banner buttons. */
export function initPlanModeBanner(vscode) {
    const exitBtn = document.getElementById('planModeBannerExit');
    const rejectBtn = document.getElementById('planModeBannerReject');

    if (exitBtn) {
        exitBtn.addEventListener('click', () => {
            const toolId = pendingPlanBlockToolId;
            hidePlanModeBlocked();
            if (toolId) {
                vscode.postMessage({
                    command: 'planModeExitRequest',
                    toolId
                });
            }
        });
    }

    if (rejectBtn) {
        rejectBtn.addEventListener('click', () => {
            const toolId = pendingPlanBlockToolId;
            hidePlanModeBlocked();
            if (toolId) {
                vscode.postMessage({
                    command: 'planModeToolResponse',
                    toolId,
                    approved: false
                });
            }
        });
    }
}
