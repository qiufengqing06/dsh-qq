/** Apply one QQ chat agent's tool policy without changing sibling agents. */
export function configureChatTools(agentCtx, agent, allowed) {
  const tools = agentCtx?.tools
  if (tools === undefined || tools === null) return () => {}
  if (typeof tools.guard !== 'function') {
    throw new Error('dsh-qq: host tool guard is unavailable')
  }

  // run_code is a presentation transport, never a chat capability.
  const names = new Set([...allowed].filter(name => typeof name === 'string' && name !== 'run_code'))
  const releases = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    let failure
    for (const release of releases.reverse()) {
      try { release?.() } catch (error) { failure ??= error }
    }
    if (failure !== undefined) throw failure
  }

  try {
    // A scope's own registrations bypass restrict(), so keep the execution guard.
    releases.push(tools.guard(exec => {
      if (names.has(String(exec?.name ?? ''))) return undefined
      return `（聊天模式内部限制：不执行工作工具「${exec?.name ?? '未知'}」。如需工作工具，简短说明需切换工作模式；不要假装已经执行。）`
    }))

    // Older hosts retain the guard; do not partially switch presentation.
    if (typeof tools.presentAs === 'function' && typeof tools.restrict === 'function' && typeof tools.schemas === 'function') {
      if (agent === undefined || agent === null) throw new Error('dsh-qq: chat tool policy requires the agent scope')
      releases.push(tools.presentAs('native'))
      // Omitting agent would inspect only global tools and miss preset tools.
      const visible = new Set(tools.schemas(agent).map(tool => tool.name))
      releases.push(tools.restrict({ allow: [...names].filter(name => visible.has(name)) }))
    }
    return dispose
  } catch (error) {
    try { dispose() } catch { /* Preserve the initialization failure. */ }
    throw error
  }
}
