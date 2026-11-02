import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityOrigin } from '../lib/activity-origin.js'

const message = (kind) => ({ role: 'user', source: { kind } })
const event = (kind) => ({ type: 'user/message', data: message(kind) })
const execution = (events) => ({ agent: { session: { snapshotEvents: () => events } } })

test('activity origin follows consumed host messages, not text or queued inbox work', () => {
  const events = [event('schedule'), {
    type: 'agent/inbox/spliced', data: { inserted: [message('user')] },
  }]
  assert.equal(activityOrigin(execution(events)), 'autonomous')
  events.push(event('user'), event('runtime-context'), { type: 'tool/call', data: {} })
  assert.equal(activityOrigin(execution(events)), 'user_request')
  events.push(event('schedule'))
  assert.equal(activityOrigin(execution(events)), 'autonomous')
  events.push(event('plugin'))
  assert.equal(activityOrigin(execution(events)), 'autonomous')
  events.push(event('future-trigger'))
  assert.equal(activityOrigin(execution(events)), 'unknown')
})

test('activity origin supports older live session APIs and fails conservatively', () => {
  assert.equal(activityOrigin({ agent: { session: { events: [event('user')] } } }), 'user_request')
  assert.equal(activityOrigin({ agent: { session: { messages: [message('user')] } } }), 'user_request')
  assert.equal(activityOrigin({ agent: { session: { deriveMessages: () => [message('schedule')] } } }), 'autonomous')
  assert.equal(activityOrigin({ origin: 'user_request' }), 'unknown')
  assert.equal(activityOrigin(), 'unknown')
  assert.equal(activityOrigin({ agent: { get session() { throw Error('unavailable') } } }), 'unknown')
  assert.equal(activityOrigin(execution([])), 'unknown')
})
