/** Locale-owned startup and transport diagnostics, shared by both compiler faces. */
const english = {
  description: 'Use DeepSeek Harness in your terminal.',
  help: 'show this help',
  connect: 'attach using an authenticated URL in a private file',
  profile: 'Web profile to start when this terminal owns the Host',
  cwd: 'working directory for new sessions',
  cwdDefault: 'current working directory',
  resume: 'resume a session by ID',
  load: 'choose an existing session',
  preset: 'preset for a new session',
  incompatible: 'Choose only one of --resume, --load, and --preset.',
  terminal: 'Start dsh tui from an interactive terminal.',
  launch: 'The terminal Host could not start. Check the Web profile configuration.',
  ended: 'The terminal Host stopped.',
  auth: 'The Host rejected the connection. Refresh the authenticated URL file and reconnect.',
  url: 'Use an HTTP(S) authenticated Host URL with one token and no embedded username or password.',
  scope: 'The request leaves the authenticated Host address.',
  file: 'The connection URL file must be a regular file owned by you and readable only by you.',
  ready: 'The Host did not become ready within the configured startup timeout.',
}
const chinese: typeof english = {
  cwdDefault: '当前工作目录',
  description: '在终端中使用 DeepSeek Harness。', help: '显示帮助',
  connect: '使用私有文件中的认证 URL 连接现有主机', profile: '此终端启动主机时使用的 Web 配置',
  cwd: '新会话的工作目录', resume: '按 ID 恢复会话', load: '选择现有会话', preset: '新会话的预设',
  incompatible: '--resume、--load 和 --preset 只能选择一项。', terminal: '请在交互式终端中运行 dsh tui。',
  launch: '终端主机无法启动。请检查 Web 配置。', ended: '终端主机已停止。',
  auth: '主机拒绝连接。请更新认证 URL 文件后重新连接。',
  url: '请使用含有一个令牌且不含用户名或密码的 HTTP(S) 主机认证 URL。',
  scope: '请求超出了认证主机地址范围。', file: '连接 URL 文件必须是由你所有且仅你可读取的普通文件。',
  ready: '主机未在配置的启动超时时间内就绪。',
}
/** Startup locale before a Host settings service exists. */
export const runtimeCopy = /^(zh)(?:_|-|$)/i.test(process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? '') ? chinese : english
