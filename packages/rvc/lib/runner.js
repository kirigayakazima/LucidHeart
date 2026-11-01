// @dsh/rvc: 跨端推理与执行引擎调度器 (lib/runner.js)
// 负责在 PC GPU 极速模式、手机端离线 ONNX 模式及模拟测试之间自适应调度。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * 探测当前运行环境与可用执行模式
 * @returns {object} { isPhone, isPc, localSayvoicePath, pcGatewayAvailable }
 */
export function detectEnvironment() {
  const isLinux = process.platform === 'linux'
  const sayBinPaths = [
    '/root/dsh-bin/sayvoice.sh',
    '/sdcard/rvc/sayvoice.sh',
    '/sdcard/dshproject/updates/rvc-voice/sayvoice.sh',
  ]
  let localSayvoicePath = null
  for (const p of sayBinPaths) {
    if (fs.existsSync(p)) {
      localSayvoicePath = p
      break
    }
  }

  const isPhone = isLinux && !!localSayvoicePath
  const isPc = process.platform === 'win32' || (!isPhone && !isLinux)

  return {
    isPhone,
    isPc,
    localSayvoicePath,
  }
}

/**
 * 在手机端执行 sayvoice.sh
 */
export function executePhoneSayvoice(sayvoicePath, text, acoustic, outWav, modelsDir) {
  return new Promise((resolve, reject) => {
    const args = [
      sayvoicePath,
      text,
      '--pitch', String(acoustic.pitch),
      '--brightness', String(acoustic.brightness),
    ]
    if (acoustic.rate) {
      args.push('--rate', String(acoustic.rate))
    }
    if (modelsDir) {
      args.push('--models-dir', modelsDir)
    }
    if (outWav) {
      args.push('--out', outWav)
    }

    const t0 = Date.now()
    const proc = spawn('bash', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('error', (err) => {
      reject(new Error(`[sayvoice] 进程启动失败: ${err.message}`))
    })

    proc.on('close', (code) => {
      const durationMs = Date.now() - t0
      if (code !== 0) {
        return reject(new Error(`[sayvoice] 失败 (退出码 ${code}):\n${stderr}\n${stdout}`))
      }
      // sayvoice.sh 在成功时最后一行输出生成的音频文件路径
      const lines = stdout.trim().split('\n').filter(Boolean)
      const outPath = lines[lines.length - 1] || outWav || '/sdcard/rvc/out/output.wav'
      resolve({
        ok: true,
        audioPath: outPath.trim(),
        durationMs,
        acoustic,
        mode: 'phone_onnx',
        logs: stderr,
      })
    })
  })
}

/**
 * 统一执行发声推理调度入口
 *
 * @param {object} params
 * @param {string} params.text 发音文本
 * @param {object} params.acoustic 计算出的声学参数 { pitch, brightness, rate, protect }
 * @param {string} [params.outWav] 指定输出音频路径
 * @param {object} [params.offloadBridge] FullAwake 桥接对象（若有）
 * @param {boolean} [params.mock] 是否强制使用 Mock（用于测试）
 * @returns {Promise<object>}
 */
export async function runSpeak(params) {
  const { text, acoustic, outWav, modelsDir, offloadBridge, mock } = params

  if (mock) {
    const mockOut = outWav || `/tmp/mock_dv5_${Date.now()}.wav`
    return {
      ok: true,
      audioPath: mockOut,
      durationMs: 80,
      acoustic,
      mode: 'mock',
      logs: 'Mock voice generated successfully.',
    }
  }

  // 1. 尝试 PC 端 GPU 极速算力分流 (若连接了 PC 且 FullAwake 桥接在线)
  if (offloadBridge && typeof offloadBridge.callPcRvc === 'function') {
    try {
      console.log('[@dsh/rvc] 检测到 PC FullAwake 算力桥在线，尝试委派 PC GPU 极速合成...')
      const pcRes = await offloadBridge.callPcRvc({
        text,
        pitch: acoustic.pitch,
        brightness: acoustic.brightness,
        rate: acoustic.rate,
      })
      if (pcRes && pcRes.ok && pcRes.audioPath) {
        return {
          ok: true,
          audioPath: pcRes.audioPath,
          durationMs: pcRes.durationMs || 1500,
          acoustic,
          mode: 'pc_gpu_offload',
          logs: 'Synthesized via PC GPU FullAwake Bridge.',
        }
      }
    } catch (err) {
      console.warn('[@dsh/rvc] PC 算力分流失败，自动无缝回退至手机本地推理:', err.message)
    }
  }

  // 2. 手机端本地 ONNX 推理
  const env = detectEnvironment()
  if (env.localSayvoicePath) {
    console.log(`[@dsh/rvc] 使用手机本地 ONNX 引擎执行推理 (${env.localSayvoicePath}) ...`)
    return await executePhoneSayvoice(env.localSayvoicePath, text, acoustic, outWav, modelsDir)
  }

  // 3. PC 本地 CLI 推理 (针对 PC 开发环境)
  if (env.isPc) {
    const mockOut = outWav || path.resolve(process.cwd(), `out_dv5_${Date.now()}.wav`)
    return {
      ok: true,
      audioPath: mockOut,
      durationMs: 120,
      acoustic,
      mode: 'pc_dev_stub',
      logs: 'PC local dev stub - completed.',
    }
  }

  throw new Error('未检测到可用的 RVC 推理引擎（sayvoice.sh 未就绪且无 PC 算力桥）')
}
