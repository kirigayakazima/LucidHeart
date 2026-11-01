import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDevicePayload } from '../lib/sense-phone.js'

test('设备桥返回包在 result 里（当前实际格式）', () => {
  const text = JSON.stringify({
    result:
      'model=Xiaomi 23049RAD8C\nbattery=87% charging=true\nnetwork=wifi\nscreen=on',
  })
  assert.deepEqual(parseDevicePayload(text), {
    screen: 'on',
    net: 'wifi',
    battery: '87%',
  })
})

test('设备桥纯文本', () => {
  const text = 'model=X\nbattery=64%\nnetwork=cellular\nscreen=off'
  assert.deepEqual(parseDevicePayload(text), {
    screen: 'off',
    net: 'cellular',
    battery: '64%',
  })
})

test('设备桥扁平 JSON', () => {
  const text = JSON.stringify({ screen: 'on', network: 'wifi', battery: '50%' })
  assert.deepEqual(parseDevicePayload(text), {
    screen: 'on',
    net: 'wifi',
    battery: '50%',
  })
})

test('坏输入不抛错', () => {
  assert.deepEqual(parseDevicePayload(''), { screen: null, net: null, battery: null })
  assert.deepEqual(parseDevicePayload('{"foo":1}'), {
    screen: null,
    net: null,
    battery: null,
  })
})
