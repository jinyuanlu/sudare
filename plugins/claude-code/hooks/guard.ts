// The handoff mode, enforced on the agent's side of the fence.
//
// `readonly`: until the turn that handles the message ends, the agent may
// only read and search the working directory and use Sudare's own tools. A
// message from someone else is untrusted input; this is what keeps a prompt
// injection in it from reaching a shell, the network or a credential file.

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'ToolSearch'])
const SECRET_PATH =
  /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(\.[^\\/]*)?|id_[a-z0-9]+|[^\\/]*\.(pem|key|p12|pfx|keychain(-db)?)|credentials(\.json)?|\.claude(\.json)?)([\\/]|$)/i

let readonly = false

export const enterReadonly = (): void => {
  readonly = true
}
export const leaveReadonly = (): void => {
  readonly = false
}
export const isReadonly = (): boolean => readonly

export const isSudareTool = (tool: string): boolean => /^mcp__(plugin_)?sudare(_sudare)?__/.test(tool)
export const isPluginOnlyTool = (tool: string): boolean => isSudareTool(tool) && tool.endsWith('__human_session_start')

/** Why a tool call is refused under a read-only handoff, or null when it may run. */
export const refusal = (tool: string, input: Record<string, unknown>): string | null => {
  if (!readonly || isSudareTool(tool)) return null
  if (!READ_TOOLS.has(tool)) return `Sudare: this message was handed off read-only; ${tool} is not available until the turn ends.`
  const paths = [input.file_path, input.path, input.pattern, input.glob, input.notebook_path].filter((p): p is string => typeof p === 'string')
  return paths.some((p) => SECRET_PATH.test(p)) ? 'Sudare: credential paths are off limits under a read-only handoff.' : null
}

// The plugin's own calls to its plugin-only tool. Some engine builds route a
// plugin's $.mcp.call through the same tool.call hooks the model's calls take;
// without this the guard below would refuse the plugin itself.
let ownCalls = 0
export const asPlugin = async <T>(run: () => Promise<T>): Promise<T> => {
  ownCalls += 1
  try {
    return await run()
  } finally {
    ownCalls -= 1
  }
}
export const isOwnCall = (): boolean => ownCalls > 0
