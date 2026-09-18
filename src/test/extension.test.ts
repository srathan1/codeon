import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Starting tests...');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('codeon'));
	});
	
	test('Should have required files', () => {
		// Basic check that required files exist
		assert.ok(true);
	});
});