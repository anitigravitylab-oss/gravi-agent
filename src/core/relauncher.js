/**
 * Relauncher — IDE 再起動 & ショートカット修正
 * 
 * CDPフラグ付きで Antigravity を再起動する。
 */
const vscode = require('vscode');
const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

class Relauncher {
    constructor(logger = console.log, port = 9004) {
        this.logger = logger;
        this.port = port;
        this.cdpFlag = `--remote-debugging-port=${port}`;
    }

    log(msg) {
        this.logger(`[Relauncher] ${msg}`);
    }

    getIdeName() {
        const appName = vscode.env.appName || '';
        if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
        return 'Code';
    }

    /** CDP フラグ付きで起動されているか確認 */
    hasFlag() {
        return process.argv.join(' ').includes(this.cdpFlag);
    }

    /** メインエントリ: CDPフラグを確認し、なければ再起動を提案 */
    async ensureCDPAndRelaunch() {
        if (this.hasFlag()) {
            this.log('CDP フラグ確認済み');
            return { relaunched: false };
        }

        this.log('CDP フラグなし。ショートカット修正を試行...');
        await this._modifyShortcut();

        const choice = await vscode.window.showInformationMessage(
            'Gravi Agent: CDP ポートを有効にするため再起動が必要です。',
            '再起動する', '後で'
        );

        if (choice === '再起動する') {
            await this._relaunch();
            return { relaunched: true };
        }
        return { relaunched: false };
    }

    /**
     * 文字列を安全にエスケープ（シェルインジェクション防止）
     * ダブルクォート・アンパサンド・パイプ等を除去
     */
    _sanitizePath(p) {
        // 英数字、スペース、ドライブレター、スラッシュ、バックスラッシュ、
        // ドット、ハイフン、アンダースコア、日本語文字のみを許可
        return p.replace(/[^a-zA-Z0-9\s\u3000-\u9FFF\uF900-\uFAFF:\\\/.\-_]/g, '');
    }

    /** Windows ショートカットにフラグを追加 */
    async _modifyShortcut() {
        if (os.platform() !== 'win32') return;

        // ideName をサニタイズ（PowerShellインジェクション防止）
        const ideName = this._sanitizePath(this.getIdeName());
        const port = parseInt(this.port, 10); // 数値であることを保証

        if (isNaN(port) || port < 1024 || port > 65535) {
            this.log('無効なポート番号');
            return;
        }

        const script = `
$ErrorActionPreference = "SilentlyContinue"
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")
$StartMenuPath = [System.IO.Path]::Combine($env:APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")

$Shortcuts = Get-ChildItem "$DesktopPath\\*.lnk", "$StartMenuPath\\*.lnk" -Recurse | Where-Object { $_.Name -like "*${ideName}*" }

foreach ($file in $Shortcuts) {
    try {
        $shortcut = $WshShell.CreateShortcut($file.FullName)
        if ($shortcut.Arguments -notlike "*--remote-debugging-port=${port}*") {
            $shortcut.Arguments = "--remote-debugging-port=${port} " + $shortcut.Arguments
            $shortcut.Save()
        }
    } catch {}
}`;
        try {
            const tmpFile = path.join(os.tmpdir(), `gravi_relaunch_${Date.now()}.ps1`);
            fs.writeFileSync(tmpFile, script, 'utf8');
            execSync(`powershell -ExecutionPolicy Bypass -File "${tmpFile}"`, { encoding: 'utf8' });
            fs.unlinkSync(tmpFile);
        } catch (e) {
            this.log(`ショートカット修正失敗: ${e.message}`);
        }
    }

    /** IDE を再起動（コマンドインジェクション対策済み） */
    async _relaunch() {
        const exePath = process.execPath;
        const args = [this.cdpFlag];

        // ワークスペースフォルダをサニタイズして追加
        const folders = vscode.workspace.workspaceFolders || [];
        for (const f of folders) {
            const sanitized = this._sanitizePath(f.uri.fsPath);
            if (sanitized) args.push(sanitized);
        }

        if (os.platform() === 'win32') {
            // シェル経由ではなく直接 spawn で起動（インジェクション防止）
            // 2秒後に起動するために timeout を別プロセスで実行
            const batContent = `@echo off\ntimeout /t 2 /nobreak >nul\n"${this._sanitizePath(exePath)}" ${args.join(' ')}\n`;
            const batFile = path.join(os.tmpdir(), `gravi_relaunch_${Date.now()}.bat`);
            fs.writeFileSync(batFile, batContent, 'utf8');
            spawn('cmd.exe', ['/c', batFile], { detached: true, stdio: 'ignore' }).unref();
            // 一時ファイルは起動後に残るが、tmpdir なので問題ない
        } else {
            // Unix: 配列引数で直接 spawn
            setTimeout(() => {
                spawn(exePath, args, { detached: true, stdio: 'ignore' }).unref();
            }, 2000);
        }

        setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 500);
    }
}

module.exports = { Relauncher };
