/** The real stdio worker acknowledges the native protocol before accepting custom requests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client, project } from './client.mjs';

test('initialize acknowledges the exact native control version and request methods', async () => {
  const input = await project({ 'main.ts': 'export const value = 1;\n' });
  const client = new Client();
  try {
    const result = await client.initialize(input.root);
    assert.deepEqual(result.capabilities.experimental?.nanobugControl, {
      version: 1,
      methods: [
        'typescript/adapter/attach',
        'typescript/analysis/request',
        'typescript/project/bind',
        'typescript/project/candidates',
        'typescript/project/describe',
        'typescript/project/documents',
        'typescript/project/release',
        'typescript/project/resolve',
      ],
    });
  } finally {
    await client.close();
    await input.cleanup();
  }
});

test('an unsupported control version is explicit and does not poison ordinary initialization', async () => {
  const input = await project({ 'main.ts': 'export const value = 1;\n' });
  const client = new Client();
  try {
    await assert.rejects(client.request('initialize', {
      rootUri: pathToFileURL(input.root).href,
      capabilities: { experimental: { nanobugControl: 2 } },
    }), error => error.code === -32006 && /control.*version/i.test(error.message));
    const result = await client.initialize(input.root);
    assert.equal(result.capabilities.experimental.nanobugControl.version, 1);
    const uri = input.uri('main.ts');
    client.open(uri, 'export const value = 1;\n');
    const context = await client.request('typescript/project/resolve', { uri });
    assert.equal(context.engineVersion, '5.9.3');
  } finally {
    await client.close();
    await input.cleanup();
  }
});

test('ordinary LSP remains usable without granting the custom control channel', async () => {
  const source = 'export const ordinaryValue = 1;\nordinaryValue;\n';
  const input = await project({ 'main.ts': source });
  const client = new Client();
  try {
    client.root = input.root;
    const result = await client.request('initialize', {
      rootUri: pathToFileURL(input.root).href, capabilities: {},
    });
    assert.equal(result.capabilities.experimental?.nanobugControl, undefined);
    const uri = input.uri('main.ts');
    client.open(uri, source);
    await assert.rejects(client.request('typescript/project/resolve', { uri }), error => error.code === -32006);
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri }, position: { line: 1, character: 4 },
    });
    assert.match(JSON.stringify(hover), /ordinaryValue/);
  } finally {
    await client.close();
    await input.cleanup();
  }
});
