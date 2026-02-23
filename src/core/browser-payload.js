/**
 * Browser Payload — ブラウザ注入スクリプト
 * 
 * CDP 経由で Antigravity のWebview に注入される。
 * Auto-Accept クリックループとプロンプト送信を実行する。
 */
(function () {
    "use strict";

    // 二重注入防止
    if (window.__graviInjected) return;
    window.__graviInjected = true;

    // ─── 状態 ──────────────────────────────────────────
    const state = {
        enabled: false,
        timer: null,
        config: {},
        stats: {
            totalClicks: 0,
            blockedCommands: 0,
            lastClickTime: null,
            lastDomChange: null,
            sessionStart: Date.now()
        },
        observer: null
    };

    // ─── ログ ──────────────────────────────────────────
    function log(msg) {
        console.log(`[GraviAgent] ${msg}`);
    }

    // ─── DOM ユーティリティ ─────────────────────────────
    function getDocuments(root) {
        root = root || document;
        const docs = [root];
        try {
            const iframes = root.querySelectorAll('iframe');
            iframes.forEach(iframe => {
                try {
                    if (iframe.contentDocument) {
                        docs.push(iframe.contentDocument);
                        // 再帰的にネストiframeも取得
                        const nested = getDocuments(iframe.contentDocument);
                        docs.push(...nested.slice(1));
                    }
                } catch (e) { /* cross-origin */ }
            });
        } catch (e) { /* */ }
        return docs;
    }

    function queryAll(selector) {
        const results = [];
        for (const doc of getDocuments()) {
            try {
                doc.querySelectorAll(selector).forEach(el => results.push(el));
            } catch (e) { /* */ }
        }
        return results;
    }

    // ─── ボタン判定 ─────────────────────────────────────
    const ACCEPT_PATTERNS = [
        { pattern: 'accept', exact: false },
        { pattern: 'accept all', exact: false },
        { pattern: 'run command', exact: false },
        { pattern: 'run', exact: false },
        { pattern: 'apply', exact: true },
        { pattern: 'execute', exact: true },
        { pattern: 'resume', exact: true },
        { pattern: 'retry', exact: true },
        { pattern: 'try again', exact: false },
        { pattern: 'confirm', exact: false },
        { pattern: 'allow once', exact: true },
    ];

    const REJECT_PATTERNS = [
        'skip', 'reject', 'cancel', 'discard', 'deny',
        'close', 'refine', 'other', 'dismiss'
    ];

    function isAcceptButton(el) {
        if (!el || !el.textContent) return false;

        const text = el.textContent.trim().toLowerCase();
        if (text.length === 0 || text.length > 50) return false;

        // パターンマッチ
        const matched = ACCEPT_PATTERNS.some(p =>
            p.exact ? text === p.pattern : text.includes(p.pattern)
        );
        if (!matched) return false;

        // 除外パターン
        if (REJECT_PATTERNS.some(p => text.includes(p))) return false;

        // 可視性チェック
        if (!isVisible(el) || !isClickable(el)) return false;

        return true;
    }

    function isVisible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) > 0.1 &&
            rect.width > 0 && rect.height > 0;
    }

    function isClickable(el) {
        const style = window.getComputedStyle(el);
        return style.pointerEvents !== 'none' && !el.disabled;
    }

    // ─── 危険コマンド検出 ───────────────────────────────
    function findNearbyCommandText(el) {
        // ボタンの親方向にPRE/CODEブロックを探す
        let node = el;
        for (let i = 0; i < 5 && node; i++) {
            node = node.parentElement;
            if (!node) break;

            // 兄弟要素のPRE/CODEを探す
            const siblings = node.parentElement ? node.parentElement.children : [];
            for (const sibling of siblings) {
                if (sibling === node) continue;
                const pre = sibling.querySelector && sibling.querySelector('pre, code');
                if (pre && pre.textContent) return pre.textContent.trim();
            }
        }
        return '';
    }

    function isCommandBanned(commandText) {
        if (!commandText) return false;
        const patterns = state.config.bannedPatterns || [];
        const lower = commandText.toLowerCase();

        for (const pattern of patterns) {
            // /regex/ 形式をサポート
            if (pattern.startsWith('/') && pattern.endsWith('/')) {
                try {
                    const regex = new RegExp(pattern.slice(1, -1), 'i');
                    if (regex.test(commandText)) return true;
                } catch (e) { /* 無効な正規表現は無視 */ }
            } else {
                if (lower.includes(pattern.toLowerCase())) return true;
            }
        }
        return false;
    }

    // ─── クリック済みトラッキング ─────────────────────────
    const clickedButtons = new WeakSet();

    // ─── クリックロジック（呼ばれた時だけ実行）────────────
    function performClick() {
        const buttons = queryAll('button, [class*="button"], [role="button"]');
        let clicked = 0;

        for (const el of buttons) {
            // 既にクリック済みのボタンはスキップ
            if (clickedButtons.has(el)) continue;
            if (!isAcceptButton(el)) continue;

            // 危険コマンドチェック
            const cmdText = findNearbyCommandText(el);
            if (cmdText && isCommandBanned(cmdText)) {
                log(`⛔ ブロック: ${cmdText.substring(0, 80)}`);
                state.stats.blockedCommands++;
                clickedButtons.add(el); // ブロックしたものも記録
                continue;
            }

            el.click();
            clickedButtons.add(el); // クリック済みとして記録
            clicked++;
            state.stats.totalClicks++;
            state.stats.lastClickTime = Date.now();
            log(`✅ クリック: "${el.textContent.trim().substring(0, 30)}"`);
        }

        return clicked;
    }

    // ─── プロンプト送信 ─────────────────────────────────
    function findChatInput() {
        const docs = getDocuments();

        for (const doc of docs) {
            // Antigravity Agent Panel 内に限定して検索
            const agentPanel = doc.querySelector('#antigravity\\.agentPanel') || doc;
            const editables = agentPanel.querySelectorAll('[contenteditable="true"]');
            for (const el of editables) {
                const cls = (el.className || '').toLowerCase();
                // IME オーバーレイを除外
                if (cls.includes('ime') || cls.includes('overlay')) continue;
                // cursor-text クラスを持つものを優先
                if (cls.includes('cursor-text') || cls.includes('input')) {
                    return el;
                }
            }
            // Agent Panel 内の contenteditable のみフォールバック
            if (agentPanel !== doc && editables.length > 0) {
                return editables[0];
            }
        }
        return null;
    }

    function findSendButton(inputBox) {
        // 入力欄の近くにある送信ボタンを探す
        let node = inputBox;
        for (let i = 0; i < 8 && node; i++) {
            node = node.parentElement;
            if (!node) break;

            const buttons = node.querySelectorAll('button, [role="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const cls = (btn.className || '').toLowerCase();

                if (text.includes('send') || text.includes('submit') ||
                    aria.includes('send') || aria.includes('submit') ||
                    cls.includes('send') || cls.includes('submit')) {
                    if (isVisible(btn) && isClickable(btn)) return btn;
                }
            }

            // SVG アイコンボタン（送信矢印）
            const svgButtons = node.querySelectorAll('button:has(svg), [role="button"]:has(svg)');
            for (const btn of svgButtons) {
                if (isVisible(btn) && isClickable(btn) &&
                    !btn.textContent.trim()) {
                    return btn;
                }
            }
        }
        return null;
    }

    // ─── 公開 API ──────────────────────────────────────

    window.__graviStart = function (config) {
        state.config = config || {};
        state.enabled = true;

        // 旧タイマーがあればクリア
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }

        // イベント駆動: MutationObserver でボタン追加を検出
        _startAcceptObserver();

        // DOM変化の監視（silence検出の精度向上）
        _startDomObserver();

        // 起動時に1回だけ既存ボタンをスキャン
        setTimeout(() => {
            if (state.enabled) performClick();
        }, 500);

        log('起動（イベント駆動モード）');
    };

    window.__graviStop = function () {
        state.enabled = false;
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
        _stopAcceptObserver();
        _stopDomObserver();
        log('停止');
    };

    // ─── Accept Observer（ボタン検出用）──────────────────
    let acceptObserver = null;
    let debounceTimer = null;

    function _startAcceptObserver() {
        _stopAcceptObserver();

        // デバウンス付きの performClick
        function debouncedClick() {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (state.enabled) performClick();
            }, 300); // 300ms 待ってからクリック（連打防止）
        }

        acceptObserver = new MutationObserver((mutations) => {
            if (!state.enabled) return;

            // 新しい要素が追加された場合のみ反応
            let hasNewNodes = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    hasNewNodes = true;
                    break;
                }
            }

            if (hasNewNodes) {
                debouncedClick();
            }
        });

        // document.body を監視（子孫すべて）
        acceptObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function _stopAcceptObserver() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        if (acceptObserver) {
            acceptObserver.disconnect();
            acceptObserver = null;
        }
    }

    window.__graviGetStats = function () {
        return {
            totalClicks: state.stats.totalClicks,
            blockedCommands: state.stats.blockedCommands,
            lastClickTime: state.stats.lastClickTime,
            lastDomChange: state.stats.lastDomChange,
            sessionStart: state.stats.sessionStart
        };
    };

    window.__graviSendPrompt = async function (text) {
        log(`プロンプト送信: "${text.substring(0, 50)}..."`);

        const input = findChatInput();
        if (!input) {
            log('❌ チャット入力欄が見つかりません');
            return { success: false, error: 'チャット入力欄が見つかりません' };
        }

        // フォーカスして入力
        input.focus();

        // テキストを挿入
        // selection を使ってテキストを設定
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);

        document.execCommand('insertText', false, text);

        // 少し待ってから Enter
        await new Promise(r => setTimeout(r, 200));

        // Enter キーで送信
        const enterEvent = new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            which: 13, bubbles: true, cancelable: true
        });
        input.dispatchEvent(enterEvent);

        // 送信ボタンも試す
        await new Promise(r => setTimeout(r, 100));
        const sendBtn = findSendButton(input);
        if (sendBtn) {
            sendBtn.click();
        }

        // 送信確認: 入力欄がクリアされたかチェック
        await new Promise(r => setTimeout(r, 500));
        const remaining = (input.textContent || '').trim();
        const sent = remaining.length === 0 || !remaining.includes(text.substring(0, 20));

        if (sent) {
            log('✅ 送信完了');
            return { success: true };
        } else {
            log('⚠ 送信未確認（入力欄にテキストが残っています）');
            return { success: true, warning: '送信未確認' };
        }
    };

    window.__graviUpdateConfig = function (config) {
        state.config = { ...state.config, ...config };
        log('設定更新');
    };

    // ─── DOM変化監視（silence検出の精度向上） ────────
    function _startDomObserver() {
        _stopDomObserver();
        try {
            state.observer = new MutationObserver(() => {
                state.stats.lastDomChange = Date.now();
            });
            state.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        } catch (e) { /* MutationObserver未対応環境 */ }
    }

    function _stopDomObserver() {
        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }
    }

    log('ペイロード注入完了');
})();
