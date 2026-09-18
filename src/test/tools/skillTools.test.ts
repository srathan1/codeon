import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ListSkillsExecutor, LoadSkillExecutor } from '../../tools/executors/skillTools';

suite('Skill Tools Tests', () => {
    let tmpDir: string;
    let skillsDir: string;
    let workspaceStub: vscode.WorkspaceFolder | undefined;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
        skillsDir = path.join(tmpDir, '.qwen', 'skills');
        fs.mkdirSync(skillsDir, { recursive: true });

        workspaceStub = {
            uri: vscode.Uri.file(tmpDir),
            name: 'test-workspace',
            index: 0,
        } as vscode.WorkspaceFolder;
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function createSkill(name: string, content: string) {
        const skillPath = path.join(skillsDir, name);
        fs.mkdirSync(skillPath, { recursive: true });
        fs.writeFileSync(path.join(skillPath, 'SKILL.md'), content, 'utf-8');
    }

    suite('ListSkillsExecutor', () => {
        let executor: ListSkillsExecutor;
        let workspaceStubbed: sinon.SinonStub;

        setup(() => {
            executor = new ListSkillsExecutor();
            workspaceStubbed = sinon.stub(vscode.workspace, 'workspaceFolders').get(() => [workspaceStub]);
        });

        teardown(() => {
            workspaceStubbed.restore();
        });

        test('returns empty list when no skills exist', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 0);
            assert.ok(parsed.message?.includes('skills') || parsed.message?.includes('.qwen'));
        });

        test('discovers skills with SKILL.md', async () => {
            createSkill('pdf', '# PDF Skill\nHandles PDF operations.');
            const result = await executor.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 1);
            assert.strictEqual(parsed.skills[0].name, 'pdf');
            assert.ok(parsed.skills[0].description.includes('PDF'));
        });

        test('discovers skills with README.md', async () => {
            const skillPath = path.join(skillsDir, 'dataviz');
            fs.mkdirSync(skillPath, { recursive: true });
            fs.writeFileSync(path.join(skillPath, 'README.md'), '# Data Visualization Guide', 'utf-8');
            const result = await executor.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 1);
        });

        test('discovers multiple skills', async () => {
            createSkill('pdf', '# PDF Handler');
            createSkill('xlsx', '# Excel Handler');
            const result = await executor.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 2);
        });

        test('skips directories without manifest files', async () => {
            fs.mkdirSync(path.join(skillsDir, 'empty-skill'), { recursive: true });
            const result = await executor.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 0);
        });

        test('normalizes skill names', async () => {
            createSkill('My Cool Skill!', '# My Cool Skill');
            const result = await executor.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 1);
            assert.strictEqual(parsed.skills[0].name, 'my-cool-skill');
        });
    });

    suite('LoadSkillExecutor', () => {
        let executor: LoadSkillExecutor;
        let workspaceStubbed: sinon.SinonStub;

        setup(() => {
            executor = new LoadSkillExecutor();
            workspaceStubbed = sinon.stub(vscode.workspace, 'workspaceFolders').get(() => [workspaceStub]);
        });

        teardown(() => {
            workspaceStubbed.restore();
        });

        test('missing skillName returns error', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('skillName') || result.error?.includes('Missing'));
        });

        test('loads existing skill by name', async () => {
            createSkill('test-skill', '# Test Skill\nThis is a test skill for validation.');
            const result = await executor.execute({ skillName: 'test-skill' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.name, 'test-skill');
            assert.ok(parsed.content.includes('Test Skill'));
            assert.ok(parsed.file.endsWith('SKILL.md'));
        });

        test('case-insensitive skill lookup', async () => {
            createSkill('MySkill', '# MySkill Content');
            const result = await executor.execute({ skillName: 'myskill' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.content.includes('MySkill'));
        });

        test('nonexistent skill returns not found', async () => {
            const result = await executor.execute({ skillName: 'nonexistent-skill' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SKILL_NOT_FOUND') || result.error?.includes('not found'));
        });

        test('loads skill with README.md fallback', async () => {
            const skillPath = path.join(skillsDir, 'readme-skill');
            fs.mkdirSync(skillPath, { recursive: true });
            fs.writeFileSync(path.join(skillPath, 'README.md'), 'README content here', 'utf-8');
            const result = await executor.execute({ skillName: 'readme-skill' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.content.includes('README content'));
        });
    });
});
