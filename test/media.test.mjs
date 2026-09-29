import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { downloadImage } from '../lib/media.js';
import { messageBody } from '../lib/weixin.js';

const png = Buffer.from('89504e470d0a1a0a01020304', 'hex');
const url = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=test';
const media = { full_url: url };
const response = (bytes, headers) => new Response(bytes, { status: 200, headers });

function encrypt(bytes, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

test('微信图文与语音转写保持消息顺序及引用文字', () => {
  assert.equal(messageBody({ item_list: [
    { type: 1, text_item: { text: '看图' } },
    { type: 2, image_item: {} },
    { type: 3, voice_item: { text: '它是什么？' } },
  ] }), '看图\n它是什么？');
  assert.equal(messageBody({ item_list: [{ type: 1, text_item: { text: '答复' }, ref_msg: {
    title: '之前', message_item: { type: 1, text_item: { text: '问题' } },
  } }] }), '[引用: 之前 | 问题]\n答复');
  assert.equal(messageBody({ item_list: [{ type: 3, voice_item: {} }] }), '');
});

test('下载无密钥的 CDN 图片，使用官方加密查询参数回退地址', async () => {
  let requested;
  const result = await downloadImage({ media: { encrypt_query_param: 'a b?' } }, {
    maxBytes: 1024,
    fetchImpl: async (target, options) => {
      requested = target.toString();
      assert.equal(options.redirect, 'error');
      return response(png);
    },
  });
  assert.equal(requested, 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%20b%3F');
  assert.equal(result.mediaType, 'image/png');
  assert.deepEqual(result.data, png);
});

test('解密 image_item.aeskey 十六进制密钥与 media.aes_key 两种 base64 编码', async () => {
  const key = Buffer.alloc(16, 7);
  const encrypted = encrypt(png, key);
  for (const image of [
    { aeskey: key.toString('hex'), media: { ...media, aes_key: Buffer.alloc(16, 9).toString('base64') } },
    { media: { ...media, aes_key: key.toString('base64') } },
    { media: { ...media, aes_key: Buffer.from(key.toString('hex')).toString('base64') } },
  ]) {
    const result = await downloadImage(image, { maxBytes: 1024, fetchImpl: async () => response(encrypted) });
    assert.deepEqual(result.data, png);
  }
});

test('拒绝任意 URL、跳转、错误密钥、错误填充与非图片文件', async () => {
  const fetchImpl = async () => response(png);
  for (const full_url of ['http://novac2c.cdn.weixin.qq.com/c2c/a', 'https://127.0.0.1/private',
    'https://novac2c.cdn.weixin.qq.com.evil.test/a', 'https://novac2c.cdn.weixin.qq.com:8080/a']) {
    await assert.rejects(downloadImage({ media: { full_url } }, { maxBytes: 1024, fetchImpl }), /不受信任/);
  }
  await assert.rejects(downloadImage({ media }, { maxBytes: 1024, fetchImpl: async () => {
    const redirected = response(png);
    Object.defineProperty(redirected, 'redirected', { value: true });
    return redirected;
  } }), /跳转/);
  await assert.rejects(downloadImage({ aeskey: 'abc', media }, { maxBytes: 1024, fetchImpl }), /密钥/);
  await assert.rejects(downloadImage({ media: { ...media, aes_key: Buffer.alloc(16, 1).toString('base64') } }, {
    maxBytes: 1024, fetchImpl: async () => response(Buffer.alloc(16, 0)),
  }), /解密失败/);
  await assert.rejects(downloadImage({ media }, {
    maxBytes: 1024, fetchImpl: async () => response(Buffer.from('not an image')),
  }), /图片格式/);
});

test('拒绝 CDN 声明超限和流式超限，不发出多余下载', async () => {
  await assert.rejects(downloadImage({ media }, {
    maxBytes: 4, fetchImpl: async () => response(png, { 'content-length': String(png.length) }),
  }), /大小限制/);
  await assert.rejects(downloadImage({ media }, {
    maxBytes: 4, fetchImpl: async () => response(png),
  }), /大小限制/);
  await assert.rejects(downloadImage({ media }, {
    maxBytes: 1024, fetchImpl: async () => { throw new Error('secret URL'); },
  }), /下载失败或超时/);
});
