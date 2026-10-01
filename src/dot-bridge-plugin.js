import z from '@deepseek-ai/schemastery'
import { hostDshVersion } from './subagent-runtime.js'
import { DOT_BRIDGE_TOKEN_ENV, startDotBridge } from './dot-bridge.js'

export const name = 'codex-subscription-dot-bridge'
export const inject = ['agents']
export const Config = z.object({
  enabled: z.boolean().default(false),
  port: z.number().step(1).min(0).max(65535).default(18791),
})

export async function apply(ctx, config = {}) {
  const options = Config(config)
  if (!options.enabled) return
  await ctx.effect(async () => {
    const bridge = await startDotBridge({
      token: process.env[DOT_BRIDGE_TOKEN_ENV],
      port: options.port,
      dshVersion: hostDshVersion(),
      canCreateTasks: typeof ctx.agents.create === 'function',
      canResumeTasks: typeof ctx.agents.resume === 'function',
    })
    return () => bridge.close()
  }, 'dot-bridge: 只读 MCP 连接')
}
