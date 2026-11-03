import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createScopedMcpServer } from '../src/mcp/server.js';
import { keyStore } from '../src/services/key-store.js';
import { metadataStore } from '../src/services/metadata-store.js';
import { APPS_DIR } from '../src/config.js';

test('MCP: Tools registration and drop_html execution within scoped jail', async () => {
  await keyStore.init();
  await metadataStore.init();

  const testKey = {
    id: 'test-key-id-1',
    name: 'Dev_Alice_Test',
    token: 'hdh_sec_test_alice_token_12345',
    scope: 'mcp_test_alice',
    enabled: true,
    allowOverwrite: true,
    maxFileSizeMb: 10
  };

  const mcpServer = createScopedMcpServer(testKey);
  assert.ok(mcpServer, 'McpServer should be instantiated');

  // Find registered tools
  const tools = mcpServer._registeredTools;
  assert.ok(tools['drop_html'], 'drop_html tool should exist');
  assert.ok(tools['list_my_apps'], 'list_my_apps tool should exist');
  assert.ok(tools['delete_my_app'], 'delete_my_app tool should exist');

  // 1. Call drop_html tool handler
  const dropHandler = tools['drop_html'].handler;
  const result = await dropHandler({
    filename: 'calculator.html',
    content: '<html><head><title>Loan Calculator</title></head><body><h1>Calc</h1></body></html>',
    description: 'Computes monthly loans'
  });

  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.includes('Loan Calculator'));
  assert.ok(result.content[0].text.includes('/mcp_test_alice/calculator.html'));

  // Verify file was written to the isolated scope directory
  const targetFile = path.join(APPS_DIR, 'mcp_test_alice', 'calculator.html');
  assert.ok(fs.existsSync(targetFile), 'Target file should exist on disk in scope directory');

  // 2. Call list_my_apps tool handler
  const listHandler = tools['list_my_apps'].handler;
  const listResult = await listHandler({});
  assert.ok(listResult.content[0].text.includes('Loan Calculator'));
  assert.ok(listResult.content[0].text.includes('calculator.html'));

  // 3. Attempt path traversal via drop_html
  const attackResult = await dropHandler({
    filename: '../../hacked.html',
    content: '<h1>Bad</h1>'
  });
  assert.equal(attackResult.isError, true);
  assert.ok(attackResult.content[0].text.includes('Security Violation'));

  // 4. Delete the app via delete_my_app tool
  const deleteHandler = tools['delete_my_app'].handler;
  const deleteResult = await deleteHandler({ filename: 'calculator.html' });
  assert.equal(deleteResult.isError, undefined);
  assert.ok(!fs.existsSync(targetFile), 'File should be removed from disk');
});
