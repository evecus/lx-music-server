import fs from 'fs'
import path from 'path'
import archiver from 'archiver'
import { Extract } from 'unzipper'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

interface WebDAVConfig {
    url: string
    username: string
    password: string
    interval?: number
}

class WebDAVSync extends EventEmitter {
    private config: WebDAVConfig
    private dataPath: string
    private syncInterval: number
    private watchInterval: number = 60000 // 1分钟检查一次文件变化
    private backupInterval: number = 24 * 60 * 60 * 1000 // 24小时
    private watchTimer: NodeJS.Timeout | null = null
    private backupTimer: NodeJS.Timeout | null = null
    private filesHash: Map<string, string> = new Map()
    private client: any = null

    constructor(config: WebDAVConfig, dataPath: string) {
        super()
        this.config = {
            url: config.url || '',
            username: config.username || '',
            password: config.password || '',
        }
        this.syncInterval = (config.interval || 60) * 60 * 1000
        this.dataPath = dataPath
    }

    async initClient(): Promise<boolean> {
        if (!this.isConfigured()) return false

        try {
            // 动态导入 webdav ESM 模块
            const { createClient } = await import('webdav')
            this.client = createClient(this.config.url, {
                username: this.config.username,
                password: this.config.password,
            })
            return true
        } catch (err: any) {
            return false
        }
    }

    isConfigured(): boolean {
        return !!(this.config.url && this.config.username && this.config.password)
    }

    private getFileHash(filePath: string): string {
        try {
            const buffer = fs.readFileSync(filePath)
            const hash = crypto.createHash('md5')
            hash.update(buffer as any)
            return hash.digest('hex')
        } catch {
            return ''
        }
    }

    private async scanFiles(): Promise<Map<string, string>> {
        const files = new Map<string, string>()
        const scanDir = (dir: string) => {
            const items = fs.readdirSync(dir)
            for (const item of items) {
                const fullPath = path.join(dir, item)
                const stat = fs.statSync(fullPath)
                if (stat.isDirectory()) {
                    scanDir(fullPath)
                } else {
                    const relativePath = path.relative(this.dataPath, fullPath)
                    if (!relativePath.includes('temp-') && !relativePath.endsWith('.log')) {
                        files.set(relativePath, this.getFileHash(fullPath))
                    }
                }
            }
        }
        scanDir(this.dataPath)

        // [新增] 扫描根目录下的 config.js
        const rootConfigPath = path.join(process.cwd(), 'config.js')
        if (fs.existsSync(rootConfigPath)) {
            files.set('config.js', this.getFileHash(rootConfigPath))
        }

        return files
    }

    private async getChangedFiles(): Promise<{ changed: string[], deleted: string[] }> {
        const currentFiles = await this.scanFiles()
        const changed: string[] = []
        const deleted: string[] = []

        // 检查新增和修改的文件
        for (const [file, hash] of currentFiles) {
            if (!this.filesHash.has(file) || this.filesHash.get(file) !== hash) {
                changed.push(file)
            }
        }

        // 检查已删除的文件
        for (const [file] of this.filesHash) {
            if (!currentFiles.has(file)) {
                deleted.push(file)
            }
        }

        this.filesHash = currentFiles
        return { changed, deleted }
    }

    async deleteRemoteFile(relativePath: string): Promise<boolean> {
        if (!this.client) await this.initClient()
        if (!this.client) return false

        try {
            const remotePath = `/lx-sync/${relativePath.replace(/\\/g, '/')}`
            await this.client.deleteFile(remotePath)
            return true
        } catch (err: any) {
            // 如果远程文件已经不存在，也认为成功
            if (err.status === 404) return true
            return false
        }
    }

    async uploadFile(relativePath: string): Promise<boolean> {
        if (!this.client) await this.initClient()
        if (!this.client) return false
        try {
            const isRootConfig = relativePath === 'config.js';
            const localPath = isRootConfig ? path.join(process.cwd(), 'config.js') : path.join(this.dataPath, relativePath);
            if (!fs.existsSync(localPath)) return false;
            const stat = fs.statSync(localPath);
            const remotePath = `/lx-sync/${relativePath.replace(/\\/g, '/')}`;
            // 确保远程目录存在
            const remoteDir = path.dirname(remotePath);
            await this.client.createDirectory(remoteDir, { recursive: true });
            // 使用流式上传并监控进度
            const readStream = fs.createReadStream(localPath);
            const passThrough = new PassThrough();
            let uploadedBytes = 0;
            passThrough.on('data', (chunk) => {
                uploadedBytes += chunk.length;
                this.emit('progress', {
                    type: 'file',
                    status: 'uploading',
                    file: relativePath,
                    current: uploadedBytes,
                    total: stat.size
                });
            });
            readStream.pipe(passThrough);
            await this.client.putFileContents(remotePath, passThrough);
            this.emit('progress', {
                type: 'file',
                status: 'success',
                file: relativePath,
                current: stat.size,
                total: stat.size
            });
            return true;
        }
        catch (err: any) {
            this.emit('progress', {
                type: 'file',
                status: 'error',
                file: relativePath,
                error: err.message
            });
            return false;
        }
    }

    async downloadFile(relativePath: string): Promise<boolean> {
        if (!this.client) await this.initClient();
        if (!this.client) return false;
        try {
            const remotePath = `/lx-sync/${relativePath.replace(/\\/g, '/')}`;
            const isRootConfig = relativePath === 'config.js';
            const localPath = isRootConfig ? path.join(process.cwd(), 'config.js') : path.join(this.dataPath, relativePath);
            // 确保本地目录存在
            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }
            const content = await this.client.getFileContents(remotePath);
            // 对比内容哈希，如果一致则跳过写入，避免触发文件系统监控
            if (fs.existsSync(localPath)) {
                const localContent = fs.readFileSync(localPath);
                const localHash = crypto.createHash('md5').update(localContent).digest('hex');
                const remoteHash = crypto.createHash('md5').update(content).digest('hex');
                if (localHash === remoteHash) {
                    return true;
                }
            }
            fs.writeFileSync(localPath, content);
            return true;
        }
        catch (err: any) {
            return false;
        }
    }

    async createBackup(): Promise<string | null> {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const zipName = `lx-sync-backup-${timestamp}.zip`;
            const zipPath = path.join(this.dataPath, zipName);
            await new Promise<void>((resolve, reject) => {
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });
                let fileCount = 0;
                // 监听文件添加事件
                archive.on('entry', (entry: any) => {
                    fileCount++;
                    this.emit('progress', {
                        type: 'backup',
                        status: 'packing',
                        message: `正在打包文件: ${entry.name}`,
                        current: fileCount
                    });
                });
                output.on('close', () => resolve());
                archive.on('error', (err: any) => reject(err));
                archive.pipe(output);
                archive.glob('**/*', {
                    cwd: this.dataPath,
                    ignore: ['temp-*.zip', '*.log', 'lx-sync-backup-*.zip'],
                });
                // [新增] 将根目录下的 config.js 也打包进去
                const rootConfigPath = path.join(process.cwd(), 'config.js');
                if (fs.existsSync(rootConfigPath)) {
                    archive.file(rootConfigPath, { name: 'config.js' });
                }
                archive.finalize();
            });
            return zipName;
        }
        catch (err: any) {
            return null;
        }
    }

    async uploadBackup(force = false): Promise<boolean> {
        if (!this.client) await this.initClient();
        if (!this.client) return false;
        try {
            // 检查是否有文件变化
            if (!force) {
                const { changed, deleted } = await this.getChangedFiles();
                if (changed.length === 0 && deleted.length === 0) {
                    return true;
                }
            }
            this.emit('progress', { type: 'backup', status: 'preparing', message: '正在创建备份...' });
            const zipName = await this.createBackup();
            if (!zipName) return false;
            const zipPath = path.join(this.dataPath, zipName);
            const stat = fs.statSync(zipPath);
            const remotePath = `/lx-sync-backups/${zipName}`;
            // 使用流式上传并监控进度
            const readStream = fs.createReadStream(zipPath);
            const passThrough = new PassThrough();
            let uploadedBytes = 0;
            // 节流控制，避免发送过多 SSE 消息
            let lastProgressTime = 0;
            passThrough.on('data', (chunk) => {
                uploadedBytes += chunk.length;
                const now = Date.now();
                if (now - lastProgressTime > 100 || uploadedBytes === stat.size) { // 至少间隔100ms
                    this.emit('progress', {
                        type: 'backup',
                        status: 'uploading',
                        file: zipName,
                        total: stat.size,
                        current: uploadedBytes
                    });
                    lastProgressTime = now;
                }
            });
            readStream.pipe(passThrough);
            await this.client.putFileContents(remotePath, passThrough);
            this.emit('progress', {
                type: 'backup',
                status: 'success',
                file: zipName,
                total: stat.size,
                current: stat.size
            });
            // 清理本地zip
            try {
                fs.unlinkSync(zipPath);
            }
            catch (e) {
                // ignore
            }
            // 清理旧备份（保留最近5个）
            try {
                await this.cleanOldBackups();
            }
            catch (e) {
                // ignore
            }
            return true;
        }
        catch (err: any) {
            this.emit('progress', { type: 'backup', status: 'error', error: err.message });
            return false;
        }
    }

    async syncAllFiles(): Promise<boolean> {
        if (!this.client) await this.initClient();
        if (!this.client) return false;
        try {
            const files = await this.scanFiles();
            const fileList = Array.from(files.keys());
            let count = 0;
            const total = fileList.length;
            this.emit('progress', { type: 'sync', status: 'start', total });
            for (const file of fileList) {
                count++;
                this.emit('progress', {
                    type: 'sync',
                    status: 'processing',
                    current: count,
                    total,
                    file
                });
                await this.uploadFile(file);
            }
            this.emit('progress', { type: 'sync', status: 'finish', total });
            return true;
        }
        catch (err: any) {
            return false;
        }
    }

    async cleanOldBackups(): Promise<void> {
        if (!this.client) return;
        try {
            const items = await this.client.getDirectoryContents('/lx-sync-backups/');
            const backups = items
                .filter((item: any) => item.basename.startsWith('lx-sync-backup-'))
                .sort((a: any, b: any) => b.lastmod.localeCompare(a.lastmod));
            // 删除第6个及以后的备份
            for (let i = 5; i < backups.length; i++) {
                await this.client.deleteFile(backups[i].filename);
            }
        }
        catch (err: any) {
            // ignore
        }
    }

    async downloadLatestBackup(): Promise<boolean> {
        if (!this.client) await this.initClient();
        if (!this.client) return false;
        try {
            this.emit('progress', { type: 'restore', status: 'start', message: '正在获取备份列表...' });
            const items = await this.client.getDirectoryContents('/lx-sync-backups/');
            const backups = items
                .filter((item: any) => item.basename.startsWith('lx-sync-backup-'))
                .sort((a: any, b: any) => b.lastmod.localeCompare(a.lastmod));
            if (backups.length === 0) return false;
            const latestBackup = backups[0];
            this.emit('progress', {
                type: 'restore',
                status: 'downloading',
                message: `正在下载备份: ${latestBackup.basename}`
            });
            const content = await this.client.getFileContents(latestBackup.filename);
            const zipPath = path.join(this.dataPath, 'temp-restore.zip');
            fs.writeFileSync(zipPath, content);
            this.emit('progress', {
                type: 'restore',
                status: 'extracting',
                message: '正在解压备份文件...'
            });
            await this.extractZip(zipPath, this.dataPath);
            fs.unlinkSync(zipPath);
            return true;
        }
        catch (err: any) {
            return false;
        }
    }

    async extractZip(zipPath: string, targetPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(Extract({ path: targetPath }))
                .on('close', () => resolve())
                .on('error', (err: any) => reject(err));
        });
    }

    async syncChangedFiles(): Promise<void> {
        const { changed, deleted } = await this.getChangedFiles();
        if (changed.length === 0 && deleted.length === 0) return;
        if (changed.length > 0) {
            for (const file of changed) {
                await this.uploadFile(file);
            }
        }
        if (deleted.length > 0) {
            for (const file of deleted) {
                await this.deleteRemoteFile(file);
            }
        }
    }

    async restoreFromRemote(): Promise<boolean> {
        if (!this.client) await this.initClient();
        if (!this.client) return false;
        // 1. 尝试恢复散文件
        try {
            const items = await this.client.getDirectoryContents('/lx-sync/', { deep: true });
            const files = items.filter((item: any) => item.type === 'file');
            if (files.length > 0) {
                const total = files.length;
                let current = 0;
                let hasConfig = false;
                this.emit('progress', { type: 'restore', status: 'start', total, message: '开始从云端恢复数据...' });
                for (const file of files) {
                    current++;
                    const relativePath = file.filename.replace('/lx-sync/', '');
                    if (relativePath === 'config.js') hasConfig = true;
                    this.emit('progress', {
                        type: 'restore',
                        status: 'processing',
                        current,
                        total,
                        file: relativePath,
                        message: `正在恢复文件 (${current}/${total})`
                    });
                    await this.downloadFile(relativePath);
                }
                // 如果恢复的文件中没有 config.js，说明云端配置缺失，将当前内存配置（含环境变量）同步上去
                if (!hasConfig) {
                    if (global.lx && global.lx.saveConfig) {
                        global.lx.saveConfig();
                    }
                    await this.uploadFile('config.js');
                }
                this.emit('progress', { type: 'restore', status: 'finish', total, message: '数据恢复完成' });
                return true;
            }
        }
        catch (err: any) {
            // 忽略 /lx-sync/ 不存在的错误，继续尝试恢复备份
        }
        // 2. 尝试恢复备份
        try {
            this.emit('progress', { type: 'restore', status: 'start', message: '正在从云端下载备份...' });
            const result = await this.downloadLatestBackup();
            if (result) {
                // 检查解压后根目录是否确实有了 config.js
                const rootConfigPath = path.join(process.cwd(), 'config.js');
                if (!fs.existsSync(rootConfigPath)) {
                    if (global.lx && global.lx.saveConfig) {
                        global.lx.saveConfig();
                    }
                    await this.uploadFile('config.js');
                }
                this.emit('progress', { type: 'restore', status: 'finish', message: '备份恢复完成' });
                return true;
            }
            else {
                // 如果未找到散文件也未找到备份，说明是第一次配置或云端为空
                // 主动上传当前的 config.js 到云端进行初始化
                this.emit('progress', { type: 'restore', status: 'processing', message: '云端为空，正在上传本地配置初始化...' });
                // 保存当前内存中的配置（包含环境变量生效后的结果）到磁盘
                if (global.lx && global.lx.saveConfig) {
                    global.lx.saveConfig();
                }
                await this.uploadFile('config.js');
                this.emit('progress', { type: 'restore', status: 'finish', message: '云端配置同步完成' });
                return false;
            }
        }
        catch (err: any) {
            this.emit('progress', { type: 'restore', status: 'error', message: '恢复失败: ' + err.message });
            return false;
        }
    }

    async testConnection(): Promise<{ success: boolean, message: string }> {
        // 检查配置是否完整
        if (!this.isConfigured()) {
            const missing = [];
            if (!this.config.url) missing.push('WebDAV URL');
            if (!this.config.username) missing.push('用户名');
            if (!this.config.password) missing.push('密码');
            return {
                success: false,
                message: `请先在系统配置中填写: ${missing.join('、')}`
            };
        }
        try {
            const initialized = await this.initClient();
            if (!initialized || !this.client) {
                return { success: false, message: 'WebDAV客户端初始化失败，请检查配置是否正确' };
            }
            await this.client.getDirectoryContents('/');
            return { success: true, message: '连接成功！WebDAV配置正确' };
        }
        catch (err: any) {
            let errorMsg = '连接失败';
            if (err.message) {
                if (err.message.includes('401')) {
                    errorMsg = '认证失败，请检查用户名和密码';
                }
                else if (err.message.includes('404')) {
                    errorMsg = 'WebDAV路径不存在，请检查URL';
                }
                else if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
                    errorMsg = '无法连接到服务器，请检查URL和网络';
                }
                else {
                    errorMsg = err.message;
                }
            }
            return { success: false, message: errorMsg };
        }
    }

    startAutoSync(): void {
        if (!this.isConfigured()) return

        // 初始化文件哈希
        void this.scanFiles().then(files => {
            this.filesHash = files
        })

        // 每分钟检查文件变化
        this.watchTimer = setInterval(() => {
            void this.syncChangedFiles()
        }, this.watchInterval)

        // 每24小时创建备份（如果有变化）
        this.backupTimer = setInterval(() => {
            void this.uploadBackup()
        }, this.backupInterval)
    }

    stopAutoSync(): void {
        if (this.watchTimer) {
            clearInterval(this.watchTimer)
            this.watchTimer = null
        }
        if (this.backupTimer) {
            clearInterval(this.backupTimer)
            this.backupTimer = null
        }
    }

    updateConfig(config: Partial<WebDAVConfig>): void {
        if (config.url) this.config.url = config.url;
        if (config.username) this.config.username = config.username;
        if (config.password) this.config.password = config.password;
        if (config.interval) this.syncInterval = config.interval * 60 * 1000;
        if (this.isConfigured()) {
            this.client = null;
            this.stopAutoSync();
            void this.initClient().then(() => {
                this.startAutoSync();
            });
        }
    }
}

export default WebDAVSync
