# openseek-lcm

[中文](README.md) | [English](README.en.md) | **日本語**

**DeepSeek Harness のためのロスレス・コンテキスト記憶。** 古いコンテキストをプロンプトの外へ退避し、検索できる要約ツリーに畳み、コンパクション後の最初のターンで「原文へ戻る方法」をモデルに渡します。

モデルが賢くなるわけではありません。長いセッションの細部を、落とさなくなるだけです。

```
セッションログ ──capture──▶ SQLite アーカイブ ──FTS5──▶ 候補検索 ──JS 再ランク──▶ ポインタ / lcm_* ツール
（真の情報源）              messages · summaries · artifacts
```

`schema v4` · `npm 0.2.2` · MIT

## 何をするのか

- **アーカイブ** —— メッセージを持つセッションイベントはすべてローカルの SQLite へ。巨大なペイロードは内容アドレス型の artifact として外へ出します。アーカイブは派生キャッシュで、失ってもセッションログから再構築できます。
- **要約ツリー** —— アーカイブ済みメッセージを決定論的な親子ノードに畳み、要約から原文まで掘り下げられます。
- **コンパクションを越える** —— コンパクション後の最初のターンに、範囲付きのポインタ（何件消えたか、seq 範囲、取り戻し方）、resume note、そして削除された範囲の末尾メッセージを**そのまま**渡します。
- **スコープ付き検索** —— このセッション / ブランチツリー / 同じ作業ディレクトリ / すべてのアーカイブ。最後のものは操作者専用で、モデルからは既定で届きません。
- **プライバシーと保守** —— 除外と伏せ字は**保存より前**に効きます。保持ポリシー、blob GC、`VACUUM`、doctor、JSON スナップショットは、いずれもまず dry-run です。

## インストール

```
plugin_manager { action: install_bundle, target: "openseek-lcm" }
```

ブランチ指定も可: `github:Pub-Polaris/openseek-lcm#dev`

**インストール後は DSH の再起動が必要です** —— Cordis ローダーは最初に読み込んだモジュール世代を保持します。設定は再読み込みで反映されますが、コードは反映されません。

実行時依存は `node:sqlite` だけです。

## 設定

`config: {}` でも動きます。よく触る 3 つ:

| キー | 既定値 | 意味 |
|---|---|---|
| `resume.backfillMessages` | `6` | コンパクション後にそのまま戻すメッセージ数 |
| `automaticRetrieval.enabled` | `false` | 類似度による毎ターンの呼び戻し |
| `retention.staleSessionDays` | 無効 | 古いセッションの日数ベース削除 |

全キー、4 つのスコープの意味、各ツールの引数は [docs/config.md](docs/config.md) に。

## `/lcm`

```
/lcm status · grep · expand · describe · resume · lineage
/lcm pin | unpin · blobstats · gc · compact · doctor · retention
/lcm source [branch]       動いているのがどのコピーかを表示 / 切り替え
```

閾値はそのまま渡せます（`--staleSessionDays` / `--deletedSessionDays` / `--orphanBlobDays`）。データを変えるサブコマンドは `apply` なしではプレビューのみです。

## どのコピーが動いているか

プロファイルの依存 spec が決めます: `link:<チェックアウト>` はローカル、`github:…#<ブランチ>` はインストール済みのコピー。**コードの変更が効くのは `link:` のときだけ**です。

入口は 2 つ: 設定画面「プラグイン → openseek-lcmのバージョン」（バージョン番号も表示）と `/lcm source`。切り替えには再起動が必要です。

## ドキュメント

| | |
|---|---|
| [docs/config.md](docs/config.md) | 設定の全表 |
| [docs/tools.md](docs/tools.md) | 18 個の `lcm_*` ツール |
| [docs/differences.md](docs/differences.md) | opencode-lcm との意図的な差分 |
| [docs/mapping.md](docs/mapping.md) | OpenCode の拡張点 → Harness の相当物 |
| [docs/verification.md](docs/verification.md) | 3 つのスイート、実測値、整理の順序 |
| [docs/limitations.md](docs/limitations.md) | 既知の制限 |
| [docs/upstream-9713.md](docs/upstream-9713.md) | 予約: 1 会話につき 1 ディレクトリ |

`docs/` は今のところ中国語のみです。

## ライセンス

MIT —— [LICENSE](LICENSE) と [NOTICE](NOTICE) を参照。

**Isaac Grumberg** の [opencode-lcm](https://github.com/Plutarch01/opencode-lcm)（MIT）からの移植で、[Lossless Context Memory](https://papers.voltropy.com/LCM) の OpenCode 実装にあたります。コミュニティによる移植であり、DeepSeek Harness および OpenCode の各プロジェクトとは無関係で、承認も受けていません。
