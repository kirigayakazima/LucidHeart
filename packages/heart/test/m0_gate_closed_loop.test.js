import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HeartService } from '../lib/service.js'

test('M0-02 Gate Closed Loop: quiet hours and sleep gate block autonomous vocal activity', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-m0-test-'))
  try {
    const service = new HeartService(null, tempRoot, {
      quietFrom: '00:00',
      quietTo: '23:59', // Force quiet hours for test execution
    })

    const autoExecution = {
      agent: {
        session: {
          snapshotEvents: () => [
            { type: 'user/message', data: { source: { kind: 'schedule' } } }
          ]
        }
      }
    }

    // 1. Autonomous request during quiet hours -> blocked
    const autonomousGate = service.evaluateActivity(
      { intent: 'speak', category: 'bilibili' },
      { execution: autoExecution }
    )
    assert.equal(autonomousGate.suitable, false)
    assert.equal(autonomousGate.reason, 'quiet-hours')
    assert.equal(autonomousGate.origin, 'autonomous')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('M0-02 Gate Closed Loop: organ observations are accepted and traceable', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-m0-obs-'))
  try {
    const service = new HeartService(null, tempRoot)

    // RVC voice observation receipt
    const rvcReceipt = await service.observe({
      type: 'voice',
      source: 'rvc',
      confidence: 0.95,
      evidence: { tone: 'cheerful', pitch: 0, durationMs: 3200 },
    })
    assert.equal(rvcReceipt.accepted, true)
    assert.ok(rvcReceipt.observationId)
    assert.ok(rvcReceipt.snapshot)

    // FullAwake vision observation receipt
    const visionReceipt = await service.observe({
      type: 'vision',
      source: 'fullawake',
      confidence: 0.88,
      evidence: { contactSheetTokens: 384, app: 'bilibili' },
    })
    assert.equal(visionReceipt.accepted, true)
    assert.ok(visionReceipt.observationId)

    // Invalid observation rejected
    const invalidReceipt = await service.observe({
      type: 'unknown_type',
      source: '',
    })
    assert.equal(invalidReceipt.accepted, false)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
