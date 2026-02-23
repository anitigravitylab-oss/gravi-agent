# ⚡ Gravi Agent

**Antigravity のボタンを自動で押してくれるやつ。**

エージェントが「このファイル変更していい？」「このコマンド実行していい？」と聞いてくるたびにボタンを押す作業、面倒ですよね。Gravi Agent を入れれば、全部自動でやってくれます。

---

## 🚀 導入方法（3ステップ）

### ステップ1: ダウンロード

👉 **[こちらからダウンロード](https://github.com/anitigravitylab-oss/gravi-agent/releases/latest)**

`gravi-agent-x.x.x.vsix` をクリックしてダウンロードしてください。

### ステップ2: インストール

1. Antigravity を開く
2. `Ctrl + Shift + P` を押す（コマンドパレットが開きます）
3. `Extensions: Install from VSIX...` と入力して選択
4. さっきダウンロードした `.vsix` ファイルを選択

### ステップ3: CDP を有効にする

Gravi Agent は Antigravity のブラウザ機能（CDP）を使って動きます。  
**初回だけ**、以下の設定が必要です：

#### Windows の場合

Antigravity のショートカットを右クリック → プロパティ → 「リンク先」の末尾に追加：

```
 --remote-debugging-port=9004
```

例：
```
"C:\Program Files\Antigravity\antigravity.exe" --remote-debugging-port=9004
```

#### Mac の場合

ターミナルで以下を実行：
```bash
antigravity --remote-debugging-port=9004
```

> 💡 Gravi Agent が自動でショートカットを修正してくれる機能もあります。  
> 初回起動時に「再起動しますか？」と聞かれたら「再起動する」を選んでください。

#### ⚠️ CDP ポートを合わせる

Antigravity 側の CDP ポート設定と、Gravi Agent のポート設定を **同じ番号** にしてください。

- **Antigravity 側**: 設定 → `Browser CDP Port`（デフォルト: 9222）
- **Gravi Agent 側**: 設定 → `gravi-agent.cdpPort`（デフォルト: 9004）

どちらかを変更して、**両方同じポート番号** にすればOKです。  
例: 両方 `9004` にする、または両方 `9222` にする。

---

## ✅ 使い方

インストール後、Antigravity を再起動すれば **自動的に ON** になります。

画面右下のステータスバーに表示：
- `⚡ Gravi: ON` → 動作中
- `🚫 Gravi: OFF` → 停止中

**クリックで ON/OFF を切り替え** できます。

---

## 🤖 できること

| 機能 | 説明 |
|------|------|
| **Auto-Accept** | Accept / Run / Retry などのボタンを自動クリック |
| **危険コマンドブロック** | `rm -rf` などの危険なコマンドは自動で止めます |
| **プロンプト送信** | チャットにプロンプトを自動入力して送信 |
| **タスクキュー** | 複数のタスクを順番に自動実行 |

---

## ⚙️ 設定

`Ctrl + Shift + P` → `Gravi Agent: 設定` で変更できます。

| 設定 | 初期値 | 説明 |
|------|--------|------|
| 自動開始 | ON | 起動時に自動で ON にする |
| CDP ポート | 9004 | 通常は変更不要 |
| ブロックパターン | `rm -rf` 等 | 自動承認しないコマンドパターン |
| Silence タイムアウト | 30秒 | タスク完了を判定する無操作時間 |

---

## ❓ よくある質問

### Q: ステータスバーに何も表示されない
A: `Ctrl + Shift + P` → `Developer: Reload Window` を試してください。

### Q: ON にしても動かない
A: CDP が有効になっていません。ステップ3の手順で `--remote-debugging-port=9004` を設定してください。

### Q: 勝手にヤバいコマンドを実行しない？
A: `rm -rf` や `format c:` などの危険コマンドは自動ブロックされます。設定からパターンを追加できます。

---

## 📜 License

MIT
