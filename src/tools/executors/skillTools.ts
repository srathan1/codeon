import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';

/** Describes a discovered skill. */
interface SkillInfo {
    name: string;
    description: string;
    file: string;
}

/**
 * Scan for skill definition files in well-known locations relative to the extension or workspace.
 * Looks for `.codeon/skills/` directories containing markdown or JSON files.
 */
function discoverSkills(): SkillInfo[] {
    const skills: SkillInfo[] = [];

    // Search paths: workspace .codeon/skills/, extension .codeon/skills/
    const searchPaths: string[] = [];

    // 1. Workspace-level skills
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const folder of folders) {
            searchPaths.push(path.join(folder.uri.fsPath, '.codeon', 'skills'));
        }
    }

    // 2. Extension-level skills
    const ext = vscode.extensions.getExtension('SaiKiranRathan.codeon');
    if (ext) {
        searchPaths.push(path.join(ext.extensionPath, '.codeon', 'skills'));
    }

    for (const sp of searchPaths) {
        if (!fs.existsSync(sp)) continue;

        try {
            const entries = fs.readdirSync(sp, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const skillDir = path.join(sp, entry.name);
                const skillName = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

                // Look for a QWEN.md, README.md, SKILL.md, or index.json inside the skill directory
                const candidates = ['QWEN.md', 'README.md', 'SKILL.md', 'skill.md', 'index.json'];
                let contentPath: string | undefined;
                for (const candidate of candidates) {
                    const cp = path.join(skillDir, candidate);
                    if (fs.existsSync(cp)) {
                        contentPath = cp;
                        break;
                    }
                }

                if (!contentPath) continue;

                let description = '';
                try {
                    const raw = fs.readFileSync(contentPath, 'utf-8');
                    // Extract first non-empty line or frontmatter description as description
                    const firstLine = raw.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))?.trim() || '';
                    const headingMatch = raw.match(/^#\s+(.+)$/m);
                    description = headingMatch?.[1]?.trim() || firstLine.slice(0, 200) || '(no description)';
                } catch {
                    description = '(unreadable)';
                }

                skills.push({ name: skillName, description, file: contentPath });
            }
        } catch {
            // Skip unreadable directories
        }
    }

    return skills;
}

/**
 * Find and read a skill definition by name.
 */
function loadSkillFile(skillName: string): { content: string; file: string } | undefined {
    const normalizedName = skillName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const searchPaths: string[] = [];

    // Workspace-level skills
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const folder of folders) {
            searchPaths.push(path.join(folder.uri.fsPath, '.codeon', 'skills', normalizedName));
        }
    }

    // Extension-level skills
    const ext = vscode.extensions.getExtension('SaiKiranRathan.codeon');
    if (ext) {
        searchPaths.push(path.join(ext.extensionPath, '.codeon', 'skills', normalizedName));
    }

    const candidates = ['QWEN.md', 'README.md', 'SKILL.md', 'skill.md', 'index.json'];
    for (const sp of searchPaths) {
        if (!fs.existsSync(sp)) continue;
        for (const candidate of candidates) {
            const cp = path.join(sp, candidate);
            if (fs.existsSync(cp)) {
                try {
                    return { content: fs.readFileSync(cp, 'utf-8'), file: cp };
                } catch {
                    continue;
                }
            }
        }
    }

    return undefined;
}

/**
 * Executor for the `list_skills` tool.
 * Scans for skill definition files and returns available skills with names and descriptions.
 */
export class ListSkillsExecutor implements ToolExecutor {
    public name = 'list_skills';

    public async execute(_args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const skills = discoverSkills();

            if (skills.length === 0) {
                return {
                    success: true,
                    output: JSON.stringify(
                        {
                            count: 0,
                            skills: [],
                            message: 'No skills found. Place skill directories in .codeon/skills/ within your workspace or extension directory.',
                        },
                        null,
                        2,
                    ),
                };
            }

            return {
                success: true,
                output: JSON.stringify(
                    {
                        count: skills.length,
                        skills: skills.map(s => ({ name: s.name, description: s.description })),
                    },
                    null,
                    2,
                ),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `load_skill` tool.
 * Finds and reads a skill definition file by name, returning its content.
 */
export class LoadSkillExecutor implements ToolExecutor {
    public name = 'load_skill';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const skillName = String(args.skillName || '');

            if (!skillName) {
                return { success: false, output: '', error: 'Missing required parameter: skillName' };
            }

            const result = loadSkillFile(skillName);
            if (!result) {
                return { success: false, output: '', error: `SKILL_NOT_FOUND: skill '${skillName}' not found in .codeon/skills/ directories` };
            }

            return {
                success: true,
                output: JSON.stringify({ name: skillName, file: result.file, content: result.content }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
