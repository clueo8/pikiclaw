import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);

describe('Antigravity driver event stream parsing', () => {
  it('parses init, step_update, and result events from agy NDJSON stream', async () => {
    const { parseAgyEvent } = await import('../src/agent/drivers/agy.ts');

    const state = {
      sessionId: null as string | null,
      text: '',
      thinking: '',
      model: null as string | null,
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      cachedInputTokens: null as number | null,
      stopReason: null as string | null,
      error: null as string | null,
      recentActivity: [] as string[],
      workdir: '/tmp/test',
    };

    // 1. Init event
    parseAgyEvent({
      event: 'init',
      conversation_id: 'conv-12345',
      init: {
        cwd: '/tmp/test',
        tools: ['view_file', 'run_command'],
        permission_mode: 'always-proceed',
      },
    }, state);

    expect(state.sessionId).toBe('conv-12345');

    // 2. Step update (agent response text delta)
    parseAgyEvent({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-12345',
        step_index: 0,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Hello, I am Antigravity!',
      },
    }, state);

    expect(state.text).toBe('Hello, I am Antigravity!');

    // 3. Step update with tool call
    parseAgyEvent({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-12345',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: { AbsolutePath: '/tmp/test/index.ts' },
      },
    }, state);

    expect(state.recentActivity).toHaveLength(2);
    expect(state.recentActivity[1]).toContain('Read');

    // 4. Result event with usage
    parseAgyEvent({
      event: 'result',
      result: {
        conversation_id: 'conv-12345',
        status: 'SUCCESS',
        response: 'Task complete.',
        usage: {
          input_tokens: 1500,
          output_tokens: 250,
          cached_tokens: 800,
        },
      },
    }, state);

    expect(state.inputTokens).toBe(1500);
    expect(state.outputTokens).toBe(250);
    expect(state.cachedInputTokens).toBe(800);
    expect(state.stopReason).toBe('end_turn');
  });
});

describe('Antigravity session discovery via SQLite', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-agy-sessions-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
  });

  it('reads native sessions from conversation_summaries.db', async () => {
    const agyDir = path.join(homeDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(agyDir, { recursive: true });
    const dbPath = path.join(agyDir, 'conversation_summaries.db');

    const { DatabaseSync } = nodeRequire('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        workspace_uris TEXT,
        last_modified_time TEXT,
        status TEXT,
        step_count INTEGER
      )
    `);

    const workdir = '/workspace/pikiloom';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, last_modified_time, status, step_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('conv-abc-123', 'Refactor database models', 'Preview text', JSON.stringify([workdir]), now, 'COMPLETED', 12);
    db.close();

    const { getAgySessions } = await import('../src/agent/drivers/agy.ts');
    const result = getAgySessions(workdir, 10);

    expect(result.ok).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'conv-abc-123',
      title: 'Refactor database models',
      agent: 'agy',
      numTurns: 12,
    });
  });
});

describe('Antigravity session tail from transcript', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-agy-tail-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
  });

  it('reads conversation turns from transcript.jsonl', async () => {
    const sessionId = 'conv-tail-789';
    const logsDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    const lines = [
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nHow do I run tests?\n</USER_REQUEST>' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Run `npm test` to execute Vitest.' }),
      JSON.stringify({ type: 'USER_INPUT', content: 'Does it work with watch mode?' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Yes, run `npm test -- --watch`.' }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const { getAgySessionTail, getAgySessionMessages } = await import('../src/agent/drivers/agy.ts');
    const tail = getAgySessionTail({
      agent: 'agy',
      sessionId,
      workdir: '/workspace/test',
      limit: 4,
    });

    expect(tail.ok).toBe(true);
    expect(tail.messages).toEqual([
      { role: 'user', text: 'How do I run tests?' },
      { role: 'assistant', text: 'Run `npm test` to execute Vitest.' },
      { role: 'user', text: 'Does it work with watch mode?' },
      { role: 'assistant', text: 'Yes, run `npm test -- --watch`.' },
    ]);

    const fullMessages = getAgySessionMessages({
      agent: 'agy',
      sessionId,
      workdir: '/workspace/test',
    });

    expect(fullMessages.ok).toBe(true);
    expect(fullMessages.totalTurns).toBe(2);
    expect(fullMessages.messages).toHaveLength(4);
  });
});

describe('Antigravity command builder', () => {
  it('constructs correct agy arguments including --output-format, --dangerously-skip-permissions, and --effort', async () => {
    const { agyCmd } = await import('../src/agent/drivers/agy.ts');

    const cmd = agyCmd({
      agent: 'agy',
      prompt: 'Write a unit test',
      workdir: '/workspace/my-repo',
      timeout: 30,
      sessionId: 'conv-xyz',
      agyModel: 'gemini-2.5-pro',
      agyReasoningEffort: 'high',
    });

    expect(cmd[0]).toBe('agy');
    expect(cmd).toContain('--output-format');
    expect(cmd).toContain('stream-json');
    expect(cmd).toContain('--dangerously-skip-permissions');
    expect(cmd).toContain('--model');
    expect(cmd).toContain('gemini-3.1-pro');
    expect(cmd).toContain('--effort');
    expect(cmd).toContain('high');
    expect(cmd).toContain('--conversation');
    expect(cmd).toContain('conv-xyz');
    expect(cmd).toContain('--add-dir');
    expect(cmd).toContain('/workspace/my-repo');
    expect(cmd).toContain('-p');
    expect(cmd).toContain('Write a unit test');
  });

  it('normalizes legacy auto-gemini-3 and respects effort rules', async () => {
    const { agyCmd } = await import('../src/agent/drivers/agy.ts');

    // auto-gemini-3 maps to gemini-3.8-flash with effort high
    const cmd1 = agyCmd({
      agent: 'agy',
      prompt: 'Hello',
      workdir: '/tmp',
      timeout: 30,
      agyModel: 'auto-gemini-3',
    });
    expect(cmd1).toContain('--model');
    expect(cmd1).toContain('gemini-3.8-flash');
    expect(cmd1).toContain('--effort');
    expect(cmd1).toContain('high');

    // claude models strip --effort even if requested
    const cmd2 = agyCmd({
      agent: 'agy',
      prompt: 'Hello',
      workdir: '/tmp',
      timeout: 30,
      agyModel: 'claude-sonnet-4-6',
      agyReasoningEffort: 'high',
    });
    expect(cmd2).toContain('--model');
    expect(cmd2).toContain('claude-sonnet-4-6');
    expect(cmd2).not.toContain('--effort');

    // conflicting effort overrides embedded suffix without collision
    const cmd3 = agyCmd({
      agent: 'agy',
      prompt: 'Hello',
      workdir: '/tmp',
      timeout: 30,
      agyModel: 'gemini-3.8-flash-high',
      agyReasoningEffort: 'low',
    });
    expect(cmd3).toContain('--model');
    expect(cmd3).toContain('gemini-3.8-flash');
    expect(cmd3).toContain('--effort');
    expect(cmd3).toContain('low');

    // gemini-3.1-pro elevates medium to high effort
    const cmd4 = agyCmd({
      agent: 'agy',
      prompt: 'Hello',
      workdir: '/tmp',
      timeout: 30,
      agyModel: 'gemini-3.1-pro',
      agyReasoningEffort: 'medium',
    });
    expect(cmd4).toContain('--model');
    expect(cmd4).toContain('gemini-3.1-pro');
    expect(cmd4).toContain('--effort');
    expect(cmd4).toContain('high');
  });
});

describe('Antigravity session oversized detection and compaction', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-agy-oversize-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects oversized sessions via DB size, transcript size, and step count', async () => {
    const { isAgySessionOversized } = await import('../src/agent/drivers/agy.ts');

    expect(isAgySessionOversized(null)).toBe(false);
    expect(isAgySessionOversized('pending_123')).toBe(false);
    expect(isAgySessionOversized('nonexistent')).toBe(false);

    // 1. Oversized via SQLite DB > 3 MB
    const convDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const largeDb = path.join(convDir, 'large-db.db');
    fs.writeFileSync(largeDb, Buffer.alloc(3.5 * 1024 * 1024));
    expect(isAgySessionOversized('large-db')).toBe(true);

    // 2. Oversized via JSONL transcript > 1.5 MB
    const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', 'large-transcript', '.system_generated', 'logs');
    fs.mkdirSync(brainDir, { recursive: true });
    const largeTranscript = path.join(brainDir, 'transcript.jsonl');
    fs.writeFileSync(largeTranscript, Buffer.alloc(1.6 * 1024 * 1024));
    expect(isAgySessionOversized('large-transcript')).toBe(true);

    // 3. Normal size session
    const normalTranscript = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', 'normal-session', '.system_generated', 'logs');
    fs.mkdirSync(normalTranscript, { recursive: true });
    fs.writeFileSync(path.join(normalTranscript, 'transcript.jsonl'), 'small content');
    expect(isAgySessionOversized('normal-session')).toBe(false);
  });

  it('formats compactForHandover with <compacted_history> when fromAgent equals toAgent', async () => {
    const { compactForHandover } = await import('../src/agent/handover.ts');

    const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', 'test-compact', '.system_generated', 'logs');
    fs.mkdirSync(brainDir, { recursive: true });
    const transcriptPath = path.join(brainDir, 'transcript.jsonl');

    const steps = [
      { type: 'USER_INPUT', content: 'step 1 user' },
      { type: 'PLANNER_RESPONSE', content: 'step 1 assistant' },
      { type: 'USER_INPUT', content: 'step 2 user' },
      { type: 'PLANNER_RESPONSE', content: 'step 2 assistant' },
    ];
    fs.writeFileSync(transcriptPath, steps.map(s => JSON.stringify(s)).join('\n') + '\n');

    const result = await compactForHandover({
      fromAgent: 'agy',
      fromSessionId: 'test-compact',
      workdir: '/tmp',
      toAgent: 'agy',
      toModel: 'gemini-3.1-pro',
    });

    expect(result.ok).toBe(true);
    expect(result.seed).toContain('<compacted_history agent="agy" turns="2">');
    expect(result.seed).toContain('</compacted_history>');
    expect(result.seed).toContain('Continuing this conversation from the compacted history above');
  });

  it('ensures gemini is removed from selectable driver IDs and normalizes to agy', async () => {
    const { allDriverIds, allDrivers, listAgents } = await import('../src/agent/index.ts');
    const { normalizeAgent } = await import('../src/bot/bot.ts');

    const ids = allDriverIds();
    expect(ids).toContain('agy');
    expect(ids).not.toContain('gemini');

    const drivers = allDrivers();
    expect(drivers.some(d => d.id === 'gemini')).toBe(false);

    const agentList = listAgents();
    expect(agentList.agents.some(a => a.agent === 'gemini')).toBe(false);

    expect(normalizeAgent('gemini')).toBe('agy');
    expect(normalizeAgent('agy')).toBe('agy');
  });
});


