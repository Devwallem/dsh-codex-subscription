import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Context } from '@deepseek-ai/cordis'
import { DOT_BRIDGE_TOKEN_ENV, startDotBridge } from '../src/dot-bridge.js'
import * as plugin from '../src/dot-bridge-plugin.js'

const { apply, Config } = plugin

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' },
} }

async function fixture(t) {
  const token = randomBytes(32).toString('base64url')
  const bridge = await startDotBridge({ token, port: 0, dshVersion: '0.2.0-rc.2', canCreateTasks: true })
  t.after(() => bridge.close())
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  return { token, bridge, headers }
}

test('真实 MCP 客户端可发现并调用唯一只读工具，返回能力而非任务成功', async t => {
  const { bridge, headers, token } = await fixture(t)
  const client = new Client({ name: 'probe-client', version: '1' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers } }))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(tool => tool.name), ['dsh_bridge_probe'])
  assert.equal(tools[0].annotations.readOnlyHint, true)
  assert.equal(tools[0].annotations.openWorldHint, false)
  const result = await client.callTool({ name: 'dsh_bridge_probe', arguments: { nonce: 'trial_123' } })
  assert.deepEqual(result.structuredContent, {
    bridgeVersion: '0.1.0-probe', mode: 'probe_only', dshVersion: '0.2.0-rc.2',
    hostInterfaces: { create: true, resume: false }, taskExecution: 'not_implemented',
    memoryAccess: 'not_exposed', nonce: 'trial_123',
  })
  assert.equal(JSON.stringify(result).includes(token), false)
  assert.equal((await client.callTool({ name: 'start_task', arguments: {} })).isError, true)
  assert.equal((await client.callTool({ name: 'dsh_bridge_probe', arguments: { nonce: 'x', path: '/private' } })).isError, true)
  assert.equal((await client.callTool({ name: 'dsh_bridge_probe', arguments: { nonce: 'x'.repeat(129) } })).isError, true)
})

test('未认证及错误令牌不能初始化或列举工具', async t => {
  const { bridge, headers, token } = await fixture(t)
  for (const authorization of ['', `Bearer ${'x'.repeat(43)}`]) {
    const response = await fetch(bridge.url, { method: 'POST', headers: { ...headers, authorization }, body: JSON.stringify(initialize) })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate'), /^Bearer/u)
    assert.equal((await response.text()).includes(token), false)
  }
})

test('拒绝浏览器来源和非回环 Host，认证不能绕过来源检查', async t => {
  const { bridge, headers } = await fixture(t)
  for (const extra of [{ origin: 'https://example.com' }, { host: 'attacker.example' }]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(bridge.url, { method: 'POST', headers: { ...headers, ...extra } }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end(JSON.stringify(initialize))
    })
    assert.equal(status, 403)
  }
})

test('接口、方法、正文格式和大小有明确边界', async t => {
  const { bridge, headers } = await fixture(t)
  for (const [path, method, body, extra, expected] of [
    ['/other', 'POST', '{}', {}, 404],
    ['/mcp', 'GET', undefined, {}, 405],
    ['/mcp', 'POST', '{}', { 'content-type': 'text/plain' }, 415],
    ['/mcp', 'POST', '{', {}, 400],
    ['/mcp', 'POST', 'x'.repeat(16385), {}, 413],
  ]) {
    const response = await fetch(new URL(path, bridge.url), { method, headers: { ...headers, ...extra }, body })
    assert.equal(response.status, expected)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    await response.text()
  }
})

test('没有 Content-Length 的超大分块正文也会被拒绝', async t => {
  const { bridge, headers } = await fixture(t)
  const status = await new Promise((resolve, reject) => {
    const req = request(bridge.url, { method: 'POST', headers }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.write('x'.repeat(10000))
    req.write('x'.repeat(10000))
    req.end()
  })
  assert.equal(status, 413)
})

test('缺少独立令牌时不启动，端口冲突明确失败，关闭后可重新绑定', async t => {
  await assert.rejects(startDotBridge(), new RegExp(DOT_BRIDGE_TOKEN_ENV, 'u'))
  await assert.rejects(startDotBridge({ token: 'short' }), /随机令牌/u)
  const { bridge, token } = await fixture(t)
  const port = Number(new URL(bridge.url).port)
  await assert.rejects(startDotBridge({ token, port }), { code: 'EADDRINUSE' })
  await Promise.all([bridge.close(), bridge.close()])
  const next = await startDotBridge({ token, port })
  await next.close()
})

test('组件默认关闭，不接触宿主服务或凭据', async () => {
  assert.equal(Config({}).enabled, false)
  const inaccessible = new Proxy({}, { get() { throw new Error('不应读取宿主') } })
  await apply(inaccessible)
  await apply(inaccessible, { enabled: false })
})

test('显式启用只注册可清理的只读连接，不调用任务服务', async t => {
  const previous = process.env[DOT_BRIDGE_TOKEN_ENV]
  process.env[DOT_BRIDGE_TOKEN_ENV] = randomBytes(32).toString('base64url')
  t.after(() => {
    if (previous === undefined) delete process.env[DOT_BRIDGE_TOKEN_ENV]
    else process.env[DOT_BRIDGE_TOKEN_ENV] = previous
  })
  let dispose
  const ctx = {
    agents: { create() { assert.fail('不应创建任务') }, resume() { assert.fail('不应恢复任务') } },
    async effect(setup) { dispose = await setup() },
  }
  await apply(ctx, { enabled: true, port: 0 })
  assert.equal(typeof dispose, 'function')
  await dispose()
})

test('真实 Cordis 加载与卸载独立入口，不需要订阅账号服务', async t => {
  const previous = process.env[DOT_BRIDGE_TOKEN_ENV]
  process.env[DOT_BRIDGE_TOKEN_ENV] = randomBytes(32).toString('base64url')
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env[DOT_BRIDGE_TOKEN_ENV]
    else process.env[DOT_BRIDGE_TOKEN_ENV] = previous
  })
  ctx.provide('agents', { create() { assert.fail('不应创建任务') }, resume() { assert.fail('不应恢复任务') } })
  const fiber = await ctx.plugin(plugin, { enabled: true, port: 0 })
  assert.equal(fiber.state, 2)
  await fiber.dispose()
  assert.equal(fiber.state, 4)
})
