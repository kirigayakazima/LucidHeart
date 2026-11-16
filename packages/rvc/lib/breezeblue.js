/**
 * @dsh/rvc - BreezeBlue Online Voice & Dataset Harvester Engine
 *
 * 核心机制:
 * 1. 在线拟人合成: 直连 BreezeBlue 云端 API (ElevenLabs 兼容协议)，支持 Voice Direction 演绎指令
 * 2. 极简情绪映射: 基于 Heart Snapshot 与情境关键词纯规则映射 instructions (零额外 LLM 调用)
 * 3. 自动资产沉淀: 每轮成功合成的语音与标注文本自动持久化至手机 /sdcard/rvc/dataset/，为后续炼 RVC 收集语料
 * 4. 故障安全熔断: 网络超时或异常时自动降级回退至本地 Feiyu RVC
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_BREEZE_ENDPOINT = 'https://api.breeze.blue/v1/text-to-speech';
export const DEFAULT_BREEZE_VOICE_ID = 'voc_myarmcyqm2zv';

/**
 * 根据对话文本与 Heart 心情状态计算自然语言演绎指令 (Voice Direction)
 * 纯规则映射，零 LLM 额外调用，保护 Token 与延迟
 *
 * @param {string} text 台词文本
 * @param {object} [acoustic] 声学参数
 * @param {object} [mood] Heart 心情快照
 * @param {object} [options] 可选参数（例如 options.hour 方便测试或时区修正）
 * @returns {string} BreezeBlue instructions
 */
export function resolveVoiceInstructions(text = '', acoustic = {}, mood = {}, options = {}) {
  const clean = text.trim();
  const state = String(acoustic?.emotion || mood?.state || mood?.current?.state || 'calm').toLowerCase();
  const hour = typeof options?.hour === 'number' ? options.hour : new Date().getHours();

  // 1. 明确的深夜/休息语义 (晚安、困倦、sleepy)
  if (/晚安|好梦|早点睡|困了|该睡了|去睡觉|被窝/i.test(clean) || state === 'sleepy') {
    return '低柔温和的少女声音，像近距离在耳边轻声夜谈，语速略慢，平静放松，句尾自然轻落。';
  }

  // 2. 安慰、疲惫与同理心场景 (优先于正向兴奋)
  if (/辛苦|累了|抱抱|别难过|别哭|委屈|心疼|别怕|我在呢|别着凉|照顾好/i.test(clean) || state === 'tired') {
    return '声音放轻放柔，温和真诚，认真倾听与关心的感觉，不要轻浮或甜腻，语气自然沉静。';
  }

  // 3. 玩笑、捉弄、游戏互动与吐槽
  if (/哈哈|嘻嘻|嘿嘿|笨蛋|才怪|赖我|输了|抓到|打游戏|通关|调皮|捉弄|逗你/i.test(clean) || state === 'playful') {
    return '略带忍不住的轻笑，俏皮灵动但不尖细，停顿自然，像熟人开玩笑，不要夸张卖萌。';
  }

  // 4. 惊喜、庆祝、开心庆祝场景
  if (/好耶|太棒|太好|开心|厉害|庆祝|成功啦|太赞/i.test(clean) || ['joy', 'excited', 'happy'].includes(state)) {
    return '自然清亮的少女声音，透着由衷的开心与轻微小雀跃，不过度高亢，句尾利落回落。';
  }

  // 5. 认真说明、技术分析与道歉排查
  if (/对不起|抱歉|其实|原来|我看看|分析|排查|报错|代码|配置|错误|修改|更新/i.test(clean)) {
    return '清晰自然客观的少女声音，语调平稳落地，不带甜腻配音腔，认真专注地说明。';
  }

  // 6. 若无特定语义，但处于深夜时段 (>= 23 或 < 6)，进入轻柔夜谈模式
  if (hour >= 23 || hour < 6) {
    return '低柔温和的少女声音，像近距离在耳边轻声夜谈，语速略慢，平静放松，句尾自然轻落。';
  }

  // 7. 默认日常交谈与亲切问候
  return '自然清亮的少女音，带着一点若有若无的亲近笑意，吐字自然像面对面聊天，句尾自然收住，不刻意卖萌。';
}

/**
 * 请求 BreezeBlue 云端 API 合成语音
 *
 * @param {object} params
 * @param {string} params.text 发音文本
 * @param {string} [params.instructions] 演绎指令
 * @param {string} [params.voiceId] 声音 ID
 * @param {string} params.apiKey BreezeBlue API Key
 * @param {string} [params.outputFormat] 音频格式 (mp3, wav)
 * @param {number} [params.guidanceScale] 引导强度 (默认 2)
 * @param {AbortSignal} [params.signal] 取消信号
 * @param {number} [params.timeoutMs] 超时时间 (毫秒，默认 25000)
 * @returns {Promise<Buffer>} 二进制音频数据
 */
export async function synthesizeBreezeVoice({
  text,
  instructions,
  voiceId = DEFAULT_BREEZE_VOICE_ID,
  apiKey,
  outputFormat = 'mp3',
  guidanceScale = 2,
  signal,
  timeoutMs = 25000,
  endpoint = DEFAULT_BREEZE_ENDPOINT,
}) {
  if (!text || !text.trim()) {
    throw new Error('TTS text cannot be empty');
  }
  if (!apiKey) {
    throw new Error('BreezeBlue apiKey is required');
  }

  const cleanText = text.trim();
  const cleanInstructions = (instructions || resolveVoiceInstructions(cleanText)).trim();
  const url = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`BreezeBlue request timed out after ${timeoutMs}ms`)), timeoutMs);

  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const payload = {
      text: cleanText,
      instructions: cleanInstructions,
      voice_settings: {
        guidance_scale: guidanceScale,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'LucidHeart-Voice/0.5.0',
      },
      body: JSON.stringify(payload),
      signal: combinedSignal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`BreezeBlue API HTTP ${res.status}: ${errBody || res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer || buffer.length === 0) {
      throw new Error('BreezeBlue returned empty audio buffer');
    }

    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自动将生成的在线人声音频与标注文本持久化保存至手机数据集目录
 * 作为后续微调/训练本地 RVC 专属声库的宝贵资产
 *
 * @param {object} params
 * @param {string} [params.datasetDir] 数据集存储目录 (如 /sdcard/rvc/dataset)
 * @param {string} params.text 发音文本
 * @param {string} params.instructions 演绎指令
 * @param {Buffer} params.audioBuffer 二进制音频数据
 * @param {string} [params.voiceId] 声音 ID
 * @param {string} [params.ext] 文件扩展名 (.mp3 / .wav)
 * @returns {string|null} 归档的音频绝对路径
 */
export function archiveToDataset({
  datasetDir = '/sdcard/rvc/dataset',
  text,
  instructions,
  audioBuffer,
  voiceId = DEFAULT_BREEZE_VOICE_ID,
  ext = '.mp3',
}) {
  if (!audioBuffer || !text) return null;
  try {
    const audioDir = path.join(datasetDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const rand = randomBytes(3).toString('hex');
    const filename = `xiaoman_${dateStr}_${rand}${ext.startsWith('.') ? ext : '.' + ext}`;
    const audioPath = path.join(audioDir, filename);

    fs.writeFileSync(audioPath, audioBuffer);

    const manifestPath = path.join(datasetDir, 'dataset.jsonl');
    const entry = JSON.stringify({
      id: `ds_${dateStr}_${rand}`,
      createdAt: now.toISOString(),
      text: text.trim(),
      instructions: instructions?.trim() || '',
      voiceId,
      audioFile: `audio/${filename}`,
      bytes: audioBuffer.length,
    });

    fs.appendFileSync(manifestPath, entry + '\n', 'utf8');
    return audioPath;
  } catch (err) {
    console.warn('[@dsh/rvc] 数据集自动归档跳过 (非致命):', err.message);
    return null;
  }
}
