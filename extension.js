/**
 * Gravi Agent — エントリポイント
 * 
 * Antigravity の自動承認・タスクキュー管理エージェント
 */
const vscode = require('vscode');
const { CDPHandler } = require('./src/core/cdp-handler');
const { Scheduler } = require('./src/features/scheduler');
const { Relauncher } = require('./src/core/relauncher');

// ─── 状態 ──────────────────────────────────────────────
let enabled = false;
let statusBarItem;
let cdpHandler;
let scheduler;
let relaunchAttempted = false;
let pollTimer = null;
let extensionContext = null; // activate() で設定

// ─── ログ ──────────────────────────────────────────────
const outputChannel = vscode.window.createOutputChannel('Gravi Agent');

function log(msg) {
    const ts = new Date().toLocaleTimeString('ja-JP');
    outputChannel.appendLine(`[${ts}] ${msg}`);
}

// ─── CDP設定構築 ────────────────────────────────────────
function buildCDPConfig() {
    const config = vscode.workspace.getConfiguration('gravi-agent');
    return {
        pollInterval: config.get('pollInterval', 1000),
        bannedPatterns: config.get('safety.bannedPatterns', []),
    };
}

// ─── メインループ ──────────────────────────────────────
function startPolling() {
    if (pollTimer) return;
    const config = vscode.workspace.getConfiguration('gravi-agent');
    const interval = config.get('pollInterval', 1000);

    cdpHandler.start(buildCDPConfig());

    pollTimer = setInterval(() => {
        if (!enabled) return;
        cdpHandler.poll(buildCDPConfig());
    }, interval);

    log('ポーリング開始');
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (cdpHandler) {
        cdpHandler.stop();
    }
    log('ポーリング停止');
}

// ─── ON/OFF切り替え ────────────────────────────────────
async function toggle() {
    enabled = !enabled;

    // 状態を永続化
    if (extensionContext) {
        extensionContext.workspaceState.update('gravi-agent.enabled', enabled);
    }

    if (enabled) {
        // CDP接続を確認
        const available = await cdpHandler.isCDPAvailable();
        if (!available) {
            // Relaunch を提案
            if (!relaunchAttempted) {
                relaunchAttempted = true;
                const relauncher = new Relauncher(log);
                await relauncher.ensureCDPAndRelaunch();
                enabled = false;
                if (extensionContext) {
                    extensionContext.workspaceState.update('gravi-agent.enabled', false);
                }
                updateStatusBar();
                return;
            }
            vscode.window.showWarningMessage(
                'CDP ポートに接続できません。Antigravity を --remote-debugging-port=9004 付きで起動してください。'
            );
            enabled = false;
            if (extensionContext) {
                extensionContext.workspaceState.update('gravi-agent.enabled', false);
            }
            updateStatusBar();
            return;
        }
        startPolling();
    } else {
        stopPolling();
    }

    updateStatusBar();
    log(`Gravi Agent: ${enabled ? 'ON' : 'OFF'}`);
}

// ─── ステータスバー ────────────────────────────────────
function updateStatusBar() {
    if (!statusBarItem) return;
    if (enabled) {
        statusBarItem.text = '$(zap) Gravi: ON';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'Gravi Agent は動作中です（クリックで停止）';
    } else {
        statusBarItem.text = '$(circle-slash) Gravi: OFF';
        statusBarItem.tooltip = 'Gravi Agent は停止中です（クリックで開始）';
    }
}

// ─── Activate ──────────────────────────────────────────
function activate(context) {
    log('Gravi Agent を起動中...');
    extensionContext = context;

    const config = vscode.workspace.getConfiguration('gravi-agent');
    const cdpPort = config.get('cdpPort', 9004);

    // CDP Handler 初期化
    cdpHandler = new CDPHandler(log, cdpPort);

    // Scheduler 初期化
    scheduler = new Scheduler(context, cdpHandler, log);

    // ステータスバー
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBarItem.command = 'gravi-agent.toggle';
    updateStatusBar();
    statusBarItem.show();

    // コマンド登録
    context.subscriptions.push(
        vscode.commands.registerCommand('gravi-agent.toggle', toggle),

        vscode.commands.registerCommand('gravi-agent.sendPrompt', async () => {
            const text = await vscode.window.showInputBox({
                prompt: 'エージェントに送信するプロンプトを入力',
                placeHolder: 'プロンプトを入力...'
            });
            if (text) {
                const result = await cdpHandler.sendPrompt(text);
                if (result.success) {
                    vscode.window.showInformationMessage('プロンプトを送信しました');
                } else {
                    vscode.window.showErrorMessage(`送信失敗: ${result.error}`);
                }
            }
        }),

        vscode.commands.registerCommand('gravi-agent.startQueue', () => {
            scheduler.startQueue();
        }),

        vscode.commands.registerCommand('gravi-agent.stopQueue', () => {
            scheduler.stopQueue();
        }),

        vscode.commands.registerCommand('gravi-agent.openSettings', () => {
            vscode.commands.executeCommand(
                'workbench.action.openSettings', 'gravi-agent'
            );
        }),

        statusBarItem
    );

    // 設定変更の監視
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gravi-agent')) {
                log('設定が変更されました');
                if (enabled) {
                    stopPolling();
                    startPolling();
                }
                scheduler.loadConfig();
            }
        })
    );

    // 自動起動チェック
    (async () => {
        // 保存された状態を復元（未設定なら autoStart 設定に従う）
        const savedState = context.workspaceState.get('gravi-agent.enabled');
        const autoStart = config.get('autoStart', true);
        const shouldStart = savedState !== undefined ? savedState : autoStart;

        const available = await cdpHandler.isCDPAvailable();
        if (available && shouldStart) {
            log('CDP ポートが利用可能です。ON にします。');
            enabled = true;
            startPolling();
            updateStatusBar();
        } else if (available) {
            log('CDP ポートは利用可能ですが、ユーザー設定により OFF を維持します。');
        } else {
            log('CDP ポートが利用できません。手動で ON にしてください。');
            if (!relaunchAttempted && shouldStart) {
                relaunchAttempted = true;
                const relauncher = new Relauncher(log, cdpPort);
                await relauncher.ensureCDPAndRelaunch();
            }
        }
    })();

    log('Gravi Agent 起動完了');
}

// ─── Deactivate ────────────────────────────────────────
function deactivate() {
    stopPolling();
    if (scheduler) scheduler.stop();
    log('Gravi Agent を停止しました');
}

module.exports = { activate, deactivate };
