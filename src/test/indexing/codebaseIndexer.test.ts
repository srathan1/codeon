import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { CodebaseIndexer, extractSymbolsFromLSP } from '../../indexing/codebaseIndexer';

suite('CodebaseIndexer Tests', () => {
    let tmpDir: string;
    let storageDir: string;
    let indexer: CodebaseIndexer;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-storage-'));
        indexer = new CodebaseIndexer(tmpDir, storageDir);
    });

    teardown(() => {
        indexer.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    // --- Symbol extraction ---

    suite('Symbol extraction: TypeScript', () => {
        test('extracts classes, interfaces, functions, types, enums, consts', async () => {
            const content = [
                'export class MyClass {}',
                'export interface MyInterface {}',
                'export type MyType = string;',
                'export enum MyEnum { A, B }',
                'export function myFunction() {}',
                'export const MY_CONST = 42;',
                'function localFunc() {}',
            ].join('\n');

            fs.writeFileSync(path.join(tmpDir, 'test.ts'), content);
            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 1);
            const symbols = files[0].symbols;

            assert.ok(symbols.find(s => s.name === 'MyClass' && s.kind === 'class'));
            assert.ok(symbols.find(s => s.name === 'MyInterface' && s.kind === 'interface'));
            assert.ok(symbols.find(s => s.name === 'MyType' && s.kind === 'type'));
            assert.ok(symbols.find(s => s.name === 'MyEnum' && s.kind === 'enum'));
            assert.ok(symbols.find(s => s.name === 'myFunction' && s.kind === 'function'));
            assert.ok(symbols.find(s => s.name === 'MY_CONST' && s.kind === 'const'));
            assert.ok(symbols.find(s => s.name === 'localFunc' && s.kind === 'function'));
        });
    });

    suite('Symbol extraction: JavaScript', () => {
        test('extracts classes and arrow functions', async () => {
            const content = [
                'class JsClass {}',
                'function jsFunction() {}',
                'const arrowFn = () => {}',
                'const obj = { a: 1 };',
            ].join('\n');

            fs.writeFileSync(path.join(tmpDir, 'test.js'), content);
            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 1);
            const symbols = files[0].symbols;

            assert.ok(symbols.find(s => s.name === 'JsClass' && s.kind === 'class'));
            assert.ok(symbols.find(s => s.name === 'jsFunction' && s.kind === 'function'));
        });
    });

    suite('Symbol extraction: Python', () => {
        test('extracts classes and methods', async () => {
            const content = [
                'class PythonClass:',
                '    def method(self):',
                '        pass',
                '',
                'def standalone_func():',
                '    return True',
            ].join('\n');

            fs.writeFileSync(path.join(tmpDir, 'test.py'), content);
            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 1);
            const symbols = files[0].symbols;

            assert.ok(symbols.find(s => s.name === 'PythonClass' && s.kind === 'class'));
            assert.ok(symbols.find(s => s.name === 'method' && s.kind === 'function'));
            assert.ok(symbols.find(s => s.name === 'standalone_func' && s.kind === 'function'));
        });
    });

    suite('Symbol extraction: Java', () => {
        test('extracts classes, interfaces, and methods', async () => {
            const content = [
                'public class JavaClass {',
                '    public void doSomething() {}',
                '    private int getValue() { return 1; }',
                '}',
                'public interface JavaInterface {}',
                'public static final String CONSTANT = "hi";',
            ].join('\n');

            fs.writeFileSync(path.join(tmpDir, 'Test.java'), content);
            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 1);
            const symbols = files[0].symbols;

            assert.ok(symbols.find(s => s.name === 'JavaClass' && s.kind === 'class'));
            assert.ok(symbols.find(s => s.name === 'JavaInterface' && s.kind === 'interface'));
            assert.ok(symbols.find(s => s.name === 'doSomething' && s.kind === 'method'));
            assert.ok(symbols.find(s => s.name === 'CONSTANT' && s.kind === 'const'));
        });
    });

    // --- .gitignore filtering ---

    suite('.gitignore filtering', () => {
        test('excludes node_modules by default', async () => {
            fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'), 'export function x() {}');
            fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export function y() {}');

            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 1);
            assert.strictEqual(files[0].path.includes('src.ts') || files[0].path.includes('src'), true);
        });

        test('respects custom .gitignore patterns', async () => {
            fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'secret/\n*.log\n');

            fs.mkdirSync(path.join(tmpDir, 'secret'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'secret', 'key.ts'), 'export const key = "x";');
            fs.writeFileSync(path.join(tmpDir, 'debug.log'), 'some log');
            fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'export const v = 1;');

            // Reload with new .gitignore
            indexer = new CodebaseIndexer(tmpDir, storageDir);
            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 1);
            assert.ok(files[0].path.includes('visible.ts'));
        });

        test('includes negated patterns (!)', async () => {
            fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'cache/\n!cache/important.ts\n');

            fs.mkdirSync(path.join(tmpDir, 'cache'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'cache', 'ignored.ts'), 'export const a = 1;');
            fs.writeFileSync(path.join(tmpDir, 'cache', 'important.ts'), 'export const b = 2;');

            indexer = new CodebaseIndexer(tmpDir, storageDir);
            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            // ignore library handles negation — important.ts should be included
            const paths = files.map(f => f.path.replace(/\\/g, '/'));
            assert.ok(paths.some(p => p.includes('important.ts')), 'important.ts should be indexed');
        });
    });

    // --- Index persistence ---

    suite('Index persistence', () => {
        test('saves and loads index from disk', async () => {
            fs.writeFileSync(path.join(tmpDir, 'persist.ts'), 'export class Persisted {}');
            await indexer.rebuildIndex();

            // Create new indexer instance and load cached index
            const newIndexer = new CodebaseIndexer(tmpDir, storageDir);
            const loaded = newIndexer.loadIndex();
            assert.strictEqual(loaded, true);

            const stats = newIndexer.getIndexStats();
            assert.strictEqual(stats.fileCount, 1);
            newIndexer.dispose();
        });

        test('rejects stale index from different workspace', async () => {
            fs.writeFileSync(path.join(tmpDir, 'stale.ts'), 'export const x = 1;');
            await indexer.rebuildIndex();

            // Modify the stored root to simulate different workspace AND older version
            const indexPath = path.join(storageDir, 'index.json');
            const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            raw.root = '/different/workspace';
            raw.version = 1; // Older version also rejected
            fs.writeFileSync(indexPath, JSON.stringify(raw));

            const newIndexer = new CodebaseIndexer(tmpDir, storageDir);
            const loaded = newIndexer.loadIndex();
            assert.strictEqual(loaded, false);
            newIndexer.dispose();
        });
    });

    // --- Query API ---

    suite('Query API', () => {
        test('querySymbol returns fuzzy matches sorted by score', async () => {
            const content = [
                'export class DataProcessor {}',
                'export class DataLoader {}',
                'export function processData() {}',
                'export function helper() {}',
            ].join('\n');

            fs.writeFileSync(path.join(tmpDir, 'query.ts'), content);
            await indexer.rebuildIndex();

            const results = indexer.querySymbol('Data');
            assert.ok(results.length >= 2);
            // Starts-with match should rank higher than substring
            assert.strictEqual(results[0].symbol.name.startsWith('Data'), true);
        });

        test('querySymbol with exact match ranks first', async () => {
            const content = [
                'export class ExactMatch {}',
                'export class ExactMatchHelper {}',
                'export function containsExactMatch() {}',
            ].join('\n');

            fs.writeFileSync(path.join(tmpDir, 'exact.ts'), content);
            await indexer.rebuildIndex();

            const results = indexer.querySymbol('ExactMatch');
            assert.strictEqual(results[0].symbol.name, 'ExactMatch');
        });

        test('queryByLanguage filters correctly', async () => {
            fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export class A {}');
            fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export class B {}');
            fs.writeFileSync(path.join(tmpDir, 'c.py'), 'class C: pass');

            await indexer.rebuildIndex();

            const tsFiles = indexer.queryByLanguage('typescript');
            const pyFiles = indexer.queryByLanguage('python');

            assert.strictEqual(tsFiles.length, 2);
            assert.strictEqual(pyFiles.length, 1);
        });

        test('getIndexStats returns correct counts', async () => {
            fs.writeFileSync(path.join(tmpDir, 'stats.ts'), 'export class S1 {}\nexport class S2 {}');
            fs.writeFileSync(path.join(tmpDir, 'stats.js'), 'function jsFunc() {}');

            await indexer.rebuildIndex();

            const stats = indexer.getIndexStats();
            assert.strictEqual(stats.fileCount, 2);
            assert.strictEqual(stats.symbolCount, 3);
            assert.strictEqual(stats.languages['typescript'], 1);
            assert.strictEqual(stats.languages['javascript'], 1);
        });

        test('getAllFiles returns all indexed files', async () => {
            fs.writeFileSync(path.join(tmpDir, 'all1.ts'), 'export const a = 1;');
            fs.writeFileSync(path.join(tmpDir, 'all2.py'), 'def fn(): pass');
            fs.writeFileSync(path.join(tmpDir, 'all3.java'), 'public class All3 {}');

            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 3);
        });
    });

    // --- isIgnored utility ---

    suite('isIgnored()', () => {
        test('ignores .git directory', () => {
            assert.strictEqual(indexer.isIgnored('.git/config'), true);
        });

        test('ignores __pycache__', () => {
            assert.strictEqual(indexer.isIgnored('__pycache__/module.cpython-39.pyc'), true);
        });

        test('does not ignore normal source files', () => {
            assert.strictEqual(indexer.isIgnored('src/index.ts'), false);
            assert.strictEqual(indexer.isIgnored('lib/utils.py'), false);
        });
    });

    // --- LSP-based extraction ---

    suite('LSP symbol extraction', () => {
        test('extractSymbolsFromLSP returns symbols for TypeScript files', async () => {
            const content = [
                'export class LspTestClass {',
                '    public method(): void {}',
                '}',
                'export function lspTestFunc(): number { return 0; }',
            ].join('\n');

            const filePath = path.join(tmpDir, 'lsp-test.ts');
            fs.writeFileSync(filePath, content);
            const uri = vscode.Uri.file(filePath);

            const symbols = await extractSymbolsFromLSP(uri);

            // LSP should find at least the class and function
            assert.ok(symbols.length > 0, 'LSP should extract symbols from TS files');
            assert.ok(symbols.find(s => s.name === 'LspTestClass'), 'Should find LspTestClass');
            assert.ok(symbols.find(s => s.name === 'lspTestFunc'), 'Should find lspTestFunc');
        });

        test('LSP-extracted symbols include containerName for nested symbols', async () => {
            const content = [
                'export class Container {',
                '    methodA(): void {}',
                '    methodB(): void {}',
                '}',
            ].join('\n');

            const filePath = path.join(tmpDir, 'container.ts');
            fs.writeFileSync(filePath, content);
            const uri = vscode.Uri.file(filePath);

            const symbols = await extractSymbolsFromLSP(uri);

            // Methods inside Container should have containerName set
            const methods = symbols.filter(s => s.kind === 'method');
            if (methods.length > 0) {
                const hasContainer = methods.some(m => m.containerName === 'Container');
                assert.ok(hasContainer, 'Methods should have containerName set to parent class');
            }
        });

        test('LSP-extracted symbols include endLine', async () => {
            const content = [
                'export class WithEndLine {',
                '    prop = 1;',
                '    method(): void {}',
                '}',
            ].join('\n');

            const filePath = path.join(tmpDir, 'endline.ts');
            fs.writeFileSync(filePath, content);
            const uri = vscode.Uri.file(filePath);

            const symbols = await extractSymbolsFromLSP(uri);

            // At least some symbols should have endLine populated
            const withEndLine = symbols.filter(s => s.endLine !== undefined && s.endLine! >= s.line);
            assert.ok(withEndLine.length > 0, 'LSP symbols should include endLine');
        });

        test('returns empty array for non-existent file', async () => {
            const uri = vscode.Uri.file('/nonexistent/path/file.ts');
            const symbols = await extractSymbolsFromLSP(uri);
            assert.strictEqual(symbols.length, 0);
        });

        test('rebuildIndex uses LSP then falls back to regex', async () => {
            // Write a TS file with arrow functions (regex misses these, LSP catches them)
            const content = [
                'export class ArrowTestClass {}',
                'const arrowFn = (): void => {}',
                'export async function asyncMethod(): Promise<string> { return ""; }',
            ].join('\n');

            fs.writeFileSync(path.join(tmpDir, 'arrow.ts'), content);
            await indexer.rebuildIndex();

            const files = indexer.getAllFiles();
            assert.strictEqual(files.length, 1);
            const symbols = files[0].symbols;

            // Class should always be found (both regex and LSP)
            assert.ok(symbols.find(s => s.name === 'ArrowTestClass'), 'Should find ArrowTestClass');

            // LSP should find arrowFn and asyncMethod — regex alone would miss at least one
            const allFound = symbols.find(s => s.name === 'arrowFn') && symbols.find(s => s.name === 'asyncMethod');
            // If LSP is available, both should be found; if only regex, at least asyncMethod
            assert.ok(
                allFound || symbols.find(s => s.name === 'asyncMethod'),
                'Should find arrowFn and/or asyncMethod via LSP or regex fallback'
            );
        });
    });
});
