import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export const DOT_BRIDGE_VERSION = '0.1.0-probe'
export const DOT_BRIDGE_TOKEN_ENV = 'DSH_DOT_BRIDGE_TOKEN'
const MAX_BODY_BYTES = 16 * 1024

function reply(response, status, message, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify({ error: message }))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    let chunks = []
    let exceeded = false
    request.on('data', chunk => {
      if (exceeded) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        exceeded = true
        chunks = []
        reject(Object.assign(new Error('请求正文过大'), { status: 413 }))
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      if (exceeded) return
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('无效的 JSON'), { status: 400 })) }
    })
    request.on('error', reject)
    request.on('aborted', () => reject(new Error('请求中断')))
  })
}

function createProbeServer({ dshVersion, canCreateTasks, canResumeTasks }) {
  const server = new McpServer({ name: 'dsh-dot-bridge', version: DOT_BRIDGE_VERSION }, {
    instructions: '本组件仅验证 DSH 工具连接。只读探针不创建任务，不读取会话、文件、账号或记忆。任务委派尚未实现。',
  })
  server.registerTool('dsh_bridge_probe', {
    title: '检查 DSH 桥接连接',
    description: '只读检查当前 DSH 桥接版本和任务服务接口是否存在，可回显一个短随机字符串；不证明任务执行或记忆接入已完成。',
    inputSchema: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ nonce }) => {
    const result = {
      bridgeVersion: DOT_BRIDGE_VERSION,
      mode: 'probe_only',
      dshVersion: dshVersion ?? null,
      hostInterfaces: { create: canCreateTasks === true, resume: canResumeTasks === true },
      taskExecution: 'not_implemented',
      memoryAccess: 'not_exposed',
      ...(nonce === undefined ? {} : { nonce }),
    }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
  return server
}

/** 仅监听本机回环地址；调用凭据独立于订阅 OAuth。 */
export async function startDotBridge({ token, port = 18791, dshVersion, canCreateTasks = false, canResumeTasks = false } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/u.test(token)) {
    throw new Error(`${DOT_BRIDGE_TOKEN_ENV} 必须是独立生成的至少 43 字符随机令牌`)
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效的桥接端口')
  const expected = Buffer.from(`Bearer ${token}`)
  const active = new Set()
  let closing = false
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    if (closing) return reply(response, 503, '桥接正在关闭')
    const authority = `127.0.0.1:${server.address().port}`
    if (request.headers.host !== authority || request.headers.origin !== undefined) {
      return reply(response, 403, '不允许的请求来源')
    }
    const supplied = Buffer.from(request.headers.authorization ?? '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply(response, 401, '桥接认证失败', { 'www-authenticate': 'Bearer realm="dsh-dot-bridge"' })
    }
    if (request.url !== '/mcp') return reply(response, 404, '接口不存在')
    if (request.method !== 'POST') return reply(response, 405, '仅支持 POST', { allow: 'POST' })
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return reply(response, 415, '需要 application/json')
    }
    if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return reply(response, 413, '请求正文过大')
    let mcp
    try {
      const body = await readBody(request)
      if (closing || response.destroyed) return
      mcp = createProbeServer({ dshVersion, canCreateTasks, canResumeTasks })
      active.add(mcp)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [authority],
        allowedOrigins: [],
      })
      response.once('close', () => {
        active.delete(mcp)
        void mcp.close().catch(() => {})
      })
      await mcp.connect(transport)
      await transport.handleRequest(request, response, body)
    } catch (error) {
      if (mcp) { active.delete(mcp); await mcp.close().catch(() => {}) }
      if (!response.headersSent && !response.destroyed) {
        const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500
        reply(response, status, status === 500 ? '桥接请求失败' : error.message)
      } else response.destroy()
    }
  })
  server.maxConnections = 32
  server.setTimeout(5000, socket => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  let closePromise
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close() {
      closePromise ??= (async () => {
        closing = true
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        server.closeAllConnections()
        await Promise.allSettled([...active].map(mcp => mcp.close()))
        active.clear()
        await closed
      })()
      return closePromise
    },
  }
}
