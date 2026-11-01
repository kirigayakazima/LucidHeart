// 幂等补丁安装脚本：将 qqbotSender 服务暴露与 wake-gate 唤醒门控安全打入已安装的 @tencent-connect/dsh-qqbot
// 兼容 0.5.2 与 0.5.5+ 版本

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function findQqbotPkgDir() {
  const candidates = [
    process.env.QQBOT_PKG,
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@tencent-connect', 'dsh-qqbot'),
    path.join(os.homedir(), '.dsh', 'plugin-src', '@tencent-connect', 'dsh-qqbot'),
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@tencent-connect', 'dsh-qqbot'),
    path.join(os.homedir(), '.dsh', 'node_modules', '@tencent-connect', 'dsh-qqbot'),
    path.join(process.cwd(), 'node_modules', '@tencent-connect', 'dsh-qqbot'),
  ].filter(Boolean)

  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'lib', 'gateway', 'bootstrap.js')) ||
      fs.existsSync(path.join(dir, 'dist', 'gateway', 'bootstrap.js'))
    ) {
      return dir
    }
  }
  return null
}

export function patchQqbot(pkgDir) {
  if (!pkgDir || !fs.existsSync(pkgDir)) {
    throw new Error(`找不到 @tencent-connect/dsh-qqbot 插件安装目录：${pkgDir}`)
  }

  const sub = fs.existsSync(path.join(pkgDir, 'lib', 'gateway', 'bootstrap.js')) ? 'lib' : 'dist'
  const bootstrapFile = path.join(pkgDir, sub, 'gateway', 'bootstrap.js')
  const mwFile = path.join(pkgDir, sub, 'gateway', 'middleware-setup.js')

  const results = {
    bootstrap: 'unchanged',
    middleware: 'unchanged',
  }

  // 1. 补丁 bootstrap.js：暴露 qqbotSender 服务 (供 @dsh/qq-plus 出站包装)
  if (fs.existsSync(bootstrapFile)) {
    let bsContent = fs.readFileSync(bootstrapFile, 'utf8')
    if (bsContent.includes("ctx.provide('qqbotSender'")) {
      results.bootstrap = 'already_patched'
    } else {
      // 匹配 sender 定义结尾处
      const senderPattern = /(const\s+sender\s*=\s*\{[\s\S]*?\};)/m
      if (senderPattern.test(bsContent)) {
        fs.copyFileSync(bootstrapFile, bootstrapFile + '.bak-qqplus')
        bsContent = bsContent.replace(
          senderPattern,
          "$1\nctx.provide('qqbotSender', sender);\n"
        )
        fs.writeFileSync(bootstrapFile, bsContent, 'utf8')
        results.bootstrap = 'patched'
      } else {
        results.bootstrap = 'sender_pattern_not_found'
      }
    }
  }

  // 2. 补丁 middleware-setup.js：以 wakeGate 替代默认 mentionGate
  if (fs.existsSync(mwFile)) {
    let mwContent = fs.readFileSync(mwFile, 'utf8')
    if (mwContent.includes('@dsh/qq-plus/wake') || mwContent.includes('wakeGate')) {
      results.middleware = 'already_patched'
    } else {
      const gatePattern = /bot\.use\(mentionGate\(\{[\s\S]*?\}\)\);/m
      if (gatePattern.test(mwContent)) {
        fs.copyFileSync(mwFile, mwFile + '.bak-qqplus')
        // 导入 wakeGate
        mwContent = "import { wakeGate } from '@dsh/qq-plus/wake';\n" + mwContent
        mwContent = mwContent.replace(
          gatePattern,
          'bot.use(wakeGate({ requireMentionInGroup: config.requireMention, appId: config.appId }));'
        )
        fs.writeFileSync(mwFile, mwContent, 'utf8')
        results.middleware = 'patched'
      } else {
        results.middleware = 'mention_gate_not_found'
      }
    }
  }

  return results
}

// CLI 直接执行处理
if (process.argv[1] && process.argv[1].endsWith('apply-patch.mjs')) {
  const targetDir = process.argv[2] || findQqbotPkgDir()
  if (!targetDir) {
    console.error('[qq-plus:patch] ✗ 未找到已安装的 @tencent-connect/dsh-qqbot')
    process.exit(1)
  }
  console.log(`[qq-plus:patch] 目标目录: ${targetDir}`)
  const res = patchQqbot(targetDir)
  console.log(`[qq-plus:patch] bootstrap.js: ${res.bootstrap}`)
  console.log(`[qq-plus:patch] middleware-setup.js: ${res.middleware}`)
  console.log('[qq-plus:patch] ✓ 补丁处理完成')
}
