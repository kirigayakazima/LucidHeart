import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, name } from '../lib/index.js'
import { HeartService } from '../../heart/lib/service.js'
import { ensureLayout } from '../../heart/lib/store.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fullawake-adapter-test-'))

function startMockGateway() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        online: true,
        locked: false,
        screen_resolution: '1920x1080',
        foreground_window: 'Code - DSHA',
      }))
      return
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const json = JSON.parse(body)
          const tool = json.params?.name
          const args = json.params?.arguments || {}
          let content = []

          if (tool === 'pc_status') {
            content = [{
              type: 'text',
              text: 'PC 在线状态: 正常在线\n屏幕分辨率: 1920x1080\n前台活动窗口: Code - DSHA',
            }]
          } else if (tool === 'pc_list_windows') {
            content = [{
              type: 'text',
              text: '电脑当前共有 3 个可见窗口:\n1. [Code] Code - DSHA\n2. [Chrome] Google Chrome\n3. [Terminal] Windows Terminal',
            }]
          } else if (tool === 'pc_read_file') {
            const filePath = String(args.path || '')
            if (filePath.includes('heart')) {
              content = [{ type: 'text', text: '读取被拒绝：禁止访问 heart 目录（属于阿醒核心数据）' }]
            } else if (filePath.includes('vault')) {
              content = [{ type: 'text', text: '读取被拒绝：禁止访问 xiaoman-vault 目录' }]
            } else {
              content = [{ type: 'text', text: '# DSHA - DeepSeek Heart Agent\nMulti-Agent System for Xiaoman & Axing.' }]
            }
          } else if (tool === 'pc_snapshot') {
            content = [
              {
                type: 'image',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                mimeType: 'image/jpeg',
              },
              { type: 'text', text: '{"is_locked":false,"screen_resolution":"1920x1080"}' },
            ]
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: json.id,
            result: { content },
          }))
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r)),
      })
    })
    server.on('error', reject)
  })
}

class MockCordisHost {
  constructor() {
    this.services = new Map()
    this.tools = new Map()
  }

  createContext(pluginName) {
    const host = this
    const disposers = []

    const ctx = {
      name: pluginName,
      tools: {
        register(tool) {
          host.tools.set(tool.name, tool)
          const unreg = () => host.tools.delete(tool.name)
          disposers.push(unreg)
          return unreg
        },
      },
      get(name) {
        return host.services.get(name)
      },
      provide(name, service) {
        host.services.set(name, service)
        const unprov = () => {
          if (host.services.get(name) === service) host.services.delete(name)
        }
        disposers.push(unprov)
        return unprov
      },
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') {
          disposers.push(cleanup)
        }
      },
      dispose() {
        while (disposers.length > 0) {
          const fn = disposers.pop()
          try {
            fn()
          } catch {}
        }
      },
    }

    return ctx
  }
}

test('FullAwake Adapter: 1. 注册 4 个正式 DSH 工具与 Cordis 服务', () => {
  const host = new MockCordisHost()
  const ctx = host.createContext('dsh-fullawake')

  apply(ctx, {
    gatewayUrl: 'http://127.0.0.1:8765',
    authToken: 'xiaoman-pc-bridge-secret-2026',
  })

  // 验证工具注册
  assert.equal(host.tools.has('pc_status'), true)
  assert.equal(host.tools.has('pc_list_windows'), true)
  assert.equal(host.tools.has('pc_snapshot'), true)
  assert.equal(host.tools.has('pc_read_file'), true)

  // 验证服务导出
  const pcBridge = host.services.get('pcBridge')
  assert.ok(pcBridge)
  assert.equal(typeof pcBridge.isOnline, 'function')
  assert.equal(typeof pcBridge.checkNow, 'function')
  assert.equal(typeof pcBridge.callPcRvc, 'function')

  ctx.dispose()
})

test('FullAwake Adapter: 2. 真实调用 PC 网关能力（pc_status / pc_list_windows / pc_read_file / pc_snapshot）', async () => {
  const mockGateway = await startMockGateway()
  try {
    const host = new MockCordisHost()
    const ctx = host.createContext('dsh-fullawake')
    ctx.attachments = {
      async saveImage({ data, mediaType, name }) {
        return { id: 'img_test_123', name, size: data.length, mediaType }
      },
    }

    apply(ctx, {
      gatewayUrl: mockGateway.url,
      authToken: 'xiaoman-pc-bridge-secret-2026',
    })

    const pcStatusTool = host.tools.get('pc_status')
    const pcListTool = host.tools.get('pc_list_windows')
    const pcReadTool = host.tools.get('pc_read_file')
    const pcSnapshotTool = host.tools.get('pc_snapshot')

    // 1. 测试 pc_status
    const statusRes = await pcStatusTool.execute({})
    assert.match(statusRes.message, /PC 在线状态: 正常在线/)
    assert.match(statusRes.message, /屏幕分辨率/)

    // 2. 测试 pc_list_windows
    const listRes = await pcListTool.execute({})
    assert.match(listRes.message, /电脑当前共有/)

    // 3. 测试 pc_read_file 读取合法文件
    const readRes = await pcReadTool.execute({ path: 'README.md', start_line: 1, end_line: 5 })
    assert.match(readRes.message, /DSHA/)

    // 4. 测试安全隔离：尝试越权读取阿醒的 heart 文件被拦截
    const blockedHeart = await pcReadTool.execute({ path: 'projects/heart-plugin/package.json' })
    assert.match(blockedHeart.message, /读取被拒绝.*heart/)

    // 5. 测试安全隔离：尝试越权读取 xiaoman-vault 被拦截
    const blockedVault = await pcReadTool.execute({ path: 'projects/xiaoman-vault/README.md' })
    assert.match(blockedVault.message, /读取被拒绝.*vault/)

    // 6. 测试 pc_snapshot 并生成 image attachment
    const snapRes = await pcSnapshotTool.execute({})
    assert.match(snapRes.message, /已获取电脑截屏画面/)
    assert.equal(snapRes.images.length, 1)
    assert.equal(snapRes.images[0].id, 'img_test_123')

    ctx.dispose()
  } finally {
    await mockGateway.close()
  }
})

test('FullAwake Adapter: 3. 与 Heart Protocol v1 联动（在线与离线观察上报）', async () => {
  const mockGateway = await startMockGateway()
  try {
    const host = new MockCordisHost()
    const root = tmpDir()
    ensureLayout(root)

    // 1. 在同一 Cordis 宿主中注册 Heart 0.20.0 微内核服务
    const heartCtx = host.createContext('dsh-heart')
    const heartService = new HeartService(heartCtx, root, { device: 'phone' })
    host.services.set('heart', heartService)

    // 2. 加载 FullAwake 适配插件
    const fullawakeCtx = host.createContext('dsh-fullawake')
    apply(fullawakeCtx, {
      gatewayUrl: mockGateway.url,
      authToken: 'xiaoman-pc-bridge-secret-2026',
    })

    // 触发一次在线检测与上报
    const bridge = host.services.get('pcBridge')
    await bridge.checkNow()

    // 验证 Heart 接收到了 FullAwake 提交的 sensor 感知
    const snapshot = heartService.getSnapshot()
    assert.ok(snapshot)
    assert.equal(snapshot.protocolVersion, '1.0.0')

    // 验证感知日志落盘
    const logFile = path.join(root, 'logs', 'core.log')
    assert.equal(fs.existsSync(logFile), true)
    const logContent = fs.readFileSync(logFile, 'utf8')
    assert.match(logContent, /fullawake/)
    assert.match(logContent, /home-pc/)

    fullawakeCtx.dispose()
    heartCtx.dispose()
  } finally {
    await mockGateway.close()
  }
})

test('FullAwake Adapter: 4. PC 离线时安全降级与断网恢复', async () => {
  const host = new MockCordisHost()
  const ctx = host.createContext('dsh-fullawake')

  // 配置一个不存在的网关端口，模拟 PC 离线
  apply(ctx, {
    gatewayUrl: 'http://127.0.0.1:59999',
    authToken: 'xiaoman-pc-bridge-secret-2026',
    pollIntervalSeconds: 60,
  })

  const pcStatusTool = host.tools.get('pc_status')
  const pcListTool = host.tools.get('pc_list_windows')

  // PC 离线时执行工具，安全返回诚实提示，绝不抛错挂死
  const statusRes = await pcStatusTool.execute({})
  assert.match(statusRes.message, /电脑当前未开机或不在局域网内/)

  const listRes = await pcListTool.execute({})
  assert.match(listRes.message, /无法获取电脑窗口/)

  ctx.dispose()
})

test('FullAwake Adapter: 5. 插件重载生命周期测试（无重复工具、无残留句柄）', () => {
  const host = new MockCordisHost()

  // 首次装载
  const ctx1 = host.createContext('dsh-fullawake')
  apply(ctx1, { gatewayUrl: 'http://127.0.0.1:8765' })
  assert.equal(host.tools.size, 4)

  // 卸载
  ctx1.dispose()
  assert.equal(host.tools.size, 0)
  assert.equal(host.services.has('pcBridge'), false)

  // 重新装载
  const ctx2 = host.createContext('dsh-fullawake')
  apply(ctx2, { gatewayUrl: 'http://127.0.0.1:8765' })
  assert.equal(host.tools.size, 4)

  ctx2.dispose()
  assert.equal(host.tools.size, 0)
})
