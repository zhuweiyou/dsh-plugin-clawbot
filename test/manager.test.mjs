import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createManager } from '../lib/index.js';
import { catalogEntries, resolveModel, splitMessage } from '../lib/models.js';
import { createSessionControllerDshClient } from '../lib/dsh.js';

const limits = { maxImagesPerMessage: 3, maxImageBytes: 100, maxMessageImageBytes: 200 };
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const catalog = {
  default: { provider: 'p', model: 'default' },
  groups: [
    { id: 'p', name: 'Provider P', models: [{ id: 'default', name: 'Default' }, { id: 'shared' }] },
    { id: 'q', name: 'Provider Q', models: [{ id: 'shared' }, { id: 'q-model' }] },
  ],
  failures: [{ id: 'offline', name: 'Offline', message: 'unavailable' }],
};

const wxMessage = (items, seq = 1) => ({
  message_type: 1, from_user_id: 'sender', context_token: 'context', message_id: String(seq), item_list: items,
});
const text = (value) => ({ type: 1, text_item: { text: value } });
const image = () => ({ type: 2, image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/image' } } });
const voice = (value) => ({ type: 3, voice_item: { ...(value === undefined ? {} : { text: value }) } });

async function runMessages(messages, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-test-'));
  const sent = [];
  const prompts = [];
  const created = [];
  const selected = [];
  let deliver;
  let firstPoll = true;
  let currentModel = null;
  const wx = {
    getUpdates: async (_buf, { timeoutMs } = {}) => {
      if (firstPoll) { firstPoll = false; return { msgs: messages, get_updates_buf: 'cursor' }; }
      return new Promise((resolve) => {
        if (manager.abort.signal.aborted) return resolve({ msgs: [] });
        manager.abort.signal.addEventListener('abort', () => resolve({ msgs: [] }), { once: true });
      });
    },
    sendText: async (_to, value) => { sent.push(value); },
    downloadImage: async (item, params) => opts.downloadImage?.(item, params) ?? { data: png, mediaType: 'image/png' },
    notifyStart: async () => {}, notifyStop: async () => {},
  };
  const dsh = {
    openMux: async (onFrame, _signal, _onStatus, options) => { options.eventBus(onFrame); },
    createSession: async ({ sessionId }) => { created.push(sessionId); return { sessionId }; },
    prompt: async (sessionId, content) => {
      prompts.push({ sessionId, content });
      deliver({ type: 'session/event', sessionId, event: {
        type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '智能体回复' }] } },
      } });
      deliver({ type: 'session/event', sessionId, event: { type: 'turn/end' } });
    },
    modelCatalog: async () => catalog,
    getSessionModel: async () => currentModel,
    selectModel: async (sessionId, provider, model) => {
      selected.push({ sessionId, provider, model });
      currentModel = { provider, model };
      return { selected: currentModel };
    },
    ...opts.dsh,
  };
  const manager = createManager({ weixin: { token: 'test', accountId: 'unit-test' }, bridge: { stateDir: dir } }, {
    log: () => {}, dsh, weixinFactory: () => wx,
    eventBus: (handler) => { deliver = handler; return () => {}; },
    imageLimits: opts.imageLimits === undefined ? limits : opts.imageLimits,
  });
  try {
    await manager.start();
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !opts.done?.({ sent, prompts, selected, created })) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!opts.done?.({ sent, prompts, selected, created })) throw new Error('timed out waiting for inbound result');
    return { sent, prompts, selected, created };
  } finally {
    await manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('图片及文字按原顺序作为一次 DSH prompt，回传同一会话', async () => {
  const { prompts, sent } = await runMessages([
    wxMessage([image(), text('请描述图片'), image()]),
  ], { done: ({ prompts, sent }) => prompts.length === 1 && sent.length === 1 });
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].content.map((part) => part.type), ['image', 'text', 'image']);
  assert.equal(prompts[0].content[0].data, png.toString('base64'));
  assert.equal(prompts[0].content[1].text, '请描述图片');
  assert.equal(sent[0], '智能体回复');
});

test('有转写的语音按文本处理；无转写拒绝且不提交 prompt', async () => {
  const transcript = await runMessages([wxMessage([voice('明天天气')])], {
    done: ({ sent }) => sent.length === 1,
  });
  assert.equal(transcript.prompts[0].content, '明天天气');
  const missing = await runMessages([wxMessage([image(), voice()])], {
    done: ({ sent }) => sent.length === 1,
  });
  assert.equal(missing.prompts.length, 0);
  assert.match(missing.sent[0], /没有可用的微信转写/);
});

test('图片失败或超过限制时不发送文本降级提示词', async () => {
  const rejected = await runMessages([wxMessage([image(), text('这是什么')])], {
    downloadImage: async () => { throw new Error('微信 CDN 图片下载失败'); },
    done: ({ sent }) => sent.length === 1,
  });
  assert.equal(rejected.prompts.length, 0);
  assert.match(rejected.sent[0], /图片处理失败/);
  const count = await runMessages([wxMessage([image(), image(), image(), image()])], {
    done: ({ sent }) => sent.length === 1,
  });
  assert.equal(count.prompts.length, 0);
  assert.match(count.sent[0], /数量超出/);
});

test('附图 /new 不执行命令，而是发一次包含图片的 prompt', async () => {
  const { prompts, created } = await runMessages([wxMessage([text('/new'), image()])], {
    done: ({ sent }) => sent.length === 1,
  });
  assert.equal(created.length, 1);
  assert.deepEqual(prompts[0].content.map((part) => part.type), ['text', 'image']);
});

test('模型清单、歧义/序号、切换后提示词沿用会话且命令不转发', async () => {
  const messages = [wxMessage([text('/model')], 1), wxMessage([text('/model shared')], 2),
    wxMessage([text('/model 4')], 3), wxMessage([text('后续消息')], 4)];
  const { sent, prompts, selected, created } = await runMessages(messages, {
    done: ({ sent, prompts }) => sent.length >= 4 && prompts.length === 1,
  });
  assert.match(sent[0], /部署默认模型：p\/default/);
  assert.match(sent[0], /暂不可用：offline/);
  assert.match(sent[1], /多个 provider/);
  assert.equal(created.length, 1);
  assert.equal(selected[0].model, 'q-model');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, selected[0].sessionId);
  assert.equal(prompts[0].content, '后续消息');
});

test('已有会话时 /model 显示会话模型而非部署默认', async () => {
  const { sent } = await runMessages([wxMessage([text('你好')], 1), wxMessage([text('/model')], 2)], {
    done: ({ sent }) => sent.length === 2,
  });
  assert.equal(sent[0], '智能体回复');
  assert.equal(sent[1].split('\n')[0], '当前会话模型：p/default');
});

test('目录为空、目录不可用、切换失败都给出可理解反馈且不改变选择', async () => {
  const empty = await runMessages([wxMessage([text('/model')])], {
    dsh: { modelCatalog: async () => ({ default: { provider: 'p', model: 'default' }, groups: [], failures: [] }) },
    done: ({ sent }) => sent.length === 1,
  });
  assert.match(empty.sent[0], /当前没有可选模型/);

  const unsupported = await runMessages([wxMessage([text('/model')])], {
    dsh: { modelCatalog: async () => { throw new Error('unsupported'); } },
    done: ({ sent }) => sent.length === 1,
  });
  assert.match(unsupported.sent[0], /不支持微信切换模型/);

  const failed = await runMessages([wxMessage([text('/model p/default')])], {
    dsh: { selectModel: async () => { throw new Error('model unavailable'); } },
    done: ({ sent }) => sent.length === 1,
  });
  assert.equal(failed.selected.length, 0);
  assert.match(failed.sent[0], /模型切换失败/);
});

test('模型辅助函数解析精确 ID、重名、无效序号、分页', () => {
  const entries = catalogEntries(catalog);
  assert.equal(resolveModel('q/shared', entries).entry.provider, 'q');
  assert.equal(resolveModel('shared', entries).kind, 'ambiguous');
  assert.equal(resolveModel('p/default', entries).kind, 'selected');
  assert.equal(resolveModel('0', entries).kind, 'invalid');
  assert.equal(resolveModel('99', entries).kind, 'invalid');
  const chunks = splitMessage(Array.from({ length: 100 }, (_, i) => `模型 ${i}：p/model-${i}`));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1200));
});

test('当前 sessionController 适配器支持图像与模型目录、选择和投影查询', async () => {
  const calls = [];
  const client = createSessionControllerDshClient({
    prompt: async (request, signal) => { calls.push(['prompt', request, signal]); return { accepted: true }; },
    modelCatalog: () => catalog,
    selectModel: async (request) => { calls.push(['select', request]); return { selected: { provider: request.provider, model: request.model } }; },
    projections: async (request, signal) => {
      calls.push(['projections', request, signal]);
      return { values: { modelSelection: { next: { provider: 'p', model: 'default' } } } };
    },
  });
  const content = [{ type: 'text', text: '看图' }, { type: 'image', mediaType: 'image/png', data: png.toString('base64') }];
  await client.prompt('session', content);
  assert.deepEqual(calls[0][1].content, content);
  assert.equal(typeof calls[0][1].requestId, 'string');
  assert.ok(calls[0][2] instanceof AbortSignal);
  assert.equal((await client.modelCatalog()).groups.length, 2);
  assert.deepEqual(await client.selectModel('session', 'q', 'q-model'), { selected: { provider: 'q', model: 'q-model' } });
  assert.deepEqual(await client.getSessionModel('session'), { provider: 'p', model: 'default' });
  assert.ok(calls[2][2] instanceof AbortSignal);
  const old = createSessionControllerDshClient({});
  await assert.rejects(old.modelCatalog(), /当前 DSH 版本不支持/);
});
