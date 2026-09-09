// 捕获未捕获异常，防止进程因偶发异常退出（静默处理，不输出日志）
const ignoreErrorMessage = [
  'Possible side-effect in debug-evaluate',
  'Unexpected end of input',
]

process.on('uncaughtException', err => {
  if (ignoreErrorMessage.includes(err?.message)) return
})
process.on('unhandledRejection', () => {})
