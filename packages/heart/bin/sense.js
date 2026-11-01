#!/usr/bin/env node
// 独立运行的 CLI 采样工具，零 DSH 依赖。
// 用法：node bin/sense.js
import { senseSample, applyPresence, readSense } from '../lib/sense.js'
import { resolveRoot, readHeartConfig } from '../lib/store.js'

const root = resolveRoot(process.env.HEART_ROOT || process.env.DSH_HEART_ROOT)
const config = readHeartConfig(root)
const prev = readSense(root)
const sample = await senseSample(root, config)
const next = applyPresence(prev, sample, config)

console.log(JSON.stringify(next, null, 2))
