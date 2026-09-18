import * as path from 'path';
import * as fs from 'fs/promises';
import Mocha from 'mocha';

async function findTests(cwd: string, pattern: string): Promise<string[]> {
	const files: string[] = [];
	const entries = await fs.readdir(cwd, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(cwd, entry.name);
		if (entry.isDirectory()) {
			files.push(...await findTests(fullPath, pattern));
		} else if (entry.isFile() && pattern.endsWith('.js') && entry.name.endsWith('.test.js')) {
			files.push(fullPath);
		}
	}
	return files;
}

export function run(): Promise<void> {
	return new Promise(async (c, e) => {
		const mocha = new Mocha({
			ui: 'tdd',
			color: true
		});

		const testsRoot = __dirname;

		try {
			const files = await findTests(testsRoot, '**.test.js');

			// Add files to the test suite
			files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

			// Run the mocha test
			mocha.run((failures: number) => {
				if (failures > 0) {
					e(new Error(`${failures} tests failed.`));
				} else {
					c();
				}
			});
		} catch (err) {
			console.error(err);
			e(err);
		}
	});
}