import crypto from 'node:crypto';

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CDN_HOST = 'novac2c.cdn.weixin.qq.com';
const IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000;

function cdnUrl(media) {
  const raw = media?.full_url || (media?.encrypt_query_param
    ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
    : '');
  if (!raw) throw new Error('图片缺少微信 CDN 下载地址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('图片的微信 CDN 地址无效');
  }
  if (url.protocol !== 'https:' || url.hostname !== CDN_HOST || url.port || url.username || url.password) {
    throw new Error('图片的微信 CDN 地址不受信任');
  }
  return url;
}

function decodeBase64Key(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('图片解密密钥格式无效');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('图片解密密钥格式无效');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error('图片解密密钥长度无效');
}

function imageKey(image) {
  if (image?.aeskey != null && image.aeskey !== '') {
    if (typeof image.aeskey !== 'string' || !/^[0-9a-f]{32}$/i.test(image.aeskey)) {
      throw new Error('图片解密密钥格式无效');
    }
    return Buffer.from(image.aeskey, 'hex');
  }
  return image?.media?.aes_key ? decodeBase64Key(image.media.aes_key) : undefined;
}

function detectImageMediaType(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('图片格式不受支持，请发送 PNG、JPEG、WebP 或 GIF');
}

async function readBounded(response, maxBytes) {
  if (!response.ok) throw new Error('微信 CDN 图片下载失败');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('图片超过大小限制');
  if (!response.body) throw new Error('微信 CDN 未返回图片内容');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('图片超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** Download one current-message WeChat image; never trust a media URL from the wire. */
export async function downloadImage(image, { maxBytes, signal, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('图片大小限制不可用');
  const url = cdnUrl(image?.media);
  const key = imageKey(image);
  const timeout = AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new Error('微信 CDN 图片下载失败或超时');
  }
  if (response.redirected || (response.url && cdnUrl({ full_url: response.url }).origin !== url.origin)) {
    throw new Error('图片下载发生不受信任的跳转');
  }
  let encrypted;
  try {
    encrypted = await readBounded(response, maxBytes + (key ? 16 : 0));
  } catch (error) {
    if (signal?.aborted || timeout.aborted) throw new Error('微信 CDN 图片下载失败或超时');
    throw error;
  }
  let data = encrypted;
  if (key) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
      data = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      throw new Error('图片解密失败');
    }
  }
  if (data.length > maxBytes) throw new Error('图片超过大小限制');
  return { data, mediaType: detectImageMediaType(data) };
}
