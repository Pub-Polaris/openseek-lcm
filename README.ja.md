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

## 索引が扱う文字の範囲

検索は n-gram 索引の上に載っています。ラテン文字は 3 文字、CJK は 2 文字、記号は 1 文字。**どの符号位置を CJK と見なすかは、ハードコードされた範囲表**で決まります。その表は Unicode のスナップショットであり、時間とともに古くなります。

| ブロック | 割り当て済み | 現状 |
|---|---|---|
| Ext A / 基本 / 互換漢字 / Ext B | 80,776 | ✅ 索引あり |
| Ext C·D·E·F·I / 互換漢字補助 / Ext G·H·J | 32,223 | ❌ **索引なし** |
| Unicode 18.0 の Jurchen・Seal | 12,293 | ❌ **索引なし** |

失敗は静かです。それらの文字で検索すると「見つかりません」と返り、「存在しない」と区別がつきません。

**この表はこちらで持ち込んだものです。** 元の実装は `[a-z0-9_]` だけを索引し、他の文字は部分一致スキャンに任せていました。範囲は狭いものの、誰も保守する必要はありませんでした。非ラテン文字に対応する際に符号位置の表を写し取ったため、Unicode の改版ごとに手作業の突き合わせが発生します。

根本的な直し方は、表を持たずに実行環境に答えさせることです。`\p{Script=Han}` は Ext A〜J を一括で覆い（現在の表より 8 ブロック多い）、`\p{Extended_Pictographic}` は記号表の代わりになります。92.5k 文字で実測 1.0 ms → 1.6 ms。ただし既存の行は `/lcm doctor apply --reindex` を実行するまで古い索引形式のままです。

詳しくは [docs/limitations.md](docs/limitations.md)。

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
| [docs/tools.md](docs/tools.md) | 19 個の `lcm_*` ツール |
| [docs/differences.md](docs/differences.md) | opencode-lcm との意図的な差分 |
| [docs/mapping.md](docs/mapping.md) | OpenCode の拡張点 → Harness の相当物 |
| [docs/verification.md](docs/verification.md) | 3 つのスイート、実測値、整理の順序 |
| [docs/limitations.md](docs/limitations.md) | 既知の制限 |
| [docs/upstream-9713.md](docs/upstream-9713.md) | 予約: 1 会話につき 1 ディレクトリ |

`docs/` は今のところ中国語のみです。

## ライセンス

MIT —— [LICENSE](LICENSE) と [NOTICE](NOTICE) を参照。

**Isaac Grumberg** の [opencode-lcm](https://github.com/Plutarch01/opencode-lcm)（MIT）からの移植で、[Lossless Context Memory](https://papers.voltropy.com/LCM) の OpenCode 実装にあたります。コミュニティによる移植であり、DeepSeek Harness および OpenCode の各プロジェクトとは無関係で、承認も受けていません。
