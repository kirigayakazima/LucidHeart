import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, secret } from './fixture.js'
import { signature } from '../lib/collaboration/sister_channel.js'

test('signed three-party collaboration persists knowledge and responsibility without promising for a sister', async t => {
  let packet
  const sender = fixture(t, { transport: async value => { packet = value } })
  const receiver = fixture(t, { role: 'axing' })
  const args = { type: 'joint_task', summary: '小满准备节目，阿醒稍后自行确认', payload: { task_id: 'program-1', action: 'prepare' },
    collaboration: { participants: ['owner', 'xiaoman', 'axing'], authorizedBy: ['owner', 'xiaoman'],
      informed: ['owner', 'xiaoman'], responsible: 'xiaoman', action: 'prepare', consentMessageId: 'real-user-1' } }
  await sender.sister.send(args)
  const body = JSON.stringify(packet)
  assert.equal(receiver.sister.ingest(body, signature(body, secret), secret).accepted, true)
  const received = receiver.sister.receive()[0]
  assert.deepEqual(received.collaboration.informed, ['owner', 'xiaoman'])
  assert.ok(!received.collaboration.authorizedBy.includes('axing'))
  assert.equal(receiver.sister.ingest(body, signature(body, secret), secret).duplicate, true)
  await assert.rejects(sender.sister.send({ ...args, collaboration: { ...args.collaboration, responsible: 'axing' } }), /不能替/)
  await assert.rejects(sender.sister.send({ ...args, collaboration: undefined }), /显式协作/)
  await assert.rejects(sender.sister.send({ ...args, payload: { ...args.payload, private_state: 'secret' } }), /允许字段/)
  const forged = JSON.stringify({ ...packet, collaboration: { ...args.collaboration, authorizedBy: ['owner', 'axing', 'xiaoman'] } })
  assert.throws(() => receiver.sister.ingest(forged, signature(forged, secret), secret), /授权尚未确认/)
})
