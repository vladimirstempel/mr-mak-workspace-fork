import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createService } from '../server.mjs';
import { terminalCommand } from '../agents.mjs';
import { CHAT_TOOL_SERVER, chatToolArguments, chatToolEnvironment, chatToolScript } from '../chat-tools.mjs';

test('Codex and Claude chats start with the chat tool server; other agents do not', async () => {
  const codex = chatToolArguments('codex');
  assert.deepEqual(codex.filter((_, index) => index % 2 === 0), ['-c', '-c', '-c', '-c']);
  assert.ok(codex.includes(`mcp_servers.${CHAT_TOOL_SERVER}.command='${process.execPath}'`));
  assert.ok(codex.includes(`mcp_servers.${CHAT_TOOL_SERVER}.env_vars=['MRMAK_CHAT_URL','MRMAK_CHAT_ID','MRMAK_CHAT_KEY']`));
  assert.ok(codex.every(value => !value.includes('"') || value.includes("'")));
  assert.deepEqual(chatToolArguments('claude', { claudeConfig: '/state/claude-mcp.json' }), ['--mcp-config', '/state/claude-mcp.json']);
  for (const agent of ['antigravity', 'opencode', 'kimi', 'shell']) assert.deepEqual(chatToolArguments(agent, { claudeConfig: '/x' }), []);
  if (process.platform === 'win32') return;
  // The first prompt stays a positional argument, and Claude's variadic
  // --mcp-config is followed by an option, never by a value it would swallow.
  const claude = terminalCommand('claude', { initialPrompt: 'Review the plan', nativeId: 'abc', chatTools: ['--mcp-config', '/c.json'] }).args;
  assert.deepEqual(claude.slice(0, 5), ['Review the plan', '--mcp-config', '/c.json', '--session-id', 'abc']);
  const resumed = terminalCommand('codex', { resumeId: 'abc', initialPrompt: undefined, chatTools: codex }).args;
  assert.deepEqual(resumed.slice(0, 2), ['resume', 'abc']);
  assert.throws(() => terminalCommand('codex', { chatTools: [1] }), /strings/);
});

async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mrmak-chat-tools-'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  const { sessions } = service;
  // Chats with a recorded terminal instead of a paid CLI conversation.
  const writes = new Map();
  sessions.nativeBoundary = async () => undefined;
  sessions.launch = async session => {
    writes.set(session.id, []);
    const exits = [];
    const proc = {
      write: data => { writes.get(session.id).push(data); if (data === '\x03') proc.kill(); },
      resize() {},
      kill() { if (session.process !== proc) return; session.process = null; for (const exit of exits.splice(0)) exit({ exitCode: 0 }); },
      onExit: exit => { exits.push(exit); return { dispose: () => exits.splice(exits.indexOf(exit) >>> 0, 1) }; },
    };
    session.process = proc;
    session.status = 'running';
  };
  const connect = async id => {
    const client = new Client({ name: 'chat-tools-test', version: '0.1.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [chatToolScript], env: { ...chatToolEnvironment({ url: service.origin, token: service.token, id }), PATH: process.env.PATH } }));
    return client;
  };
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return result.isError ? { error: text } : JSON.parse(text);
  };
  return { repo, service, sessions, writes, connect, call };
}

test('a chat lists, messages, waits for and opens other chats through its MCP server', async () => {
  const { service, sessions, writes, connect, call } = await fixture();
  const clients = [];
  try {
    const config = JSON.parse(await readFile(sessions.chatTools.claudeConfig, 'utf8'));
    assert.deepEqual(config.mcpServers[CHAT_TOOL_SERVER].args, [chatToolScript]);
    const lead = await sessions.create({ agent: 'claude', name: 'Lead Review', effort: 'high' });
    const worker = await sessions.create({ agent: 'codex', name: 'Combat Worker' });
    await sessions.create({ agent: 'shell', name: 'User Shell' });
    const client = await connect(lead.id); clients.push(client);
    assert.deepEqual((await client.listTools()).tools.map(item => item.name), ['list_chats', 'read_chat', 'send_to_chat', 'open_chat', 'wait_for_chat']);

    const chats = await call(client, 'list_chats');
    assert.deepEqual(chats.map(item => [item.name, item.self === true]), [['Lead Review', true], ['Combat Worker', false]]);
    assert.match((await call(client, 'send_to_chat', { id: lead.id, text: 'Hello' })).error, /another chat/);

    assert.equal((await call(client, 'send_to_chat', { id: worker.id, text: 'Balance the spear unit' })).delivered, true);
    assert.match(writes.get(worker.id)[0], /^\x1b\[200~Message from the Mr\. Mak chat "Lead Review" \(ID [a-f0-9-]{36}\):\nBalance the spear unit\x1b\[201~$/);
    // A reply that completes before the wait starts is still returned.
    sessions.nativeEvent(sessions.get(worker.id), { kind: 'turn-completed', id: 'turn-1' });
    service.chatTools.transcripts = { read: async () => ({ supported: true, messages: [{ role: 'user', text: 'Balance' }, { role: 'assistant', text: 'Spear cost is now 80.' }] }) };
    const waited = await call(client, 'wait_for_chat', { id: worker.id, timeout_seconds: 5 });
    assert.equal(waited.outcome, 'completed');
    assert.equal(waited.lastReply, 'Spear cost is now 80.');
    const pending = call(client, 'wait_for_chat', { id: worker.id, timeout_seconds: 5 });
    setTimeout(() => sessions.nativeEvent(sessions.get(worker.id), { kind: 'attention' }), 200);
    assert.equal((await pending).outcome, 'needs-attention');
    assert.equal((await call(client, 'wait_for_chat', { id: worker.id, timeout_seconds: 1 })).outcome, 'needs-attention');

    const read = await call(client, 'read_chat', { id: worker.id });
    assert.equal(read.chat.name, 'Combat Worker'); assert.equal(read.lastReply, 'Spear cost is now 80.');

    const opened = await call(client, 'open_chat', { agent: 'codex', name: 'Map Layout Pass', task: 'Sketch the first map' });
    const child = sessions.get(opened.opened.id);
    assert.equal(child.cwd, sessions.get(lead.id).cwd); assert.equal(child.effort, 'high'); assert.equal(child.bypass, false);
    assert.match((await call(client, 'open_chat', { agent: 'codex', name: 'New chat' })).error, /descriptive English task title/);
    assert.match((await call(client, 'open_chat', { agent: 'kimi', name: 'Map Layout Pass' })).error, /Codex or Claude/);
  } finally { for (const client of clients) await client.close(); await service.close(); }
});

test('a chat key identifies one open chat, never the service token or another chat', async () => {
  const { service, sessions } = await fixture();
  try {
    const lead = await sessions.create({ agent: 'claude', name: 'Lead Review' });
    const other = await sessions.create({ agent: 'codex', name: 'Combat Worker' });
    const post = authorization => fetch(`${service.origin}/chat-tools/list_chats`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}' });
    const own = chatToolEnvironment({ url: service.origin, token: service.token, id: lead.id });
    assert.equal((await post(`Bearer ${lead.id}.${own.MRMAK_CHAT_KEY}`)).status, 200);
    assert.equal((await post(`Bearer ${other.id}.${own.MRMAK_CHAT_KEY}`)).status, 401);
    assert.equal((await post(`Bearer ${service.token}`)).status, 401);
    assert.equal((await post('')).status, 401);
    await service.sessions.remove(lead.id);
    assert.equal((await post(`Bearer ${lead.id}.${own.MRMAK_CHAT_KEY}`)).status, 403);
  } finally { await service.close(); }
});
