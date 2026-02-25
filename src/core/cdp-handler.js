/**
 * CDP Handler — Chrome DevTools Protocol 接続管理
 * 
 * port 9004 に接続し、ブラウザペイロードを注入・管理する。
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// browser-payload をバンドル対応で読み込み（esbuildでインライン化される）
const BROWSER_PAYLOAD = require('./browser-payload-string');

// 診断ログ
const DIAG_LOG = path.join(os.tmpdir(), 'gravi-diag.log');
function diag(msg) {
    const ts = new Date().toISOString();
    try { fs.appendFileSync(DIAG_LOG, `[${ts}] ${msg}\n`); } catch (e) { }
}
diag(`=== CDPHandler module loaded, __dirname=${__dirname}`);
diag(`BROWSER_PAYLOAD length=${BROWSER_PAYLOAD.length}`);

class CDPHandler {
    constructor(logger = console.log, port = 9004) {
        this.logger = logger;
        this.port = port;
        this.connections = new Map(); // id -> { ws, injected }
        this.isEnabled = false;
        this.msgId = 1;
        this.stats = { totalClicks: 0, blockedCommands: 0, lastActivity: null };
    }

    log(msg) {
        this.logger(`[CDP] ${msg}`);
    }

    // ─── CDP ポート確認 ────────────────────────────────
    async isCDPAvailable() {
        return new Promise((resolve) => {
            const req = http.get(
                `http://127.0.0.1:${this.port}/json/version`,
                { timeout: 3000 },
                (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => resolve(true));
                }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    // ─── ターゲットページ一覧の取得 ────────────────────
    async _getPages() {
        return new Promise((resolve, reject) => {
            const req = http.get(
                `http://127.0.0.1:${this.port}/json/list`,
                { timeout: 5000 },
                (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        try {
                            const pages = JSON.parse(data);
                            // settings panel を除外
                            const filtered = pages.filter(p =>
                                p.webSocketDebuggerUrl &&
                                !(p.title || '').toLowerCase().includes('settings')
                            );
                            resolve(filtered);
                        } catch (e) {
                            reject(e);
                        }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    // ─── WebSocket 接続 ────────────────────────────────
    _connect(id, wsUrl) {
        if (this.connections.has(id)) return;

        try {
            const ws = new WebSocket(wsUrl);
            const conn = { ws, injected: false, ready: false };
            // open前に仮登録して二重接続を防止
            this.connections.set(id, conn);

            ws.on('open', () => {
                this.log(`接続: ${id}`);
                conn.ready = true;
            });
            ws.on('close', () => {
                this.log(`切断: ${id}`);
                this.connections.delete(id);
            });
            ws.on('error', (err) => {
                this.log(`エラー: ${id} - ${err.message}`);
                this.connections.delete(id);
            });
        } catch (e) {
            this.log(`接続失敗: ${id} - ${e.message}`);
            this.connections.delete(id);
        }
    }

    // ─── ペイロード注入 ─────────────────────────────────
    async _inject(id, config) {
        const conn = this.connections.get(id);
        if (!conn || conn.injected) {
            diag(`_inject skip: id=${id} conn=${!!conn} injected=${conn && conn.injected}`);
            return;
        }

        diag(`_inject start: id=${id} wsState=${conn.ws.readyState}`);
        try {
            await this._evaluate(id, BROWSER_PAYLOAD);
            diag(`_inject payload eval OK: id=${id}`);
            // 設定を渡してスタート
            const startCmd = `window.__graviStart(${JSON.stringify(config)})`;
            await this._evaluate(id, startCmd);
            conn.injected = true;
            diag(`_inject complete: id=${id}`);
            this.log(`ペイロード注入完了: ${id}`);
        } catch (e) {
            diag(`_inject ERROR: id=${id} err=${e.message}`);
            this.log(`注入失敗: ${id} - ${e.message}`);
        }
    }

    // ─── JavaScript 実行 ────────────────────────────────
    _evaluate(id, expression, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const conn = this.connections.get(id);
            if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('接続なし'));
            }

            const msgId = this.msgId++;

            function onMessage(data) {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === msgId) {
                        clearTimeout(timer);
                        conn.ws.removeListener('message', onMessage);
                        if (msg.result && msg.result.exceptionDetails) {
                            reject(new Error(msg.result.exceptionDetails.text || '実行エラー'));
                        } else {
                            resolve(msg.result);
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // タイムアウト時もリスナーを確実に除去（リーク防止）
            const timer = setTimeout(() => {
                conn.ws.removeListener('message', onMessage);
                reject(new Error('タイムアウト'));
            }, timeoutMs);

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: msgId,
                method: 'Runtime.evaluate',
                params: {
                    expression,
                    returnByValue: true,
                    awaitPromise: true
                }
            }));
        });
    }

    // ─── 公開 evaluate（全接続に実行） ─────────────────
    async evaluate(expression) {
        for (const [id] of this.connections) {
            try {
                return await this._evaluate(id, expression);
            } catch (e) { /* 次へ */ }
        }
        return null;
    }

    // ─── Start/Poll ────────────────────────────────────
    async start(config) {
        this.isEnabled = true;
        await this._refreshConnections(config);
    }

    async poll(config) {
        if (!this.isEnabled) return;
        // ペイロードが消えていないかチェック（ページ遷移対応）
        await this._checkPayloadAlive();
        await this._refreshConnections(config);
        // 統計を取得
        await this._collectStats();
    }

    // ペイロードが生きているか確認し、消えていたら再注入フラグをリセット
    async _checkPayloadAlive() {
        for (const [id, conn] of this.connections) {
            if (!conn.injected || conn.ws.readyState !== WebSocket.OPEN) continue;
            try {
                const result = await this._evaluate(id, 'typeof window.__graviInjected !== "undefined"', 2000);
                if (result && result.result && result.result.value === false) {
                    this.log(`ペイロード消失検出: ${id} → 再注入予約`);
                    conn.injected = false;
                }
            } catch (e) {
                // 接続エラーは無視
            }
        }
    }

    stop() {
        this.isEnabled = false;
        for (const [id, conn] of this.connections) {
            try {
                // ブラウザ側のクリックループを停止してから切断
                if (conn.ws.readyState === WebSocket.OPEN) {
                    this._evaluate(id, 'window.__graviStop && window.__graviStop()')
                        .catch(() => { });
                }
                conn.ws.close();
            } catch (e) { /* */ }
        }
        this.connections.clear();
    }

    // ─── 接続の更新 ────────────────────────────────────
    async _refreshConnections(config) {
        try {
            const pages = await this._getPages();
            diag(`_refresh: ${pages.length} pages found`);
            for (const page of pages) {
                const id = page.id || page.webSocketDebuggerUrl;
                if (!this.connections.has(id)) {
                    diag(`_refresh: new connection for ${id} (${page.title})`);
                    this._connect(id, page.webSocketDebuggerUrl);
                    // 接続が確立するのを少し待つ
                    await new Promise(r => setTimeout(r, 500));
                }
                // ペイロード注入
                await this._inject(id, config);
            }
        } catch (e) {
            diag(`_refresh ERROR: ${e.message}`);
        }
    }

    // ─── 統計収集 ───────────────────────────────────────
    async _collectStats() {
        try {
            const result = await this.evaluate('window.__graviGetStats && window.__graviGetStats()');
            if (result && result.result && result.result.value) {
                const s = result.result.value;
                this.stats.totalClicks = s.totalClicks || 0;
                this.stats.blockedCommands = s.blockedCommands || 0;
                this.stats.lastActivity = s.lastClickTime || this.stats.lastActivity;
                this.stats.lastDomChange = s.lastDomChange || this.stats.lastDomChange;
            }
        } catch (e) { /* 統計取得失敗は無視 */ }
    }

    // ─── プロンプト送信 ─────────────────────────────────
    async sendPrompt(text) {
        try {
            const escaped = JSON.stringify(text);
            const result = await this.evaluate(
                `window.__graviSendPrompt && window.__graviSendPrompt(${escaped})`
            );
            if (result && result.result && result.result.value) {
                return result.result.value;
            }
            return { success: false, error: 'レスポンスなし' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ─── ゲッター ──────────────────────────────────────
    getStats() {
        return { ...this.stats };
    }

    getConnectionCount() {
        return this.connections.size;
    }
}

module.exports = { CDPHandler };
