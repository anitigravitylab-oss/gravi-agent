/**
 * Scheduler — キュー管理 & スケジューラ
 * 
 * Queue モード: プロンプトを順次実行（silence検出で次へ進む）
 * Interval モード: 一定間隔でプロンプト送信
 */
const vscode = require('vscode');

class Scheduler {
    constructor(context, cdpHandler, logger = console.log) {
        this.context = context;
        this.cdpHandler = cdpHandler;
        this.log = logger;

        // キュー状態
        this.isRunning = false;
        this.isPaused = false;
        this.queueIndex = 0;
        this.runtimeQueue = [];       // 実行時のプロンプトリスト
        this.lastActivityTime = null;
        this.currentItemSentAt = null;

        // タイマー
        this.checkTimer = null;
        this.intervalTimer = null;

        // 設定
        this.config = {};
        this.loadConfig();
    }

    // ─── 設定読み込み ──────────────────────────────────
    loadConfig() {
        const cfg = vscode.workspace.getConfiguration('gravi-agent');
        this.config = {
            enabled: cfg.get('schedule.enabled', false),
            mode: cfg.get('schedule.mode', 'queue'),
            prompts: cfg.get('schedule.prompts', []),
            silenceTimeout: cfg.get('schedule.silenceTimeout', 30),
            intervalMinutes: cfg.get('schedule.intervalMinutes', 30),
            intervalPrompt: cfg.get('schedule.intervalPrompt', ''),
        };
        this.log(`[Scheduler] 設定読み込み: mode=${this.config.mode}, prompts=${this.config.prompts.length}件`);
    }

    // ─── キュー開始 ─────────────────────────────────────
    startQueue(prompts) {
        // 引数があればそれを使う、なければ設定から
        const items = prompts || this.config.prompts;

        if (!items || items.length === 0) {
            this.log('[Scheduler] キューが空です');
            vscode.window.showWarningMessage('Gravi Agent: キューにプロンプトがありません');
            return;
        }

        this.runtimeQueue = [...items];
        this.queueIndex = 0;
        this.isRunning = true;
        this.isPaused = false;

        this.log(`[Scheduler] キュー開始: ${this.runtimeQueue.length} 件`);

        // 最初のタスクを実行
        this._executeCurrentItem();

        // チェックタイマー開始（5秒ごとにsilence検出）
        this._startCheckTimer();
    }

    // ─── キュー停止 ─────────────────────────────────────
    stopQueue() {
        this.isRunning = false;
        this.isPaused = false;
        this._stopCheckTimer();
        this.log('[Scheduler] キュー停止');
    }

    // ─── 一時停止 / 再開 ────────────────────────────────
    pauseQueue() {
        if (!this.isRunning) return;
        this.isPaused = true;
        this.log('[Scheduler] 一時停止');
    }

    resumeQueue() {
        if (!this.isRunning || !this.isPaused) return;
        this.isPaused = false;
        this.log('[Scheduler] 再開');
        // 現在のタスクを再実行
        this._executeCurrentItem();
    }

    // ─── スキップ ──────────────────────────────────────
    skipPrompt() {
        if (!this.isRunning) return;
        this.log(`[Scheduler] スキップ: [${this.queueIndex + 1}/${this.runtimeQueue.length}]`);
        this._advanceQueue();
    }

    // ─── 現在のタスクを実行 ──────────────────────────────
    async _executeCurrentItem(retryCount = 0) {
        const MAX_RETRIES = 3;

        if (!this.isRunning || this.isPaused) return;
        if (this.queueIndex >= this.runtimeQueue.length) {
            this._onQueueComplete();
            return;
        }

        const prompt = this.runtimeQueue[this.queueIndex];
        this.log(`[Scheduler] 実行 [${this.queueIndex + 1}/${this.runtimeQueue.length}]: "${prompt.substring(0, 60)}..."`);

        this.currentItemSentAt = Date.now();
        this.lastActivityTime = Date.now();

        const result = await this.cdpHandler.sendPrompt(prompt);
        if (!result.success) {
            this.log(`[Scheduler] 送信失敗 (${retryCount + 1}/${MAX_RETRIES}): ${result.error}`);
            if (retryCount < MAX_RETRIES - 1) {
                // リトライ（上限あり）
                setTimeout(() => this._executeCurrentItem(retryCount + 1), 3000);
            } else {
                this.log(`[Scheduler] ⚠ リトライ上限到達 → スキップ`);
                this._advanceQueue();
            }
        }
    }

    // ─── キュー進行 ─────────────────────────────────────
    _advanceQueue() {
        this.queueIndex++;
        if (this.queueIndex >= this.runtimeQueue.length) {
            this._onQueueComplete();
        } else {
            this._executeCurrentItem();
        }
    }

    // ─── キュー完了 ─────────────────────────────────────
    _onQueueComplete() {
        this.isRunning = false;
        this._stopCheckTimer();
        this.log('[Scheduler] ✅ 全タスク完了');
        vscode.window.showInformationMessage(
            `Gravi Agent: ${this.runtimeQueue.length} 件のタスクが完了しました`
        );
    }

    // ─── Silence 検出 ──────────────────────────────────
    _startCheckTimer() {
        this._stopCheckTimer();
        this.checkTimer = setInterval(() => this._checkSilence(), 5000);
    }

    _stopCheckTimer() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
    }

    async _checkSilence() {
        if (!this.isRunning || this.isPaused) return;
        if (!this.currentItemSentAt) return;

        // 最低10秒は待つ
        const elapsed = (Date.now() - this.currentItemSentAt) / 1000;
        if (elapsed < 10) return;

        // CDP から統計を取得して最終アクティビティ時間を更新
        const stats = this.cdpHandler.getStats();
        // クリック時刻とDOM変化時刻の両方を考慮
        const latestActivity = Math.max(
            stats.lastActivity || 0,
            stats.lastDomChange || 0
        );
        if (latestActivity && latestActivity > this.lastActivityTime) {
            this.lastActivityTime = latestActivity;
        }

        // silence 検出
        const silenceSec = (Date.now() - this.lastActivityTime) / 1000;
        if (silenceSec >= this.config.silenceTimeout) {
            this.log(`[Scheduler] silence ${Math.round(silenceSec)}s 検出 → 次のタスクへ`);
            this._advanceQueue();
        }
    }

    // ─── Interval モード ────────────────────────────────
    startInterval() {
        this.stopInterval();
        const ms = this.config.intervalMinutes * 60 * 1000;
        const prompt = this.config.intervalPrompt;

        if (!prompt) {
            this.log('[Scheduler] Interval プロンプトが未設定');
            return;
        }

        this.log(`[Scheduler] Interval 開始: ${this.config.intervalMinutes}分ごと`);
        this.intervalTimer = setInterval(async () => {
            this.log(`[Scheduler] Interval 送信: "${prompt.substring(0, 60)}..."`);
            await this.cdpHandler.sendPrompt(prompt);
        }, ms);
    }

    stopInterval() {
        if (this.intervalTimer) {
            clearInterval(this.intervalTimer);
            this.intervalTimer = null;
            this.log('[Scheduler] Interval 停止');
        }
    }

    // ─── 全停止 ─────────────────────────────────────────
    stop() {
        this.stopQueue();
        this.stopInterval();
    }

    // ─── ステータス取得 ──────────────────────────────────
    getStatus() {
        return {
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            mode: this.config.mode,
            queueIndex: this.queueIndex,
            queueLength: this.runtimeQueue.length,
            prompts: this.runtimeQueue,
            currentPrompt: this.runtimeQueue[this.queueIndex] || null,
        };
    }
}

module.exports = { Scheduler };
