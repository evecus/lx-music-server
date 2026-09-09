import http, { type IncomingMessage } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { registerLocalSyncEvent, callObj, sync } from './sync'
import { authCode, authConnect } from './auth'
import { getAddress, decryptMsg, encryptMsg, getIP } from '@/utils/tools'
import { SYNC_CLOSE_CODE, SYNC_CODE, File } from '@/constants'
import { getUserSpace, releaseUserSpace, getUserName, getServerId } from '@/user'
import { createMsg2call } from 'message2call'
// @ts-ignore
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
const musicSdk = musicSdkRaw as any
import { initUserApis, callUserApiGetMusicUrl, isSourceSupported, getLoadedApis } from './userApi'
import * as customSourceHandlers from './customSourceHandlers'
import * as fileCache from './fileCache'
import crypto from 'node:crypto'
const { MusicTagger, MetaPicture } = require('music-tag-native')

// ===== Player Session Store =====
const playerSessions = new Map<string, { createdAt: number }>()
const SESSION_TTL = 24 * 60 * 60 * 1000 // 24小时
const SESSION_COOKIE_NAME = 'lx_player_session'

/** 生成随机 sessionId */
const generateSessionId = () => crypto.randomBytes(32).toString('hex')

/** 解析 Cookie 字符串 */
const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) return {}
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=')
      return [k.trim(), decodeURIComponent(v.join('='))]
    })
  )
}

/** 检查请求是否携带有效的 Player Session Cookie */
const checkPlayerAuth = (req: IncomingMessage): boolean => {
  if (!global.lx.config['player.enableAuth']) return true // 未开启认证，直接放行
  const cookies = parseCookies(req.headers['cookie'])
  const sessionId = cookies[SESSION_COOKIE_NAME]
  if (!sessionId) return false
  const session = playerSessions.get(sessionId)
  if (!session) return false
  if (Date.now() - session.createdAt > SESSION_TTL) {
    playerSessions.delete(sessionId)
    return false
  }
  return true
}

/** 定期清理过期 Session（每小时） */
setInterval(() => {
  const now = Date.now()
  for (const [id, session] of playerSessions) {
    if (now - session.createdAt > SESSION_TTL) playerSessions.delete(id)
  }
}, 60 * 60 * 1000)
// ===== End Session Store =====


const getMime = (filename: string) => {
  const ext = path.extname(filename).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

/**
 * 规范化歌曲信息，确保收藏列表中的 meta 属性在根节点也可用
 * 解决 SDK 无法识别收藏歌曲音质的问题
 */
const normalizeSongInfo = (songInfo: any) => {
  if (!songInfo) return songInfo
  const meta = songInfo.meta || {}

  // 1. 处理音质信息 (types / _types)
  if (!songInfo.types && meta) {
    songInfo.types = meta.qualitys || meta.types
  }
  if (!songInfo._types && meta) {
    songInfo._types = meta._qualitys || meta._types
  }

  // 2. 处理基础字段备用根节点映射
  if (!songInfo.albumName && meta.albumName) songInfo.albumName = meta.albumName
  if (!songInfo.albumId && meta.albumId) songInfo.albumId = meta.albumId
  if (!songInfo.img && meta.picUrl) songInfo.img = meta.picUrl
  if (!songInfo.name && meta.name) songInfo.name = meta.name
  if (!songInfo.singer && meta.singer) songInfo.singer = meta.singer
  if (!songInfo.source && meta.source) songInfo.source = meta.source
  if (!songInfo.interval && meta.interval) songInfo.interval = meta.interval

  // 3. 处理通用 ID 转换 (id -> songmid)
  if (!songInfo.songmid) {
    if (meta.songId) {
      songInfo.songmid = meta.songId
    } else if (songInfo.id) {
      const sourcePrefix = `${songInfo.source}_`
      if (typeof songInfo.id === 'string' && songInfo.id.startsWith(sourcePrefix)) {
        songInfo.songmid = songInfo.id.slice(sourcePrefix.length)
      } else {
        songInfo.songmid = songInfo.id
      }
    }
  }

  // 4. 针对各平台 SDK 所需的特定字段进行补全
  switch (songInfo.source) {
    case 'wy': // 网易
      if (!songInfo.id && meta.songId) songInfo.id = Number(meta.songId)
      if (!songInfo.songmid && songInfo.id) songInfo.songmid = String(songInfo.id)
      break

    case 'kg': // 酷狗
      if (!songInfo.hash && meta.hash) songInfo.hash = meta.hash
      // 兼容某些 SDK 可能需要的 songmid 格式 (数字_哈希 或 仅哈Hash)
      break

    case 'tx': // 腾讯
      if (!songInfo.strMediaMid && meta.strMediaMid) songInfo.strMediaMid = meta.strMediaMid
      if (!songInfo.albumMid && meta.albumMid) songInfo.albumMid = meta.albumMid
      // 只有当 meta 中的 songId 是纯数字时才回填至 root.songId，否则保持 undefined 触发 SDK 自动获取
      const metaSongId = String(meta.songId || '')
      if (/^\d+$/.test(metaSongId)) {
        songInfo.songId = metaSongId
      }
      break

    case 'mg': // 咪咕
      if (!songInfo.copyrightId && meta.copyrightId) songInfo.copyrightId = meta.copyrightId
      if (!songInfo.lrcUrl && meta.lrcUrl) songInfo.lrcUrl = meta.lrcUrl
      if (!songInfo.songId) songInfo.songId = songInfo.songmid
      break

    case 'kw': // 酷我
      // 已在步骤 3 中通用处理
      break
  }

  return songInfo
}

let status: LX.Sync.Status = {
  status: false,
  message: '',
  address: [],
  // code: '',
  devices: [],
}

let host = 'http://localhost'
const sseClients = new Set<http.ServerResponse>()
// 音乐解析进度 SSE 专属通道: requestId -> response
const musicProgressClients = new Map<string, http.ServerResponse>()

// const codeTools: {
//   timeout: NodeJS.Timer | null
//   start: () => void
//   stop: () => void
// } = {
//   timeout: null,
//   start() {
//     this.stop()
//     this.timeout = setInterval(() => {
//       void generateCode()
//     }, 60 * 3 * 1000)
//   },
//   stop() {
//     if (!this.timeout) return
//     clearInterval(this.timeout)
//     this.timeout = null
//   },
// }

const checkDuplicateClient = (newSocket: LX.Socket) => {
  for (const client of [...wss!.clients]) {
    if (client === newSocket || client.keyInfo.clientId != newSocket.keyInfo.clientId) continue
    client.isReady = false
    for (const name of Object.keys(client.moduleReadys) as Array<keyof LX.Socket['moduleReadys']>) {
      client.moduleReadys[name] = false
    }
    client.close(SYNC_CLOSE_CODE.normal)
  }
}

const handleConnection = async (socket: LX.Socket, request: IncomingMessage) => {
  const queryData = new URL(request.url as string, host).searchParams
  const clientId = queryData.get('i')

  //   // if (typeof socket.handshake.query.i != 'string') return socket.disconnect(true)
  const userName = getUserName(clientId)
  if (!userName) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  const userSpace = getUserSpace(userName)
  const keyInfo = userSpace.dataManage.getClientKeyInfo(clientId)
  if (!keyInfo) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  const user = global.lx.config.users.find(u => u.name == userName)
  if (!user) {
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  keyInfo.lastConnectDate = Date.now()
  userSpace.dataManage.saveClientKeyInfo(keyInfo)
  //   // socket.lx_keyInfo = keyInfo
  socket.keyInfo = keyInfo
  socket.userInfo = user

  checkDuplicateClient(socket)

  try {
    await sync(socket)
  } catch (err) {
    // console.log(err)
    socket.close(SYNC_CLOSE_CODE.failed)
    return
  }
  status.devices.push(keyInfo)
  // handleConnection(io, socket)
  socket.onClose(() => {
    status.devices.splice(status.devices.findIndex(k => k.clientId == keyInfo.clientId), 1)
  })

  // console.log('connection', keyInfo.deviceName)
  // console.log(socket.handshake.query)

  socket.isReady = true
}

const handleUnconnection = (userName: string) => {
  // console.log('unconnection')
  releaseUserSpace(userName)
}

const authConnection = (req: http.IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
  // console.log(req.headers)
  // // console.log(req.auth)
  // console.log(req._query.authCode)
  authConnect(req).then(() => {
    callback(null, true)
  }).catch(err => {
    // console.log('WebSocket auth failed:', err.message)
    callback(null, false) // <--- 修改为传递 null, false
  })
}

let wss: LX.SocketServer | null

function noop() { }
function onSocketError(err: Error) {
}


const readBody = async (req: IncomingMessage) => await new Promise<string>((resolve, reject) => {
  const chunks: any[] = []
  req.on('data', chunk => { chunks.push(chunk) })
  req.on('end', () => {
    resolve(Buffer.concat(chunks).toString('utf-8'))
  })
  req.on('error', reject)
})

const serveStatic = (req: IncomingMessage, res: http.ServerResponse, filePath: string) => {
  const contentType = getMime(filePath)

  try {
    const stats = fs.statSync(filePath)
    const mtime = stats.mtime.getTime()
    const etag = `W/"${stats.size}-${mtime}"`
    const lastModified = stats.mtime.toUTCString()

    // Check Cache Validity (Conditional Requests)
    if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304)
      res.end()
      return
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404)
          res.end('Not Found')
        } else {
          res.writeHead(500)
          res.end('Server Error')
        }
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'ETag': etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'no-cache, must-revalidate', // Force browser to revalidate every time
          'Pragma': 'no-cache',
          'Expires': '0',
        })
        res.end(content, 'utf-8')
      }
    })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.writeHead(404)
      res.end('Not Found')
    } else {
      res.writeHead(500)
      res.end('Server Error')
    }
  }
}

const handleStartServer = async (port = 9527, ip = '127.0.0.1') => await new Promise((resolve, reject) => {
  const httpServer = http.createServer(async (req, res) => {
    const ip = getIP(req)
    // console.log(req.url)
    const urlObj = new URL(req.url ?? '', `http://${req.headers.host}`)
    const pathname = urlObj.pathname

    // Serve Music Player Static Files
    if (pathname.startsWith('/music')) {
      // 白名单：登录页、静态资源无需认证
      const isLoginPage = pathname === '/music/login' || pathname === '/music/login.html'
      const isPublicAsset = pathname.startsWith('/music/assets/') ||
        pathname.startsWith('/music/css/') ||
        pathname.startsWith('/music/js/') ||
        pathname === '/music/manifest.json' ||
        pathname === '/music/sw.js'

      // 认证检查：仅对主页面（非白名单）进行保护
      if (!isLoginPage && !isPublicAsset && global.lx.config['player.enableAuth']) {
        if (!checkPlayerAuth(req)) {
          res.writeHead(302, { 'Location': '/music/login' })
          res.end()
          return
        }
      }

      // Defaults to index.html if exactly /music or /music/
      let targetPath = pathname
      if (pathname === '/music' || pathname === '/music/') {
        targetPath = '/music/index.html'
      } else if (isLoginPage) {
        targetPath = '/music/login.html'
      }
      // public/music/xxx
      // global.lx.staticPath points to `public`
      const filePath = path.join(global.lx.staticPath, targetPath)
      serveStatic(req, res, filePath)
      return
    }

    // 动态 config.js - 从静态文件读取版本号, 合并服务端配置注入 window.CONFIG
    // 配置优先级: 环境变量 > 根目录 config.js > src/defaultConfig.ts
    if (pathname === '/js/config.js') {
      // 从静态文件读取版本号和构建哈希
      const staticConfigPath = path.join(global.lx.staticPath, 'js', 'config.js')
      let version = 'v1.0.0'
      let buildHash = 'unknown'
      try {
        const content = fs.readFileSync(staticConfigPath, 'utf-8')
        const matchVersion = content.match(/version:\s*['"]([^'"]+)['"]/)
        if (matchVersion) version = matchVersion[1]
        const matchHash = content.match(/buildHash:\s*['"]([^'"]+)['"]/)
        if (matchHash) buildHash = matchHash[1]
      } catch { }

      // 构造前端配置 (不含敏感字段如密码)
      const frontendConfig = {
        version,
        buildHash,
        serverName: global.lx.config.serverName,
        disableTelemetry: global.lx.config.disableTelemetry || false,
        'proxy.enabled': global.lx.config['proxy.enabled'],
        'user.enablePath': global.lx.config['user.enablePath'],
        'user.enableRoot': global.lx.config['user.enableRoot'],
        'user.enablePublicRestriction': global.lx.config['user.enablePublicRestriction'] || false,
        maxSnapshotNum: global.lx.config.maxSnapshotNum,
        'list.addMusicLocationType': global.lx.config['list.addMusicLocationType'],
        'player.enableAuth': global.lx.config['player.enableAuth'] || false,
        port: global.lx.config.port,
        bindIP: global.lx.config.bindIP,
      }

      const configJs = `window.CONFIG = ${JSON.stringify(frontendConfig, null, 2)};`
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      })
      res.end(configJs)
      return
    }

    if (pathname.startsWith('/api/')) {


      
      // [新增] 获取服务器状态
      
      
            // 获取快照列表
      
      // 下载快照数据
      
      // 恢复快照
      
      // [新增] Batch Remove Songs from List (User Auth)
      if (pathname === '/api/music/user/list/remove' && req.method === 'POST') {
        const username = req.headers['x-user-name'] as string
        const password = req.headers['x-user-password'] as string

        if (!username || !password) {
          res.writeHead(401)
          res.end('需要用户认证')
          return
        }

        const user = global.lx.config.users.find(u => u.name === username && u.password === password)
        if (!user) {
          res.writeHead(401)
          res.end('用户名或密码错误')
          return
        }

        void readBody(req).then(async body => {
          try {
            const { listId, songIds } = JSON.parse(body)

            if (!listId || !Array.isArray(songIds)) {
              res.writeHead(400)
              res.end('参数错误:需要listId和songIds数组')
              return
            }


            const userSpace = getUserSpace(username)

            // Get list before deletion
            const listBefore = await userSpace.listManage.listDataManage.getListMusics(listId)

            // Remove songs from the list
            const affectedLists = await userSpace.listManage.listDataManage.listMusicRemove(listId, songIds)

            // Get list after deletion  
            const listAfter = await userSpace.listManage.listDataManage.getListMusics(listId)

            // Create new snapshot to persist changes
            const newSnapshotKey = await userSpace.listManage.createSnapshot()

            res.writeHead(200)
            res.end('删除成功')
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message || '删除失败')
          }
        })
        return
      }


      // [新增] 删除快照 API
            // [新增] 上传快照 API
      
      // [新增] User Login Verification
      if (pathname === '/api/user/verify' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { username, password } = JSON.parse(body)
            if (!username || !password) {
              res.writeHead(400)
              res.end('Missing username or password')
              return
            }
            const user = global.lx.config.users.find(u => u.name === username && u.password === password)
            if (user) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Invalid credentials' }))
            }
          } catch (e) {
            res.writeHead(400)
            res.end('Bad Request')
          }
        })
        return
      }

      // [新增] Get User List (User Auth)
      if (pathname === '/api/user/list' && req.method === 'GET') {
        const username = req.headers['x-user-name'] as string
        const password = req.headers['x-user-password'] as string

        if (!username || !password) {
          res.writeHead(401)
          res.end('Missing credentials')
          return
        }

        const user = global.lx.config.users.find(u => u.name === username && u.password === password)
        if (!user) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const userSpace = getUserSpace(username)
        void userSpace.listManage.getListData().then(data => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          })
          res.end(JSON.stringify(data))
        }).catch(err => {
          res.writeHead(500)
          res.end(err.message)
        })
        return
      }

      // [新增] Update User List (User Auth) - Full Restore/Overwrite
      if (pathname === '/api/user/list' && req.method === 'POST') {
        const username = req.headers['x-user-name'] as string
        const password = req.headers['x-user-password'] as string

        if (!username || !password) {
          res.writeHead(401)
          res.end('Missing credentials')
          return
        }

        const user = global.lx.config.users.find(u => u.name === username && u.password === password)
        if (!user) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(async body => {
          try {
            const listData = JSON.parse(body)
            const userSpace = getUserSpace(username)
            // Restore ensures consistency with the provided snapshot
            await userSpace.listManage.listDataManage.restore(listData)
            // Create a snapshot after update
            await userSpace.listManage.createSnapshot()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // [新增] Get User Settings (User Auth)
      if (pathname === '/api/user/settings' && req.method === 'GET') {
        const username = req.headers['x-user-name'] as string
        const password = req.headers['x-user-password'] as string
        const isPublic = !username || username === 'default'
        let user = null

        // 如果是公开用户，且启用了限制，允许通过虚拟鉴权
        if (isPublic && global.lx.config['user.enablePublicRestriction']) {
          user = { name: 'default' }
        } else {
          user = global.lx.config.users.find(u => u.name === username && u.password === password)
        }

        if (!user) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const userSpace = getUserSpace(isPublic ? '_open' : username)
        const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)

        if (fs.existsSync(settingsPath)) {
          const settingsData = fs.readFileSync(settingsPath, 'utf8')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(settingsData)
        } else {
          // Return empty object instead of 404 to avoid console error on fresh installs
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
        }
        return
      }

      // [新增] Update User Settings (User Auth)
      if (pathname === '/api/user/settings' && req.method === 'POST') {
        const username = req.headers['x-user-name'] as string
        const password = req.headers['x-user-password'] as string
        const isPublic = !username || username === 'default'

        // 如果是公开用户，且启用了限制，检查管理员密码
        if (isPublic && global.lx.config['user.enablePublicRestriction']) {
          const auth = req.headers['x-frontend-auth']
          if (auth !== global.lx.config['frontend.password']) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: '权限不足：公共用户保存设置受限，请先验证管理员身份。' }))
            return
          }
        }

        const user = isPublic ? { name: 'default' } : global.lx.config.users.find(u => u.name === username && u.password === password)
        if (!user) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(body => {
          try {
            const userSpace = getUserSpace(isPublic ? '_open' : username)
            const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)

            let settings = JSON.parse(body)

            // [核心逻辑] 如果是受限的公开用户，仅允许保存特定的 3 项设置
            if (isPublic && global.lx.config['user.enablePublicRestriction']) {
              const restrictedSettings: any = {}
              const allowedKeys = ['enableServerCache', 'enableServerLyricCache', 'serverCacheLocation']
              allowedKeys.forEach(key => {
                if (settings[key] !== undefined) restrictedSettings[key] = settings[key]
              })
              settings = restrictedSettings
            }

            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400)
            res.end('Invalid JSON data')
          }
        })
        return
      }

      // [新增] Get User Sound Effects (User Auth)
      if (pathname === '/api/user/sound-effects' && req.method === 'GET') {
        const username = req.headers['x-user-name'] as string
        const password = req.headers['x-user-password'] as string

        const user = global.lx.config.users.find(u => u.name === username && u.password === password)
        if (!user) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const userSpace = getUserSpace(username)
        const soundEffectsPath = path.join(userSpace.dataManage.userDir, File.userSoundEffectsJSON)

        if (fs.existsSync(soundEffectsPath)) {
          const soundEffectsData = fs.readFileSync(soundEffectsPath, 'utf8')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(soundEffectsData)
        } else {
          // Return empty object instead of 404 to avoid console error on fresh installs
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
        }
        return
      }

      // [新增] Update User Sound Effects (User Auth)
      if (pathname === '/api/user/sound-effects' && req.method === 'POST') {
        const username = req.headers['x-user-name'] as string
        const password = req.headers['x-user-password'] as string

        const user = global.lx.config.users.find(u => u.name === username && u.password === password)
        if (!user) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        void readBody(req).then(body => {
          try {
            const userSpace = getUserSpace(username)
            const soundEffectsPath = path.join(userSpace.dataManage.userDir, File.userSoundEffectsJSON)

            // Validate JSON
            JSON.parse(body)

            fs.writeFileSync(soundEffectsPath, body, 'utf8')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400)
            res.end('Invalid JSON data')
          }
        })
        return
      }

      // [新增] File Cache APIs
      // 1. Config Cache Location
      if (pathname === '/api/music/cache/config' && req.method === 'POST') {
        const username = (req.headers['x-user-name'] as string) || ''
        const isPublic = !username || username === 'default'

        void readBody(req).then(body => {
          try {
            const { location } = JSON.parse(body)
            if (location) {
              // [优化] 如果请求的位置与当前一致，直接返回成功，不触发权限拦截
              if (location === fileCache.getCacheLocation()) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true }))
                return
              }

              // [新增] 权限检查
              if (isPublic && global.lx.config['user.enablePublicRestriction']) {
                const auth = req.headers['x-frontend-auth']
                if (auth !== global.lx.config['frontend.password']) {
                  res.writeHead(403, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ success: false, error: '权限不足：公共用户修改缓存位置受限，请输入管理员密码。' }))
                  return
                }
              }

              fileCache.setCacheLocation(location)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(400)
              res.end('Missing location')
            }
          } catch (e) {
            res.writeHead(500)
            res.end('Error')
          }
        })
        return
      }

      // 2. Check Cache
      if (pathname === '/api/music/cache/check' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name')
        const singer = urlObj.searchParams.get('singer')
        const source = urlObj.searchParams.get('source')
        const songmid = urlObj.searchParams.get('songmid')
        const songId = urlObj.searchParams.get('songId')
        const quality = urlObj.searchParams.get('quality')
        const exactQuality = urlObj.searchParams.get('exactQuality') === '1' || urlObj.searchParams.get('exactQuality') === 'true'

        if (!name || !singer || !source || (!songmid && !songId)) {
          res.writeHead(400)
          res.end('Missing params')
          return
        }

        const username = req.headers['x-user-name'] as string
        const result = fileCache.checkCache({ name, singer, source, songmid, songId, quality, exactQuality }, username)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      // 3. Trigger Download
      if (pathname === '/api/music/cache/download' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { songInfo, url, quality } = JSON.parse(body)
            if (!songInfo || !url) {
              res.writeHead(400)
              res.end('Missing params')
              return
            }

            // Fire and forget (background download) with Abort support
            const username = (req.headers['x-user-name'] as string) || ''
            const songKey = String(songInfo.id || songInfo.songmid)


            const controller = new AbortController()
            let userTasks = fileCache.activeTasks.get(username)
            if (!userTasks) {
              userTasks = []
              fileCache.activeTasks.set(username, userTasks)
            }
            userTasks.push({ songKey, controller })

            void fileCache.downloadAndCache(songInfo, url, quality, username, controller.signal)
              .finally(() => {
                // Cleanup active task
                const tasks = fileCache.activeTasks.get(username)
                if (tasks) {
                  const idx = tasks.findIndex(t => t.songKey === songKey)
                  if (idx !== -1) {
                    tasks.splice(idx, 1)
                  }
                }
              })

            res.writeHead(200)
            res.end(JSON.stringify({ success: true, message: 'Download started' }))
          } catch (e) {
            res.writeHead(500)
            res.end('Error')
          }
        })
        return
      }

      // [New] Stop Cache Task
      if (pathname === '/api/music/cache/stop' && req.method === 'POST') {
        const username = (req.headers['x-user-name'] as string) || ''
        void readBody(req).then(body => {
          try {
            const { songKey, all } = JSON.parse(body)
            if (all) {
              fileCache.stopUserTasks(username)
            } else if (songKey) {
              fileCache.stopUserTasks(username, songKey)
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // 4. Serve Cached File
      if (pathname.startsWith('/api/music/cache/file/')) {
        const parts = pathname.replace('/api/music/cache/file/', '').split('/')
        const username = parts.length > 1 ? decodeURIComponent(parts[0]) : '_open'
        const filename = parts.length > 1 ? parts[1] : parts[0]

        if (filename) {
          fileCache.serveCacheFile(req, res, decodeURIComponent(filename), username)
          return
        }
      }

      // 5. Get Cache Statistics
      if (pathname === '/api/music/cache/stats' && req.method === 'GET') {
        const username = req.headers['x-user-name'] as string
        try {
          const stats = fileCache.getCacheStats(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: stats }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to get cache stats' }))
        }
        return
      }

      if (pathname === '/api/music/cache/clear' && req.method === 'POST') {
        const username = req.headers['x-user-name'] as string
        try {
          const result = fileCache.clearAllCache(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to clear cache' }))
        }
        return
      }

      if (pathname === '/api/music/cache/lyric/clear' && req.method === 'POST') {
        const username = req.headers['x-user-name'] as string
        try {
          const result = fileCache.clearLyricCache(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to clear lyric cache' }))
        }
        return
      }

      // 7. Get Cache Progress
      if (pathname === '/api/music/cache/progress' && req.method === 'GET') {
        const ids = urlObj.searchParams.get('ids')?.split(',') || []
        const progress: any = {}
        ids.forEach(id => {
          if (fileCache.cacheProgress.has(id)) {
            progress[id] = fileCache.cacheProgress.get(id)
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: progress }))
        return
      }

      // 7. Get Detailed Cache List
      if (pathname === '/api/music/cache/list' && req.method === 'GET') {
        const username = req.headers['x-user-name'] as string
        void fileCache.getCacheList(username).then(list => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: list }))
        }).catch(err => {
          res.writeHead(500)
          res.end(err.message)
        })
        return
      }

      // 8. Get Cache Cover
      if (pathname === '/api/music/cache/cover' && req.method === 'GET') {
        const username = (req.headers['x-user-name'] as string) || urlObj.searchParams.get('user') || ''
        const filename = urlObj.searchParams.get('filename')
        if (!filename) {
          res.writeHead(400)
          res.end('Missing filename')
          return
        }
        const cover = fileCache.getCacheCover(filename, username) as any
        if (cover && cover.data) {
          res.writeHead(200, {
            'Content-Type': cover.mime || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400'
          })
          res.end(cover.data)
        } else {
          // Fallback to logo or 404
          res.writeHead(404)
          res.end('Not Found')
        }
        return
      }

      // 9. Remove Cache File (Single or Batch)
      if (pathname === '/api/music/cache/remove' && req.method === 'POST') {
        const username = req.headers['x-user-name'] as string
        void readBody(req).then(body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames) throw new Error('Missing filenames')

            const fileList = Array.isArray(filenames) ? filenames : [filenames]
            let deletedCount = 0
            for (const f of fileList) {
              if (fileCache.removeCacheFile(f, username)) deletedCount++
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, deletedCount }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }


      // [New] Fetch Lyrics
      if (pathname === '/api/music/lyric' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source')
        // [Optimization] Accept multiple ID param names for better client compatibility
        let songmid = urlObj.searchParams.get('songmid') || urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')

        if (!source || !songmid) {
          res.writeHead(400)
          res.end('Missing source or songmid')
          return
        }

        // [Fix] Normalize ID by stripping source prefix if present (e.g., "tx_001..." -> "001...")
        const sourcePrefix = `${source}_`
        if (songmid.startsWith(sourcePrefix)) {
          songmid = songmid.slice(sourcePrefix.length)
        }

        try {
          if (!musicSdk[source]) {
            throw new Error('Source not supported')
          }


          // Construct complete songInfo object for SDK compatibility
          // KuGou (kg) needs: name, hash, interval
          // MiGu (mg) needs: copyrightId, lrcUrl, mrcUrl, trcUrl (优先，避免调用getMusicInfo API)
          const songInfo = {
            songmid,
            name: urlObj.searchParams.get('name') || '',
            singer: urlObj.searchParams.get('singer') || '',
            hash: urlObj.searchParams.get('hash') || '',
            interval: urlObj.searchParams.get('interval') || '',
            copyrightId: urlObj.searchParams.get('copyrightId') || '',
            albumId: urlObj.searchParams.get('albumId') || '',
            lrcUrl: urlObj.searchParams.get('lrcUrl') || '',
            mrcUrl: urlObj.searchParams.get('mrcUrl') || '',
            trcUrl: urlObj.searchParams.get('trcUrl') || ''
          }

          const requestObj = musicSdk[source].getLyric(songInfo)
          const lyricInfo = await requestObj.promise

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=86400' // Cache lyrics for 1 day
          })
          res.end(JSON.stringify(lyricInfo))
        } catch (err: any) {

          // Avoid circular structure error - only send message
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(err.message || 'Failed to fetch lyric')
        }
        return
      }

      // [新增] File Cache Lyric APIs
      if (pathname === '/api/music/cache/lyric' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source')
        const songmid = urlObj.searchParams.get('songmid') || urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')
        const songId = urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')
        const username = req.headers['x-user-name'] as string

        if (!source || (!songmid && !songId)) {
          res.writeHead(400)
          res.end('Missing source or songmid')
          return
        }

        const result = fileCache.checkLyricCache({ source, songmid, id: songId }, username)
        if (result.exists) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result.content }))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Not found in cache' }))
        }
        return
      }

      if (pathname === '/api/music/cache/lyric' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { songInfo, lyricsObj } = JSON.parse(body)
            const username = req.headers['x-user-name'] as string

            if (!songInfo || !lyricsObj) {
              res.writeHead(400)
              res.end('Missing parameters')
              return
            }

            const success = fileCache.saveLyricCache(songInfo, lyricsObj, username)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success }))
          } catch (e: any) {
            res.writeHead(500)
            res.end('Server internal error')
          }
        })
        return
      }

      // [新增] Download Proxy API
      if (pathname === '/api/music/download' && req.method === 'GET') {
        const urlStr = urlObj.searchParams.get('url')
        const filename = urlObj.searchParams.get('filename') || 'download.mp3'
        const isInline = urlObj.searchParams.get('inline') === '1'

        if (!urlStr) {
          res.writeHead(400)
          res.end('Missing url param')
          return
        }

        try {
          const isTaggingMode = urlObj.searchParams.get('tag') === '1'
          const taskId = urlObj.searchParams.get('taskId')

          // 使用原生 http/https 模块以获得最高的流媒体转发性能
          const http = require('http')
          const https = require('https')

          // Manual redirect handling for maximum control and stability
          const doFetch = (targetUrl: string, attempt: number) => {
            if (attempt > 5) {
              if (!res.headersSent) {
                res.writeHead(502)
                res.end('Too Many Redirects')
              }
              return
            }

            try {
              const parsedUrl = new URL(targetUrl)
              const options: any = {
                method: 'GET',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Referer': parsedUrl.origin
                }
              }

              // 转发 Range 请求头，以支持播放器的快进和拖拽
              if (req.headers['range']) {
                options.headers['Range'] = req.headers['range']
              }

              const lib = parsedUrl.protocol === 'https:' ? https : http

              const proxyReq = lib.request(targetUrl, options, (proxyRes: any) => {
                // 处理重定向
                if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
                  const location = proxyRes.headers.location
                  if (location) {
                    const nextUrl = location.startsWith('http') ? location : new URL(location, targetUrl).href
                    doFetch(nextUrl, attempt + 1)
                    return
                  }
                }

                // 处理最终响应
                let contentType = proxyRes.headers['content-type'] || 'application/octet-stream'
                if (contentType.includes('audio/') || contentType.includes('video/')) {
                  contentType = contentType.split(';')[0].trim()
                }

                const headers: Record<string, string | string[] | undefined> = {
                  'Content-Type': contentType,
                  'Access-Control-Allow-Origin': '*',
                }

                if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length']
                if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges']
                if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range']

                if (!isInline) {
                  headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`
                }

                // [Unified metadata] Tagging support for browser download
                // NOTE: Local fetch from browser often sends Range: bytes=0- for full download
                const rangeHeader = req.headers['range']
                const isFullRange = rangeHeader === 'bytes=0-'

                if (isTaggingMode && (!rangeHeader || isFullRange)) {
                  const songName = urlObj.searchParams.get('name') || ''
                  const artist = urlObj.searchParams.get('singer') || ''
                  const album = urlObj.searchParams.get('album') || ''
                  const imageUrl = urlObj.searchParams.get('pic') || ''

                  const chunks: any[] = []
                  let received = 0
                  const total = parseInt(proxyRes.headers['content-length'] as string || '0', 10)

                  if (taskId) {
                    fileCache.cacheProgress.set(taskId, { progress: 0, status: 'downloading', total, received: 0 })
                  }

                  proxyRes.on('data', (c: any) => {
                    chunks.push(c)
                    if (taskId) {
                      received += c.length
                      const progress = total > 0 ? Math.round((received / total) * 100) : 0
                      fileCache.cacheProgress.set(taskId, { progress, status: 'downloading', total, received })
                    }
                  })
                  proxyRes.on('end', async () => {
                    if (taskId) {
                      fileCache.cacheProgress.set(taskId, { progress: 100, status: 'tagging', total, received: total })
                    }
                    try {
                      const buffer = Buffer.concat(chunks)
                      if (buffer.length < 100) throw new Error('File too small, possibly invalid');

                      // Use filename extension for temp file so MusicTagger can identify container format
                      const ext = path.extname(filename) || '.mp3'
                      const tempPath = path.join(os.tmpdir(), `lx_tag_${Date.now()}${ext}`)
                      fs.writeFileSync(tempPath, new Uint8Array(buffer))

                      const tagger = new MusicTagger()
                      tagger.loadPath(tempPath)
                      if (songName) tagger.title = songName
                      if (artist) tagger.artist = artist
                      if (album) tagger.album = album

                      if (imageUrl) {
                        try {
                          let imgBuf: Buffer | null = null;
                          if (imageUrl.startsWith('http')) {
                            const imgResp = await (global as any).fetch(imageUrl)
                            if (imgResp.ok) imgBuf = Buffer.from(await imgResp.arrayBuffer())
                          } else if (imageUrl.startsWith('/api')) {
                            // 内部 API 请求，使用请求头中的 host
                            const hostLabel = req.headers.host || '127.0.0.1:2026'
                            const internalUrl = `http://${hostLabel}${imageUrl}`
                            const imgResp = await (global as any).fetch(internalUrl)
                            if (imgResp.ok) imgBuf = Buffer.from(await imgResp.arrayBuffer())
                          }

                          if (imgBuf && imgBuf.length > 0) {
                            try {
                              // music-tag-native signature: (mime, data, type)
                              tagger.pictures = [new MetaPicture('image/jpeg', new Uint8Array(imgBuf), 'Cover')]
                            } catch (picErr) {
                            }
                          }
                        } catch (e: any) {
                        }
                      }
                      tagger.save()
                      tagger.dispose()

                      if (taskId) {
                        fileCache.cacheProgress.set(taskId, { progress: 100, status: 'finished', total, received: total })
                        setTimeout(() => fileCache.cacheProgress.delete(taskId), 30000)
                      }

                      const tagged = fs.readFileSync(tempPath)
                      fs.unlink(tempPath, () => { })
                      headers['Content-Length'] = tagged.length.toString()
                      if (!res.headersSent) {
                        res.writeHead(200, headers)
                        res.end(tagged)
                      }
                    } catch (e: any) {
                      if (!res.headersSent) {
                        res.writeHead(200, headers)
                        res.end(Buffer.concat(chunks))
                      }
                    }
                  })
                  return
                }

                if (!res.headersSent) {
                  res.writeHead(proxyRes.statusCode || 200, headers)
                  proxyRes.pipe(res)
                }
              })

              proxyReq.on('error', (err: any) => {
                if (!res.headersSent) {
                  res.writeHead(502)
                  res.end('Request Error')
                }
              })

              // 如果客户端（浏览器）中止了请求（例如：用户拖拽进度条、切换歌曲等），应该立刻销毁上游的下载请求，防止持续占用服务器下行带宽
              req.on('close', () => {
                if (!proxyReq.destroyed) {
                  proxyReq.destroy()
                }
              })

              proxyReq.end()

            } catch (err: any) {
              if (!res.headersSent) {
                res.writeHead(500)
                res.end('Internal Server Error')
              }
            }
          }

          // Start the fetch process
          doFetch(urlStr, 0)

        } catch (err: any) {
          res.writeHead(500)
          res.end('Server Error')
        }
        return
      }

      
      // 删除歌曲
            // 重命名歌单
      
      // 批量删除歌曲
      
      // [新增] Web播放器公共配置 API (无需鉴权)
      if (pathname === '/api/music/config' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        })
        res.end(JSON.stringify({
          'player.enableAuth': global.lx.config['player.enableAuth'] || false,
          'user.enablePublicRestriction': global.lx.config['user.enablePublicRestriction'] || false
        }))
        return
      }

      // [新增] Web播放器认证 API（颁发 HttpOnly Cookie Session）
      if (pathname === '/api/music/auth' && req.method === 'POST') {
        void readBody(req).then(body => {
          try {
            const { password } = JSON.parse(body)
            const correctPassword = global.lx.config['player.password'] || ''

            if (password === correctPassword) {
              const sessionId = generateSessionId()
              playerSessions.set(sessionId, { createdAt: Date.now() })
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`
              })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false }))
            }
          } catch (err: any) {
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        })
        return
      }

      // [新增] Web播放器登出 API（清除 Session Cookie）
      if (pathname === '/api/music/auth/logout' && req.method === 'POST') {
        const cookies = parseCookies(req.headers['cookie'])
        const sessionId = cookies[SESSION_COOKIE_NAME]
        if (sessionId) playerSessions.delete(sessionId)
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
        })
        res.end(JSON.stringify({ success: true }))
        return
      }

      // [新增] Web播放器认证状态检查 API
      if (pathname === '/api/music/auth/verify' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ valid: checkPlayerAuth(req) }))
        return
      }

      // [新增] 音乐搜索 API
      if (pathname === '/api/music/search' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name') || ''
        const singer = urlObj.searchParams.get('singer') || ''
        const source = urlObj.searchParams.get('source') || 'kw'
        const limit = parseInt(urlObj.searchParams.get('limit') || '20')
        const page = parseInt(urlObj.searchParams.get('page') || '1')

        if (!name) {
          res.writeHead(400); res.end('Missing name'); return
        }

        try {
          if (!musicSdk[source]) {
            throw new Error(`Source ${source} is not supported`)
          }
          const searchData = await musicSdk[source].musicSearch.search(name, page, limit)
          const list = searchData.list || []

          fs.appendFileSync(path.join(process.cwd(), 'debug.txt'), `[Search] Source: ${source}, Query: ${name}, Result Count: ${list.length}\n`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(list))
        } catch (err: any) {
          fs.appendFileSync(path.join(process.cwd(), 'debug.txt'), `[Search Error] ${err.message}\n${err.stack}\n`)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message, code: 500 }))
        }
        return
      }

      // [新增] 搜索提示 (TipSearch) API
      if (pathname === '/api/music/tipSearch' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name') || ''
        const source = urlObj.searchParams.get('source') || 'kw'
        if (!name) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].tipSearch) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
          }
          const tips = await musicSdk[source].tipSearch.search(name)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(tips || []))
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('[]')
        }
        return
      }

      // [新增] 音乐解析进度 SSE 端点 (无需登录, 用 requestId 区分)
      if (pathname === '/api/music/progress' && req.method === 'GET') {
        const reqId = urlObj.searchParams.get('reqId')
        if (!reqId) {
          res.writeHead(400)
          res.end('Missing reqId')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })
        res.write('retry: 3000\n\n')
        musicProgressClients.set(reqId, res)
        req.on('close', () => {
          musicProgressClients.delete(reqId)
        })
        return
      }

      // [新增] 音乐 URL API
      if (pathname === '/api/music/url' && req.method === 'POST') {
        const clientUsername = req.headers['x-user-name'] as string | undefined
        const clientId = req.headers['x-client-id'] as string | undefined
        const reqId = req.headers['x-req-id'] as string | undefined

        void readBody(req).then(async body => {
          // 辅助：通过 SSE 推送进度（内置竞态重试，最多等 600ms 让 SSE 连接就绪）
          const pushProgress = async (attempt: any, retries = 3): Promise<void> => {
            if (reqId && musicProgressClients.has(reqId)) {
              musicProgressClients.get(reqId)!.write(`data: ${JSON.stringify(attempt)}\n\n`)
              return
            }
            if (retries > 0) {
              await new Promise(r => setTimeout(r, 200))
              await pushProgress(attempt, retries - 1)
            } else if (reqId) {
            }
          }

          try {
            let { songInfo, quality } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            // console.log('[MusicUrl] Song Info:', JSON.stringify(songInfo, null, 2))
            if (!songInfo || !songInfo.source) {
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source
            let result

            let customSourceError: string | null = null
            let attempts: any[] = []
            if (isSourceSupported(source, clientUsername)) {
              try {

                const userApiResult = await callUserApiGetMusicUrl(
                  source, songInfo, quality || '128k', clientUsername,
                  (attempt) => pushProgress(attempt)
                )
                result = userApiResult
                attempts = userApiResult.attempts || []
              } catch (userApiError: any) {
                customSourceError = userApiError.message
                attempts = userApiError.attempts || []
                // 不抛出错误，继续尝试内置源
              }
            } else {
              // isSourceSupported = false: 无任何自定义源支持此平台，立即通知前端
              await pushProgress({ name: '系统', status: 'fail', message: `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源` })
            }

            // 自定义源失败则直接报错（内置 SDK 无独立解析能力，回退无意义）
            if (!result) {
              const errMsg = customSourceError || `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`
              const err: any = new Error(errMsg)
              err.attempts = attempts
              throw err
            }

            // 合并解析尝试记录到响应（前端可用于诊断）
            if (attempts.length > 0) result.attempts = attempts

            // [Fix] Server-side Mixed Content handling & Redirect Resolution
            // If the upstream URL is HTTP, rewrite it to use our secure proxy OR resolve it if it's a redirect
            if (result && result.url) {
              // 1. Resolve Redirects (301, 302, 307, etc.) to get direct link
              try {
                // Only try to resolve if it looks like a remote URL and is not already resolved
                if (result.url.startsWith('http')) {
                  const needle = require('needle')
                  const checkRedirect = async (u: string, depth: number = 0): Promise<string> => {
                    if (depth > 3) return u // Max depth 3
                    try {
                      const resp = await needle('head', u, null, {
                        follow_max: 0,
                        response_timeout: 4000, // Increase timeout slightly
                        read_timeout: 4000,
                        headers: {
                          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                          'Referer': new URL(u).origin
                        }
                      })
                      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
                        let nextUrl = resp.headers.location
                        if (!nextUrl.startsWith('http')) {
                          try { nextUrl = new URL(nextUrl, u).href } catch (e) { }
                        }
                        return checkRedirect(nextUrl, depth + 1)
                      }
                      // If error status but not redirect, return original
                      if (resp.statusCode >= 400) {
                        return u;
                      }
                    } catch (e: any) {
                    }
                    return u
                  }

                  const finalUrl = await checkRedirect(result.url)
                  if (finalUrl !== result.url) {
                    result.url = finalUrl
                  }
                }
              } catch (e) {
              }

              // 2. Mixed Content Handling (Optional Proxy) implementation details handled by frontend now
              // But we can keep the log for debugging
              if (result.url.startsWith('http://')) {
                // console.log(`[MusicUrl] Note: URL is HTTP, frontend might proxy if enabled: ${result.url}`)
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            // [Fix] Return 500 but with specific error JSON to let frontend show detailed toast
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message, code: 500, attempts: err.attempts }))
          }
        })
        return
      }

      // [新增] 歌词 API
      if (pathname === '/api/music/lyric' && req.method === 'POST') {
        void readBody(req).then(async body => {
          try {
            let { songInfo } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            if (!songInfo || !songInfo.source) {
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source
            if (!musicSdk[source] || !musicSdk[source].getLyric) {
              throw new Error(`Source ${source} not supported`)
            }
            const result = await musicSdk[source].getLyric(songInfo)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // [新增] 热搜 API
      if (pathname === '/api/music/hotSearch' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'mg'

        try {
          // 检查是否支持热搜
          if (!musicSdk[source] || !musicSdk[source].hotSearch) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: '该音源不支持热搜功能' }))
            return
          }

          const result = await musicSdk[source].hotSearch.getList()

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300' // 5分钟缓存
          })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          // Return empty array instead of 500 to keep UI stable
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify([]))
        }
        return
      }

      // [新增] 歌单分类标签 API
      if (pathname === '/api/music/songList/tags' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getTags()
          const sortList = musicSdk[source].songList.sortList
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...result, sortList }))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单标签失败' }))
        }
        return
      }
      // [新增] 歌单列表 API
      if (pathname === '/api/music/songList/list' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const tagId = urlObj.searchParams.get('tagId') || ''
        const sortId = urlObj.searchParams.get('sortId') || 'hot'
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getList(sortId, tagId, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单列表失败' }))
        }
        return
      }
      // [新增] 歌单详情 API
      if (pathname === '/api/music/songList/detail' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const id = urlObj.searchParams.get('id')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!id) {
          res.writeHead(400)
          res.end('Missing id')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getListDetail(id, page)
          if (result && result.list) {
            result.list = result.list.map(normalizeSongInfo)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单详情失败' }))
        }
        return
      }
      // [新增] 歌单搜索 API
      if (pathname === '/api/music/songList/search' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const text = urlObj.searchParams.get('text')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!text) {
          res.writeHead(400)
          res.end('Missing text')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.search(text, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '搜索歌单失败' }))
        }
        return
      }

      // [新增] 排行榜 - 获取榜单列表 API
      if (pathname === '/api/music/leaderboard/boards' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'kg'
        try {
          if (!musicSdk[source] || !musicSdk[source].leaderboard) {
            throw new Error(`Source ${source} does not support leaderboard`)
          }
          const result = await musicSdk[source].leaderboard.getBoards()
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=600'
          })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取排行榜列表失败' }))
        }
        return
      }

      // [新增] 排行榜 - 获取榜单内歌曲 API
      if (pathname === '/api/music/leaderboard/list' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'kg'
        const bangid = urlObj.searchParams.get('bangid')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!bangid) {
          res.writeHead(400); res.end('Missing bangid'); return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].leaderboard) {
            throw new Error(`Source ${source} does not support leaderboard`)
          }
          const result = await musicSdk[source].leaderboard.getList(bangid, page)
          if (result && result.list) {
            result.list = result.list.map(normalizeSongInfo)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取排行榜歌曲失败' }))
        }
        return
      }

      // [新增] 评论 API
      if (pathname === '/api/music/comment' && req.method === 'POST') {
        void readBody(req).then(async body => {
          try {
            let { songInfo, type, page, limit } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            if (!songInfo || !songInfo.source) {
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source

            if (!musicSdk[source] || !musicSdk[source].comment) {
              throw new Error(`Source ${source} not supported for comments`)
            }

            const method = type === 'hot' ? 'getHotComment' : 'getComment'

            if (!musicSdk[source].comment[method]) {
              throw new Error(`Method ${method} not supported for source ${source}`)
            }

            const result = await musicSdk[source].comment[method](songInfo, page, limit)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message, code: 500 }))
          }
        })
        return
      }

      // [新增] 封面 API (备用)

      // [新增] 自定义源管理 API
      // 注：此处不再进行全局强制鉴权，鉴权逻辑已下放到 customSourceHandlers 中，
      // 以便根据请求体中的 username 字段判断是否需要校验管理员密码。

      if (pathname === '/api/custom-source/validate' && req.method === 'POST') {
        return customSourceHandlers.handleValidate(req, res)
      }
      if (pathname === '/api/custom-source/import' && req.method === 'POST') {
        return customSourceHandlers.handleImport(req, res)
      }
      if (pathname === '/api/custom-source/upload' && req.method === 'POST') {
        return customSourceHandlers.handleUpload(req, res)
      }
      if (pathname === '/api/custom-source/list' && req.method === 'GET') {
        const username = urlObj.searchParams.get('username') || 'default'
        return customSourceHandlers.handleList(req, res, username)
      }
      if (pathname === '/api/custom-source/toggle' && req.method === 'POST') {
        return customSourceHandlers.handleToggle(req, res)
      }
      if (pathname === '/api/custom-source/delete' && req.method === 'POST') {
        return customSourceHandlers.handleDelete(req, res)
      }

      if (pathname === '/api/custom-source/reorder' && req.method === 'POST') {
        return customSourceHandlers.handleReorder(req, res)
      }

      // elFinder 文件管理器连接器
      

      // Configuration API
      
      // Logs API
      
      // Stats API
      
      // WebDAV Test Connection API
      
      // WebDAV Sync File API
      
      // WebDAV Backup API
            // WebDAV Sync All Files API
      
      // WebDAV Restore API
      
      // WebDAV Logs API
            // WebDAV Progress SSE API
            // Restart Server API
            // File Management - List Files
      
      // File Management - Download File
      
      // File Management - Create/Update File
      
      // File Management - Delete File
      
    }

    const endUrl = `/${req.url?.split('/').at(-1) ?? ''}`
    let code
    let msg
    switch (endUrl) {
      case '/hello':
        // 新增：如果禁用了根路径，且当前访问的是根路径 (例如 /hello 而不是 /user/hello)，则拒绝
        if (!global.lx.config['user.enableRoot']) {
          const parts = pathname.split('/').filter(p => p)
          // parts.length <= 1 说明没有用户名部分，只有 'hello'
          if (parts.length <= 1) {
            code = 403
            msg = 'Root access disabled'
            break
          }
        }
        code = 200
        msg = SYNC_CODE.helloMsg
        break
      case '/id':
        // 新增：同上，对 /id 接口也进行同样的检查
        if (!global.lx.config['user.enableRoot']) {
          const parts = pathname.split('/').filter(p => p)
          if (parts.length <= 1) {
            code = 403
            msg = 'Root access disabled'
            break
          }
        }

        code = 200
        msg = SYNC_CODE.idPrefix + getServerId()
        break
      case '/ah':
        let targetUserName

        // 1. 尝试匹配用户路径 /<userName>/ah
        if (global.lx.config['user.enablePath']) {
          const parts = pathname.split('/').filter(p => p)
          // parts 应该是 ['username', 'ah']
          if (parts.length > 1 && parts[parts.length - 1] === 'ah') {
            targetUserName = decodeURIComponent(parts[parts.length - 2])
          }
        }

        // 2. 如果没有匹配到用户名（说明是访问的根路径 /ah，或者 URL 格式不对）
        if (!targetUserName) {
          // 如果未开启根路径模式，则拒绝访问
          if (!global.lx.config['user.enableRoot']) {
            res.writeHead(403)
            res.end('Access denied: Root path access is disabled. Please use /<username>/ah')
            return
          }
          // 如果开启了根路径，targetUserName 保持 undefined，authCode 会遍历尝试所有用户
        }

        // 将 targetUserName 传递给 authCode
        void authCode(req, res, global.lx.config.users, targetUserName)
        break
      default:
        // Root: redirect to music player
        if (pathname === '/') {
          res.writeHead(302, { 'Location': '/music' })
          res.end()
          return
        }

        // Serve static files
        let filePath = path.join(process.cwd(), 'public', pathname)
        // Prevent directory traversal
        if (!filePath.startsWith(path.join(process.cwd(), 'public'))) {
          code = 403
          msg = 'Forbidden'
          break
        }

        // Check if file exists, if not fall back to 404 handled by serveStatic or check original logic
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          serveStatic(req, res, filePath)
          return
        }

        code = 404
        msg = 'Not Found'
        break
    }
    if (!code) return
    res.writeHead(code)
    res.end(msg)
  })

  wss = new WebSocketServer({
    noServer: true,
  })

  // WebDAV Sync Progress Broadcast
  if (global.lx.webdavSync) {
    // 移除旧的监听器以防重复添加
    global.lx.webdavSync.removeAllListeners('progress')
    global.lx.webdavSync.on('progress', (data: any) => {
      // Broadcast to WebSocket clients
      if (wss) {
        const msg = JSON.stringify({ type: 'webdav_progress', data })
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg)
          }
        }
      }
      // Broadcast to SSE clients
      const sseMsg = `data: ${JSON.stringify(data)}\\n\\n`
      for (const client of sseClients) {
        client.write(sseMsg)
      }
    })
  }

  wss.on('connection', function (socket, request) {
    socket.isReady = false
    socket.moduleReadys = {
      list: false,
      dislike: false,
    }
    socket.feature = {
      list: false,
      dislike: false,
    }
    socket.on('pong', () => {
      socket.isAlive = true
    })

    // const events = new Map<keyof ActionsType, Array<(err: Error | null, data: LX.Sync.ActionSyncType[keyof LX.Sync.ActionSyncType]) => void>>()
    // const events = new Map<keyof LX.Sync.ActionSyncType, Array<(err: Error | null, data: LX.Sync.ActionSyncType[keyof LX.Sync.ActionSyncType]) => void>>()
    // let events: Partial<{ [K in keyof LX.Sync.ActionSyncType]: Array<(data: LX.Sync.ActionSyncType[K]) => void> }> = {}
    let closeEvents: Array<(err: Error) => (void | Promise<void>)> = []
    let disconnected = false
    const msg2call = createMsg2call<LX.Sync.ClientSyncActions>({
      funcsObj: callObj,
      timeout: 120 * 1000,
      sendMessage(data) {
        if (disconnected) throw new Error('disconnected')
        void encryptMsg(socket.keyInfo, JSON.stringify(data)).then((data) => {
          // console.log('sendData', eventName)
          socket.send(data)
        }).catch(err => {
          socket.close(SYNC_CLOSE_CODE.failed)
        })
      },
      onCallBeforeParams(rawArgs) {
        return [socket, ...rawArgs]
      },
      onError(error, path, groupName) {
        const name = groupName ?? ''
        const userName = socket.userInfo?.name ?? ''
        const deviceName = socket.keyInfo?.deviceName ?? ''
        // if (groupName == null) return
        // // TODO
        // socket.close(SYNC_CLOSE_CODE.failed)
      },
    })
    socket.remote = msg2call.remote
    socket.remoteQueueList = msg2call.createQueueRemote('list')
    socket.remoteQueueDislike = msg2call.createQueueRemote('dislike')
    socket.addEventListener('message', ({ data }) => {
      if (typeof data != 'string') return
      void decryptMsg(socket.keyInfo, data).then((data) => {
        let syncData: any
        try {
          syncData = JSON.parse(data)
        } catch (err) {
          socket.close(SYNC_CLOSE_CODE.failed)
          return
        }
        msg2call.message(syncData)
      }).catch(err => {
        socket.close(SYNC_CLOSE_CODE.failed)
      })
    })
    socket.addEventListener('close', () => {
      const err = new Error('closed')
      try {
        for (const handler of closeEvents) void handler(err)
      } catch (err: any) {
      }
      closeEvents = []
      disconnected = true
      msg2call.destroy()
      if (socket.isReady) {
        // events = {}
        if (!status.devices.map(d => getUserName(d.clientId)).filter(n => n == socket.userInfo.name).length) handleUnconnection(socket.userInfo.name)
      } else {
        const queryData = new URL(request.url as string, host).searchParams
      }
    })
    socket.onClose = function (handler: typeof closeEvents[number]) {
      closeEvents.push(handler)
      return () => {
        closeEvents.splice(closeEvents.indexOf(handler), 1)
      }
    }
    socket.broadcast = function (handler) {
      if (!wss) return
      for (const client of wss.clients) handler(client)
    }

    void handleConnection(socket, request)
  })

  httpServer.on('upgrade', function upgrade(request, socket, head) {
    socket.addListener('error', onSocketError)

    // 调用全局定义的 authConnection (在文件顶部约113行已经定义过)
    authConnection(request, (err, success) => {
      // 如果报错或者 success 为 false，则拒绝连接
      if (err || !success) {
        // console.log('Auth failed', err)
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      socket.removeListener('error', onSocketError)

      // 鉴权通过，升级协议
      wss?.handleUpgrade(request, socket, head, function done(ws) {
        wss?.emit('connection', ws, request)
      })
    })
  })

  const interval = setInterval(() => {
    wss?.clients.forEach(socket => {
      if (socket.isAlive == false) {
        socket.terminate()
        return
      }

      socket.isAlive = false
      socket.ping(noop)
      if (socket.keyInfo.isMobile) socket.send('ping', noop)
    })
  }, 30000)

  wss.on('close', function close() {
    clearInterval(interval)
  })

  httpServer.on('error', error => {
    reject(error)
  })

  httpServer.on('listening', () => {
    const addr = httpServer.address()
    // console.log(addr)
    if (!addr) {
      reject(new Error('address is null'))
      return
    }
    const bind = typeof addr == 'string' ? `pipe ${addr}` : `port ${addr.port}`
    resolve(null)
    void registerLocalSyncEvent(wss as LX.SocketServer)
  })

  host = `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}`
  httpServer.listen(port, ip)
})

// const handleStopServer = async() => new Promise<void>((resolve, reject) => {
//   if (!wss) return
//   for (const client of wss.clients) client.close(SYNC_CLOSE_CODE.normal)
//   unregisterLocalSyncEvent()
//   wss.close()
//   wss = null
//   httpServer.close((err) => {
//     if (err) {
//       reject(err)
//       return
//     }
//     resolve()
//   })
// })

// export const stopServer = async() => {
//   codeTools.stop()
//   if (!status.status) {
//     status.status = false
//     status.message = ''
//     status.address = []
//     status.code = ''
//   //     return
//   }
//   console.log('stoping sync server...')
//   await handleStopServer().then(() => {
//     console.log('sync server stoped')
//     status.status = false
//     status.message = ''
//     status.address = []
//     status.code = ''
//   }).catch(err => {
//     console.log(err)
//     status.message = err.message
//   }).finally(() => {
// //   })
// }

export const startServer = async (port: number, ip: string) => {
  // if (status.status) await handleStopServer()

  try {
    await musicSdk.init()
  } catch (err) {
  }

  // 初始化自定义源
  try {
    // 修改：不传参数，默认加载 open + 所有用户源
    await initUserApis()
  } catch (err: any) {
  }

  await handleStartServer(port, ip).then(() => {
    // console.log('sync server started')
    status.status = true
    status.message = ''
    status.address = ip == '0.0.0.0' ? getAddress() : [ip]

    // void generateCode()
    // codeTools.start()
  }).catch(err => {
    status.status = false
    status.message = err.message
    status.address = []
    // status.code = ''
  })
  // .finally(() => {
  //   sendStatus(status)
  // })
}

export const getStatus = (): LX.Sync.Status => status

// export const generateCode = async() => {
//   status.code = handleGenerateCode()
//   sendStatus(status)
//   return status.code
// }

export const getDevices = async (userName: string) => {
  const userSpace = getUserSpace(userName)
  return userSpace.getDecices()
}

export const removeDevice = async (userName: string, clientId: string) => {
  if (wss) {
    for (const client of wss.clients) {
      if (client.userInfo?.name == userName && client.keyInfo?.clientId == clientId) client.close(SYNC_CLOSE_CODE.normal)
    }
  }
  const userSpace = getUserSpace(userName)
  await userSpace.removeDevice(clientId)
}