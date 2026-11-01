// 手机端采样：3090 设备桥 + adb-shell 白名单命令。
// 零 DSH 依赖。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { toLocalISOString, getSinceMsgMin } from './sense.js'

/**
 * 设备桥 /app/device 的返回可能是：
 *   {"result":"model=...\nscreen=on\n..."}   ← 当前实际格式（包在 result 里）
 *   纯文本 "model=...\nscreen=on..."
 *   扁平 JSON {"screen":"on",...}
 * 统一成 { screen, net, battery }。
 */
export function parseDevicePayload(text) {
  let body = String(text || '')
  let flat = null
  try {
    const json = JSON.parse(body)
    if (json && typeof json === 'object') {
      if (typeof json.result === 'string') body = json.result
      else if (json.result && typeof json.result === 'object') flat = json.result
      else flat = json
    }
  } catch {
    // 纯文本
  }
  const pick = (name) => {
    const m = body.match(new RegExp(name + '=([^\\s\\\\]+)'))
    return m ? m[1] : null
  }
  return {
    screen: (flat && flat.screen) || pick('screen'),
    net: (flat && (flat.network || flat.net)) || pick('network') || pick('net'),
    battery: (flat && flat.battery) || pick('battery'),
  }
}

export async function samplePhone(options = {}) {
  const at = options.now ? new Date(options.now) : new Date()
  const sessionsRoot = options.sessionsRoot || path.join(os.homedir(), '.dsh', 'sessions')
  const sinceMsgMin = getSinceMsgMin(sessionsRoot, at)

  if (typeof options.runner === 'function') {
    return options.runner({ at, sinceMsgMin })
  }

  let screen = null
  let net = null
  let battery = null
  let fg = null
  let idleMs = null
  let error = null

  // 1. 3090 桥采样（读 /app/device）
  try {
    const tokenFile = options.tokenFile || '/root/.dsh/.bridge_headers'
    const headers = {}
    if (fs.existsSync(tokenFile)) {
      const content = fs.readFileSync(tokenFile, 'utf8')
      for (const line of content.split(/\r?\n/)) {
        const idx = line.indexOf(':')
        if (idx > 0) {
          headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }
      }
    }
    const bridgeUrl = options.bridgeUrl || 'http://127.0.0.1:3090/app/device'
    const res = await fetch(bridgeUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const text = await res.text()
      const parsed = parseDevicePayload(text)
      if (parsed.screen) screen = parsed.screen
      if (parsed.net) net = parsed.net
      if (parsed.battery) battery = parsed.battery
    } else {
      error = 'bridge-http-' + res.status
    }
  } catch {
    error = 'bridge-unavailable'
  }

  // 2. 前台应用：dumpsys window displays（白名单允许）
  try {
    const adbBin = options.adbBin || '/root/dsh-bin/adb-shell'
    if (fs.existsSync(adbBin)) {
      const out = await new Promise((res) => {
        execFile(adbBin, ['dumpsys window displays'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
          if (err) res(null)
          else res(stdout)
        })
      })
      if (out) {
        const cleaned = out.replace(/\[EXIT=\d+\]\s*$/, '')
        const fm = cleaned.match(/mCurrentFocus=Window\{[^\s}]*\s+[^\s}]*\s+([^}]+)\}/) || cleaned.match(/mCurrentFocus=Window\{.*?\s+([^\s}]+)\}/)
        if (fm) {
          fg = fm[1].trim()
        }
      }
    }
  } catch {}

  return {
    at: toLocalISOString(at),
    idleMs,
    fg,
    sinceMsgMin,
    screen,
    net,
    battery,
    error: error || null,
  }
}
