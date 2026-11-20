// @dsh/rvc: 跨端推理与执行引擎调度器 (lib/runner.js)
// 负责在 PC GPU 极速模式、手机端离线 ONNX 模式及模拟测试之间自适应调度。

import fs from 'node:fs'
import { mkdtemp, readFile, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runProfileSpeak, readVoiceProfile, renderDryVoice } from './voice-profile.js'
import { voiceContract, saveOffloadAudio, offloadDryVoice, requestPcVoice } from './offload.js'
import { DEFAULT_TTS_VOICE } from './acoustic.js'
import { synthesizeBreezeVoice, resolveVoiceInstructions, archiveToDataset, DEFAULT_BREEZE_VOICE_ID, DEFAULT_BREEZE_ENDPOINT } from './breezeblue.js'

const pExecFile = promisify(execFile)

/**
 * 为输出音频末尾补齐静音切片 (默认 400ms)
 * 解决 QQ OpenAPI / QQ 移动端与桌面端语音播放器末尾 200~400ms 截断尾音问题
 */
export async function padAudioTrailingSilence(filePath, padSeconds = 0.4) {
  if (!filePath || !fs.existsSync(filePath)) return filePath
  const ext = path.extname(filePath).toLowerCase()
  if (!['.mp3', '.wav'].includes(ext)) return filePath
  const tempOutput = path.join(path.dirname(filePath), `padded_${Date.now()}_${path.basename(filePath)}`)
  try {
    await pExecFile('ffmpeg', [
      '-y',
      '-v', 'error',
      '-i', filePath,
      '-af', `apad=pad_dur=${padSeconds}`,
      tempOutput,
    ], { timeout: 8000 })
    if (fs.existsSync(tempOutput) && fs.statSync(tempOutput).size > 100) {
      fs.copyFileSync(tempOutput, filePath)
      fs.unlinkSync(tempOutput)
    }
  } catch {
    try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput) } catch {}
  }
  return filePath
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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
    const targetModelsDir = modelsDir || '/sdcard/rvc/models/feiyu-rvc-v1'
    if (targetModelsDir) {
      args.push('--models-dir', targetModelsDir)
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
 * 在 PC 端执行 GPU 极速发声合成 (pc_sayvoice.py)
 */
export function executePcSayvoice(text, acoustic, outWav) {
  return new Promise((resolve, reject) => {
    const defaultOut = path.resolve(os.homedir(), '.dsh', 'audio', `axing_voice_${Date.now()}.wav`)
    const finalOut = outWav || defaultOut
    fs.mkdirSync(path.dirname(finalOut), { recursive: true })

    const pyExe = "C:\\Users\\xuaner\\AppData\\Roaming\\uv\\python\\cpython-3.10-windows-x86_64-none\\python.exe"
    const scriptPath = path.resolve(__dirname, '../../../../rvc/scripts/pc_sayvoice.py')

    const pythonPath = [
      path.resolve(__dirname, '../../../../rvc/.venv310/Lib/site-packages'),
      path.resolve(__dirname, '../../../../rvc/src'),
      path.resolve(__dirname, '../../../../rvc/scripts')
    ].join(';')

    const pitch = typeof acoustic?.pitch === 'number' ? acoustic.pitch : -4
    const args = [
      scriptPath,
      '--text', text,
      '--pitch', String(pitch),
      '--out', finalOut,
      '--device', 'cuda:0',
    ]

    const t0 = Date.now()
    const proc = spawn(pyExe, args, {
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('error', (err) => {
      reject(new Error(`[pc_sayvoice] 进程启动失败: ${err.message}`))
    })

    proc.on('close', (code) => {
      const durationMs = Date.now() - t0
      if (code !== 0 || !fs.existsSync(finalOut)) {
        return reject(new Error(`[pc_sayvoice] 失败 (退出码 ${code}):\n${stderr}\n${stdout}`))
      }
      resolve({
        ok: true,
        audioPath: finalOut,
        durationMs,
        acoustic,
        mode: 'pc_gpu_rvc',
        logs: stdout,
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
  const { artifacts } = params
  if (!artifacts || params.mock || params.outWav) return synthesize(params)
  const dir = artifacts.begin()
  const isBreeze = (params.provider === 'breezeblue' || (Boolean(params.breezeApiKey) && params.provider !== 'rvc-onnx')) && !params.mock
  const output = path.join(dir, isBreeze ? 'voice.mp3' : 'voice.wav')
  let result
  try {
    const rendered = await synthesize({ ...params, outWav: output, artifactDir: dir })
    const actualPath = rendered?.audioPath || output
    if (!artifacts.contains(actualPath)) return rendered
    const artifact = artifacts.describe(actualPath, 'voice')
    result = rendered
    return { ...result, artifactId: artifact.artifactId, releaseArtifact: () => artifacts.finish(dir) }
  } finally {
    artifacts.cleanJob(dir, result?.audioPath || output, Boolean(result))
    if (!result) artifacts.finish(dir)
  }
}

async function synthesize(params) {
  const { text, acoustic, outWav, modelsDir, offloadBridge, mock } = params

  // 0. BreezeBlue 在线真实拟人少女音合成引擎
  const isBreeze = (params.provider === 'breezeblue' || (Boolean(params.breezeApiKey) && params.provider !== 'rvc-onnx'))
  if (isBreeze && !mock) {
    const apiKey = params.breezeApiKey || 'brz_XfxyZyDQK9a6Ex5-5l_9W9aJ9cMq9H8j'
    const voiceId = params.breezeVoiceId || DEFAULT_BREEZE_VOICE_ID
    const endpoint = params.breezeEndpoint || DEFAULT_BREEZE_ENDPOINT
    const instructions = params.instructions || resolveVoiceInstructions(text, acoustic, params.mood)
    const started = Date.now()
    try {
      console.log(`[@dsh/rvc] 采用 BreezeBlue 在线真实少女音 (ID: ${voiceId})...`)
      const audioBuffer = await synthesizeBreezeVoice({
        text,
        instructions,
        voiceId,
        apiKey,
        outputFormat: 'mp3',
        guidanceScale: 2,
        signal: params.signal,
        endpoint,
      })
      params.signal?.throwIfAborted()

      const finalOut = outWav || path.join(os.tmpdir(), `breeze_voice_${Date.now()}.mp3`)
      fs.mkdirSync(path.dirname(finalOut), { recursive: true })
      fs.writeFileSync(finalOut, audioBuffer)

      let datasetPath = null
      if (params.saveDataset === true) {
        datasetPath = archiveToDataset({
          datasetDir: params.datasetDir || '/sdcard/rvc/dataset',
          text,
          instructions,
          audioBuffer,
          voiceId,
          ext: '.mp3',
        })
      }

      await padAudioTrailingSilence(finalOut, 0.4)

      return {
        ok: true,
        audioPath: finalOut,
        durationMs: Date.now() - started,
        acoustic: { ...acoustic, instructions },
        mode: 'breezeblue_online',
        voiceId,
        datasetPath,
        logs: `BreezeBlue TTS synthesized (${audioBuffer.length} bytes, instructions: ${instructions})`,
      }
    } catch (err) {
      params.signal?.throwIfAborted()
      if (params.allowLocalFallback !== true) {
        throw new Error(`BreezeBlue 云端发声失败（已关闭本地 RVC 回退）: ${err.message}`)
      }
      console.warn('[@dsh/rvc] BreezeBlue 在线合成失败，自动无缝降级至本地 RVC 引擎:', err.message)
      if (outWav && outWav.endsWith('.mp3')) {
        params.outWav = outWav.replace(/\.mp3$/, '.wav')
      }
    }
  }

  let profilePath = params.voiceProfile
  if (!profilePath && !mock) {
    const phoneFeiyu = path.join(modelsDir || '/sdcard/rvc/models/feiyu-rvc-v1', 'voice-profile.json')
    const pcFeiyu = path.resolve(__dirname, '../../local/feiyu/rvc-onnx-phasefix/voice-profile.json')
    if (fs.existsSync(phoneFeiyu)) {
      profilePath = phoneFeiyu
    } else if (fs.existsSync(pcFeiyu)) {
      profilePath = pcFeiyu
    }
  }

  if (profilePath) {
    if (mock) throw new Error('Voice profile validation requires a real worker; mock mode cannot certify a new model')
    const profile = readVoiceProfile(profilePath)
    if (path.basename(path.dirname(path.resolve(profilePath))) === 'feiyu-rvc-v1' && profile.id !== 'feiyu-rvc-v1') {
      throw new Error('Expected the feiyu-rvc-v1 voice profile')
    }
    const pitch = acoustic?.pitch ?? profile.pitch
    if (![0, -4].includes(pitch)) throw new Error('RVC pitch must be 0 or -4')
    const ttsVoice = profile.id === 'feiyu-rvc-v1' ? acoustic?.ttsVoice ?? DEFAULT_TTS_VOICE : profile.ttsVoice
    const effective = { ...profile, pitch, ttsVoice,
      brightness: acoustic?.brightness ?? profile.brightness, ttsRate: acoustic?.rate ?? profile.ttsRate }
    const feiyuContract = profile.id === 'feiyu-rvc-v1' ? voiceContract(effective) : null
    if (feiyuContract && profile.index !== 'voice.mobile.index') throw new Error('Invalid Feiyu retrieval index')
    const localParams = { ...params, voiceProfile: profilePath, acoustic: { ...acoustic, ttsVoice } }
    const offload = { attempted: false, status: 'unavailable' }
    let dir, input
    try {
      if (typeof offloadBridge?.callPcRvc === 'function') {
        try {
          offload.attempted = true
          const contract = feiyuContract || voiceContract(effective)
          const started = Date.now()
          let punctuationSeconds
          try {
            if (!params.artifactDir) dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rvc-dry-'))
            const dryFile = path.join(params.artifactDir || dir, 'dry.wav')
            const timeout = AbortSignal.timeout(150_000)
            const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout
            punctuationSeconds = await renderDryVoice({ ...localParams, outWav: dryFile, signal })
            input = dryFile
          } catch (error) {
            params.signal?.throwIfAborted()
            // A PC with TTS can still serve hosts without a local dry renderer.
            if ([...text].length > 200) throw error
          }
          let saved
          if (input) {
            if ((await stat(input)).size > 120 * 16000 * 2 + 1024) throw new Error('Dry voice exceeds PC batching limit')
            saved = await offloadDryVoice({ dryWav: await readFile(input), punctuationSeconds,
              bridge: offloadBridge, contract, signal: params.signal, outWav })
          } else {
            const result = await requestPcVoice(offloadBridge, { text, voice: contract }, params.signal)
            params.signal?.throwIfAborted()
            saved = saveOffloadAudio(result, contract, outWav)
          }
          if (saved?.audioPath) await padAudioTrailingSilence(saved.audioPath, 0.4)
          return { ...saved, durationMs: Date.now() - started, acoustic: { ...acoustic, ...saved.acoustic, ttsVoice: contract.settings.ttsVoice } }
        } catch (error) {
          params.signal?.throwIfAborted()
          offload.status = 'failed'
          offload.error = String(error?.message || error)
          console.warn('[@dsh/rvc] PC 新音色分流不可用，保留相同音色回退本地:', offload.error)
        }
      }
      params.signal?.throwIfAborted()
      const fallback = offload.status === 'failed' && feiyuContract
      const local = await runProfileSpeak({ ...localParams, input,
        provider: fallback ? 'CPUExecutionProvider' : undefined })
      if (local?.audioPath) await padAudioTrailingSilence(local.audioPath, 0.4)
      if (fallback) {
        if (local.validation.executionProvider !== 'CPUExecutionProvider' ||
            local.profileId !== profile.id || local.acoustic.pitch !== pitch) {
          throw new Error('Local RVC fallback did not match the Feiyu CPU voice contract')
        }
        return { ...local, mode: 'phone_onnx_fallback', offload: { ...offload, status: 'fallback', provider: 'CPUExecutionProvider' } }
      }
      return { ...local, offload }
    } finally {
      if (dir) {
        try {
          for (const file of ['dry.wav', 'dry.dry.mp3']) await rm(path.join(dir, file), { force: true })
          await rmdir(dir)
        } catch (error) {
          console.warn('[@dsh/rvc] 干声临时目录清理失败:', error.message)
        }
      }
    }
  }

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
  const env = detectEnvironment()
  if (env.isPhone && (!modelsDir || path.basename(path.resolve(modelsDir)) === 'feiyu-rvc-v1')) {
    throw new Error('Missing feiyu-rvc-v1 voice profile; cannot verify the phone voice contract')
  }
  if (!env.isPhone && offloadBridge && typeof offloadBridge.callPcRvc === 'function') {
    try {
      console.log('[@dsh/rvc] 检测到 PC FullAwake 算力桥在线，尝试委派 PC GPU 极速合成...')
      const pcRes = await requestPcVoice(offloadBridge, {
        text,
        pitch: acoustic.pitch,
        brightness: acoustic.brightness,
        rate: acoustic.rate,
      }, params.signal)
      params.signal?.throwIfAborted()
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
      params.signal?.throwIfAborted()
      console.warn('[@dsh/rvc] PC 算力分流失败，自动无缝回退至手机本地推理:', err.message)
    }
  }

  // 2. 手机端本地 ONNX 推理
  if (env.localSayvoicePath) {
    console.log(`[@dsh/rvc] 使用手机本地 ONNX 引擎执行推理 (${env.localSayvoicePath}) ...`)
    return await executePhoneSayvoice(env.localSayvoicePath, text, acoustic, outWav, modelsDir)
  }

  // 3. PC 本地 GPU 极速推理 (Windows PC 真实推理环境)
  if (env.isPc) {
    const pcScript = path.resolve(__dirname, '../../../../rvc/scripts/pc_sayvoice.py')
    if (fs.existsSync(pcScript)) {
      console.log('[@dsh/rvc] 检测到 PC 本地 GPU 发声引擎，执行 GPU 极速合成...')
      return await executePcSayvoice(text, acoustic, outWav)
    }

    throw new Error('PC语音运行环境未就绪，未生成音频；请配置已验收的voiceProfile或真实执行器。')
  }

  throw new Error('未检测到可用的 RVC 推理引擎（sayvoice.sh 未就绪且无 PC 算力桥）')
}
