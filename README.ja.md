# openseek-lcm

[中文](README.md) | [English](README.en.md) | **日本語**

**DeepSeek Harness のための Lossless Context Memory** — 古いセッションコンテキストを
アクティブなプロンプトの外にアーカイブし、検索可能な要約のツリーへ畳み込み、
コンパクション後の最初のターンに、取り除かれたものへ戻る道をモデルに渡す
Host プラグインです。

> **成り立ち。** これは [`opencode-lcm`](https://github.com/Plutarch01/opencode-lcm)
> ([npm](https://www.npmjs.com/package/opencode-lcm)、MIT、作者 Isaac Grumberg) の移植版です。
> 同プロジェクトは [Lossless Context Memory](https://papers.voltropy.com/LCM) という着想の
> OpenCode 実装にあたります。アーカイブモデル、18 個のツール群、スコープのはしご、ランキングの
> 重み、そしてドライラン優先のメンテナンスコマンドは上流と一対一で対応しています。変わったのは
> ホストアダプタと Harness 固有の修正群で、
> [意図的な差分](#意図的な差分opencode-lcm-との) に列挙しています。
>
> **どのように作られたか。** すべて **DeepSeek Harness** 上で **DeepSeek V4.1 Flash**
> (`deepseek-v4.1-flash`) を動かしながら、その内側で作られました。アーキテクチャ、実装、
> 3 つのテストスイート、そしてライブデバッグは、すべて Harness セッション内のエージェントが
> 実際の 6,000 メッセージのアーカイブに対して行いました。2 文字の中国語クエリが強いた
> 検索インデックスの再設計や、後述する WAL/VACUUM の順序バグも含みます。ここにあるものは
> そのループの外では一切書かれていません。

モデルが賢くなるわけではありません。長いセッションの細部を失わなくなるのです。

```
   session log ──capture──▶ SQLite archive ──FTS5──▶ candidate retrieval
   (source of truth)        (messages,                  │
                             summaries,                  ▼
                             artifacts)         JS re-rank (coverage, phrase,
                                                recency, source kind)
                                                        │
                                    ┌───────────────────┴───────────────────┐
                                    ▼                                       ▼
                        agent/pre-step rewrite                  lcm_* tools for the model
                        (automatic recall)                       (grep / expand / artifact)
```

> **現在の状態 (2026-10-06)。** 実際のアーカイブで検証済みです (schema v4。数値は[検証](#検証)にあります)。**`lcm_retrieval_debug` と `/lcm debug` は Deprecated と表示するようになりました** — 類似度による呼び戻しは既定で無効で、コンパクション直後の最初のターンは決定論的なコンパクションポインタと resume note が担います。メンテナンスの順序と、実データで計測した落とし穴は[制限事項](#制限事項)にあります。

## 何をするのか

- **アーカイブ** — すべてのセッションの、メッセージを持つすべてのイベントをローカルの SQLite
  アーカイブに取り込み、巨大なペイロードは重複排除された artifact へ移します。
- **要約ツリー** — アーカイブされたメッセージは決定的な親子の要約ノードへ畳み込まれ、
  モデルはダイジェストから生テキストまで辿り下りられます。
- **自動呼び戻し** — コンパクションの直後の最初のターンに、上限付きのコンパクションポインタ
  (取り除かれたメッセージ数、seq の範囲、トークンの見積もり、および元のテキストへ戻る正確な
  道 — 範囲内の要約ノードへの `lcm_expand`、または `lcm_grep --scope session`) が 1 件
  注入され、レジュメノートが同じメッセージに続きます。ターンごとの類似度呼び戻しは
  オプトインの追加機能で、既定では無効です。
- **スコープ付き検索** — 1 つのクエリは、このセッションだけ、そのブランチツリー全体、
  同じ作業ディレクトリのすべてのセッション、あるいはアーカイブされたすべてのセッションに
  またがります。第 4 のスコープ `all` は操作者のものです。人が使う `/lcm` コマンドは常に
  これを受け付けますが、モデル向けの `lcm_grep` / `lcm_describe` は操作者が
  `allowScopeAll: true` を設定しない限りこれを使いません。1 つの Harness ホームは
  プロジェクトをまたぐため、そうしなければモデルが他のプロジェクトの会話をこのコンテキストへ
  引き込んでしまうからです。
- **プライバシー制御** — ツール出力の除外、パスに基づく取り込み除外、破壊的な正規表現による
  秘匿化。いずれも保存・インデックス化の*前に*適用されます。
- **保持とハウスキーピング** — ドライラン優先の保持ポリシー削除、blob GC、WAL チェックポイント
  + VACUUM、整合性ドクター、可搬な JSON スナップショット。

## OpenCode から Harness への対応付け

`opencode-lcm` は 4 つの OpenCode 拡張点の上に成り立っています。それぞれに Harness 側の
対応物があります。

| `opencode-lcm` (OpenCode) | このプラグイン (DeepSeek Harness) |
|---|---|
| `event` フック — すべてのセッションイベントを取り込む | `ctx.on('session/event', …, { global: true })`、加えて `ctx.sessionQuery.readSession()` によるウォーターマーク保護付きのバックフィル |
| `experimental.chat.messages.transform` | `agent/pre-step` ウォーターフォール — 注入メッセージを 1 件、ステップの判断に追記する (コンパクションポインタ、自動呼び戻しが有効なときは呼び戻したコンテキスト) |
| `experimental.chat.system.transform` | `ctx.systemPrompt.section({ name: 'lcm:hint', order: 9000 })` |
| `experimental.session.compacting` | レジュメノートは `compaction/*` マーカーの後の最初のターンに、コンパクションポインタとともに届けられる |
| `tool` フック — 18 個の `lcm_*` ツール | `ctx.tools.register()` — 同じ 18 個のツール |
| `command` サーフェス (上流には無し) | `ctx.commands.register()` — 人が使う `/lcm` コマンド |
| `.lcm/lcm.db` (SQLite + FTS5) | `<DSH_HOME>/storages/dsh-plugin-lcm/lcm.db` (`node:sqlite` 経由の SQLite + FTS5) |

Harness のセッションログはすでに可逆な追記専用の記録なので、アーカイブは厳密に
**派生キャッシュ**として扱われます。取り込みが漏れても、次の読み取りがウォーターマークの
遅れに気づき、欠けた先頭部分を再生します。このプラグインが会話の内容を失うことはありません。

## インストール

このプラグインは素の Host bundle で、`node:sqlite` 以外に実行時依存はありません。
`node:sqlite` は Harness 自身がセッション検索にすでに使っています。

```
plugin_manager { action: install_bundle, target: "D:\\src\\openseek-lcm" }
```

`target` は pnpm がインストールできるものなら何でも受け付けます — 上記のようなローカル
ディレクトリ、git URL、tarball、あるいは npm 名です。組み立てられる行の名前は
`@local/dsh-plugin-lcm` ですが、これは bundle id にすぎず、リポジトリは `openseek-lcm` です。

> **Windows のパスに関する注意。** **ドライブレター**のパスからインストールしてください。
> pnpm は `\\server\share` 形式の target を壊れた相対シンボリックリンクに書き換えてしまい、
> 有効化が *"cannot resolve profile bundle"* で失敗します。マップ済みドライブレターか
> ローカルパスを使ってください。

プラグインのインストール後や変更後には DeepSeek Harness Desktop の再起動が必要です。
Cordis ローダーは最初にインポートしたモジュール世代を保持し続けるためです。*config* の値の
編集はリロードで反映されますが、**コード**の編集は反映されません。

## 設定

値はプラグイン行の `config` に設定します。すべてのキーは任意で、欠けたキーは既定値に
フォールバックするので、空の `config: {}` でも有効です。既定値付きの完全な一覧は
`lib/config.js` の `DEFAULT_CONFIG` にあり、下の表はその読みやすい要約です。
[`cordis.patch.yml`](./cordis.patch.yml) は多くの配備が設定するキーだけを載せています。

| キー | 既定値 | 意味 |
|---|---|---|
| `storeDir` | `<DSH_HOME>/storages/dsh-plugin-lcm` | アーカイブディレクトリ (DSH のプラグインデータ領域)。 |
| `capture.enabled` | `true` | 取り込みのマスタースイッチ。 |
| `capture.includeToolResults` | `true` | ツール出力をアーカイブする。 |
| `capture.maxTextCharsPerMessage` | `60000` | インデックス化するテキストのメッセージ単位の上限。 |
| `automaticRetrieval.enabled` | `false` | 類似度に基づくターンごとの呼び戻し (既定では無効)。決定的なコンパクションポインタとレジュメノートはこれに依存しません。 |
| `automaticRetrieval.maxChars` | `900` | 注入される呼び戻しテキストの厳格な上限。 |
| `automaticRetrieval.minTokens` | `2` | 呼び戻しを実行する最小クエリトークン数。 |
| `automaticRetrieval.maxMessageHits` / `maxSummaryHits` / `maxArtifactHits` | `2` / `1` / `1` | 種別ごとのクォータ。 |
| `automaticRetrieval.scopeOrder` | `[session, root, worktree]` | 昇格のはしご。安い順。 |
| `automaticRetrieval.scopeBudgets` | `{session:16, root:12, worktree:8, all:6}` | スコープごとの候補バジェット。 |
| `automaticRetrieval.stop.targetHits` | `3` | この件数のヒットが選ばれたら停止。 |
| `freshTailMessages` | `10` | 呼び戻しから除外する最新メッセージ (モデルがすでに見ているため)。 |
| `summary.minMessagesForTransform` | `16` | 要約ツリーを構築する前に必要なアーカイブ済みメッセージ数。 |
| `summary.levelSize` | `6` | 1 つの親へ畳み込む子の数。 |
| `summary.summaryCharBudget` | `1500` | 要約ノードあたりの文字バジェット。 |
| `systemHint` / `systemHintOrder` | `true` / `9000` | アーカイブの存在をモデルに伝えるプロンプトセクション。 |
| `tools.enabled` | `true` | `lcm_*` スイートを登録する。 |
| `tools.expose` | — | ツール名の許可リスト。リクエストごとのスキーマトークンを削減する。 |
| `allowScopeAll` | `false` | モデル向けツールにプロジェクト横断の `all` スコープを許可する。人が使う `/lcm` コマンドは影響を受けない。 |
| `retention.staleSessionDays` | 無効 | N 日間触られていないセッションを削除する。 |
| `retention.deletedSessionDays` | `30` | 削除済みセッションを N 日後に削除する。 |
| `retention.orphanBlobDays` | `14` | 参照されていない blob を回収可能になるまでの猶予期間。 |
| `privacy.excludeToolPrefixes` | `[]` | これらのプレフィックスを持つツールのペイロードをアーカイブしない。 |
| `privacy.excludePathPatterns` | `[]` | 一致するパスを抑止・秘匿化する。 |
| `privacy.redactPatterns` | `[]` | 保存前に一致箇所を破壊的に置換する。 |

## ツール

上流の 18 個のツールはすべて、同じ名前・引数・既定値で提供されます。変更を伴うツールは
`apply: true` を付けない限りドライランです。

| ツール | 目的 |
|---|---|
| `lcm_status` | アーカイブと設定の棚卸し。 |
| `lcm_retrieval_debug` | **Deprecated（非推奨）**: 直近の自動呼び戻しの診断 (スコープごと、生候補と採用の比較)。類似度による呼び戻しは既定で無効 (`automaticRetrieval.enabled: false`) のため、通常は「まだ実行されていない」としか答えません。コンパクションを生き延びた内容は `lcm_resume` で確認してください。 |
| `lcm_resume` | セッションの永続的なレジュメノート。 |
| `lcm_grep` | スコープ付きのアーカイブ検索。`offset` によるページングと `summaryID` による部分木の限定に対応。 |
| `lcm_describe` | あるスコープに対してアーカイブが何を保持しているか。 |
| `lcm_lineage` | セッションの祖先と直接の子。 |
| `lcm_expand` | 要約ノードを辿る。`includeRaw` は要約で足りないときだけ。 |
| `lcm_artifact` | 外部化されたペイロードを読む (曖昧でない id プレフィックスを受け付ける)。 |
| `lcm_pin_session` / `lcm_unpin_session` | セッションを保持ポリシーから保護する。 |
| `lcm_blob_stats` / `lcm_blob_gc` | 重複排除された blob の棚卸し / 孤立したものの回収。 |
| `lcm_compact` | 内部イベントを削除し、VACUUM し、その後に WAL をチェックポイントする。 |
| `lcm_doctor` | 整合性の検査。`apply: true` で FTS と要約の状態を修復する。 |
| `lcm_retention_report` / `lcm_retention_prune` | 保持ポリシーのプレビュー / 適用。 |
| `lcm_export_snapshot` / `lcm_import_snapshot` | 可搬な JSON スナップショット (`merge` または `replace`)。 |

表示されるすべてのツールスキーマは**すべての**リクエストに付随するため、このスイートは
呼び出しのたびにプロンプトトークンを消費します。`tools.expose` と `tools.enabled` は
そのコストを削るために存在します。

## `/lcm` コマンド

このプラグインが公開する他のすべてはモデル向けです。`/lcm` は人がコンポーザーから直接
操作するサーフェスで、サブコマンドを持つ 1 つのコマンドなので、コマンドパレットへの追加は
1 エントリで済みます。その出力はあなたに表示され、会話には注入されません。

```
/lcm status                               archive inventory and configuration
/lcm grep <query> [--scope s] [--limit n] search (s = session|root|worktree|all)
/lcm expand <nodeID|query> [raw]          progressively expand summary nodes
/lcm describe [scope]                     what the archive holds
/lcm resume                               the note that survives a compaction
/lcm lineage                              this session ancestry and children
/lcm debug [Deprecated]                    diagnostics of the last automatic recall (off by default; see resume)
/lcm pin [reason] | unpin                 protect this session from retention
/lcm blobstats [n]                        artifact blob inventory
/lcm gc [apply]                           preview or delete orphaned blobs
/lcm compact [apply]                      preview or reclaim database space
/lcm doctor [apply]                       inspect or repair summaries and indexes
/lcm retention [apply]                    preview or apply the retention policy
```

`--scope all` は操作者自身が入力するものなので、引き続き利用できます。モデル向けの `lcm_grep` / `lcm_describe` は既定ではこれを拒否し、操作者が `allowScopeAll: true` を設定したときだけ通します — 1 つの Harness ホームはプロジェクトをまたぐため、そうしなければモデルが他のプロジェクトの会話をこのコンテキストへ引き込んでしまうからです。

他のすべての箇所と同様、変更を伴うサブコマンドは `apply` を渡さない限りプレビューのみです。
このコマンドは任意依存として登録されるので、コマンドレジストリを持たないプロファイルでも
アーカイブ、コンパクションポインタ、モデル向けツールはそのまま使えます。コマンド出力は設計上
人間専用です — UI に描画され、モデルのメッセージになることはありません。

## 意図的な差分（opencode-lcm との）

これらは実際の Harness のセマンティクスへの適応であり、省略ではありません。

1. **既定で注入されるのはポインタであり、呼び戻されたコンテキストではありません。**
   コンパクションのバックエンドは何を取り除いたかを永続的に記録します —
   `compaction/summary` イベントが `shadowedRange {start,end}`、`shadowedSeqs`、
   `shadowedTokenCount` を持ちます — なので推測は不要です。コンパクションの直後の最初の
   ターンに、取り除かれたメッセージ数、seq の範囲、トークンの見積もり、そして元のテキストへ
   戻る正確な道 (範囲内の要約ノードへの `lcm_expand`、または `lcm_grep --scope session`) を
   示す上限付きのコンパクションポインタが 1 件だけ注入され、レジュメノートが同じメッセージに
   続きます。ポインタ自体はアーカイブの内容を運ばず、コンパクションごとにちょうど 1 回だけ
   届けられ、`automaticRetrieval.enabled` には依存しません — 検索ではなく決定的な参照です。
   類似度呼び戻しはオプトインの経路で、有効にしたときの挙動は従来どおりです。Harness は
   受け入れられた `user/message` のバッチをセッションログへコミットするため、呼び戻しの注入
   (`source.kind = 'lcm-recall'` とタグ付けされる) は一時的なリクエスト書き換えではなく
   永続化されます。代償はログの増加ですが、新しいユーザーターンごとに
   `automaticRetrieval.maxChars` で上限が課されます。継続ステップは新しいプロンプトを
   要求しないため、再注入されることはありません。アンカーの選択は、`source.kind` が無いか
   `'user'` のときだけメッセージを操作者の入力と見なすようになりました。それ以外の種別
   (`lcm-recall`、`runtime-context`、`system-prompt`、他のプラグインがタグ付けした
   メッセージ) はすべて注入済みとして扱われます — Harness はランタイムコンテキストの
   スナップショットを**それ自身の別個の** user ロールメッセージとして出すのに対し、以前の
   ロジックは最も新しい user ロールメッセージを取っていたため、検索クエリが harness の
   ボイラープレートになってしまうからです (実機のセッションで測定されたクエリは英語の
   ボイラープレート語 10 語で、操作者自身の中国語は 1 語も寄与しませんでした)。
2. **インデックスは生テキストではなく n-gram を格納します。** 上流は FTS5 の既定の
   `unicode61` トークナイザに依存しており、これは漢字の連なり全体を 1 トークンとして扱うため、
   `无损上下文记忆` を `上下文` で検索できません。`trigram` トークナイザに切り替えるとそれは
   直りますが、今度は 2 文字の語で失敗します — そしてそれは中国語の語の標準的な長さです
   (召回, 诊断, 记忆, 索引)。そこで `explodeForIndex` がテキストを文字体系ごとのサイズの
   順序付き n-gram (CJK はバイグラム、ラテン文字はトライグラム) に書き換え、テーブルはそれを
   `unicode61` でインデックス化します。こうして「この部分文字列は出現するか?」が
   「このグラム列は隣接して出現するか?」になり、これはラテン文字の部分文字列にも 2 文字の
   中国語の語にも同様に成り立ちます。トークナイザは `unicode61 tokenchars '_'` として宣言され、
   `store_path` のような識別子がアンダースコアを保つようにしています。
3. **候補の取得は OR で、精度はランキングが担います。** `buildFtsQuery` は各連なりを
   グラムのフレーズに変換し、素の語は `OR` で (引用したグループは `AND` で) 結合します。
   この式は候補を集めるだけだからです。順序を決めるのは移植された JavaScript の再ランキングで、
   トークンの被覆、フレーズのヒット、役割、新しさを*元の*テキストに対して照合して判断します。
   自然言語クエリのすべての語を AND で結ぶと、関連するほぼすべてのメッセージが弾かれて
   しまいます。インデックスがまったく答えられないとき — たとえば文字体系のグラムより短い語 —
   は、自動呼び戻しが上限付きの部分文字列スキャンで 1 度だけ再試行します。
   クエリの語は使う前にフィルタもされます。アーカイブが見たことのない語は捨てられます —
   上流の TF-IDF 順ではそのような語が*最初*に来ます。どこにも現れない語は最大限に希少に見える
   ため、何にも一致し得ないクエリにバジェットの全部を費やしてしまうからです — そして
   「文書の 80% 超に現れる」ストップワード規則は、その比率が意味を持つ程度にコーパスが
   大きくなってから初めて適用され、そうでなければすべての語を捨てる代わりに一般的な語へ
   フォールバックします。
4. **CJK のトークナイズを追加しました。** 上流の `tokenizeQuery` は `[a-z0-9_]+` しか
   認識しないため、中国語のクエリはすべてトークン数ゼロに潰れて呼び戻しが黙って無効化されます。
   ここでは CJK の連なりがバイグラムとしてスコアリングに寄与し、インデックスが格納する
   グラム幅も同じなので、2 文字の中国語クエリはスキャンではなくインデックス自体で答えられます。
5. **コンパクションのレジュメノートは圧縮後の最初のターンに届けられます。** コンパクションは
   Harness が所有しており、要約入力に追記するフックは提供されないため、コンパクションプロンプト
   へ注入する代わりに、`compaction/*` マーカーの後の最初のターンにコンパクションポインタと
   ともにノートを出します。上流の結果 — コンパクションプロンプトを上書きせずに重要な
   コンテキストが縮小を生き延びる — は保たれています。
6. **`worktree` は「同じ作業ディレクトリ」を意味します。** Harness には git worktree の概念が
   ないため、`worktree` スコープは `cwd` が一致するすべてのセッションです。`root` は各セッション
   ヘッダーの `parentSession` 連鎖から導かれるブランチツリーです。
7. **1 メッセージ 1 行で、messages + parts ではありません。** Harness のメッセージは
   `content: ContentBlock[]` をインラインで持つため、アーカイブはメッセージごとに 1 行を格納し、
   巨大なブロックには `artifacts` を使います。要約ノードは配列の添字ではなくログの `seq` を
   範囲とします。
8. **アーカイブは `.lcm` ではなく DSH のプラグインデータ領域に置かれます。** 上流は
   データベースを `<project>/.lcm/lcm.db` に格納します。この慣習は opencode のものであり、
   共有ホーム配下の素の `lcm` ディレクトリはそれと混同しやすいため、このプラグインは既定で
   `<DSH_HOME>/storages/dsh-plugin-lcm/` を使います — DSH 自身の設定ツリーの内側で、
   他のプラグイン別ストレージ領域 (`session_projcache`、`maidsh_memory`) と並びます。
   `storeDir` はこれを丸ごと上書きします。アーカイブは派生データであり、セッションログから
   いつでも再構築できます。
9. **コンパクションの順序は prune → VACUUM → checkpoint です。** これは移植の判断ではなく
   バグ修正です。`VACUUM` はデータベース全体を *WAL 経由で* 書き換えるため、その前に
   チェックポイントすると回収されたページが WAL に残ります。操作は小さな `reclaimed` 値を
   報告する一方で、WAL はデータベースのサイズ分だけ膨らみます。開発用アーカイブでは最初の実行が
   `reclaimed=7.6 MiB` を報告し、WAL を 48.7 MB から 89.9 MB へ押し上げました。順序を
   直した同じ操作は ~97.7 MiB を回収しました。
10. **移植しなかったもの:** 上流のバイナリプレビュープロバイダ (`fingerprint`、`byte-peek`、
    `image-dimensions`、`pdf-metadata`、`zip-metadata`、`previewBytePeek`) と
    `lcm_import_snapshot` の `worktreeMode` です。Harness のツール結果は型付きの
    コンテンツブロックとして届き、そこでは画像やファイルはすでに短いプレースホルダとして
    描画される添付参照であり、また remap すべき worktree の同一性もありません。

## 検証

3 つのスイートが、ライブプロファイルなしでこのプラグインを検証します。`node:sqlite` のために
Node ≥ 22.5 が必要です。Host 自身の実行時 Node でも動作します。

```powershell
node test/smoke.mjs
node test/recall.mjs
node test/plugin.mjs
```

`test/smoke.mjs` は、Harness の形をした合成セッションイベントを使って、使い捨ての
データベースに対してアーカイブのパイプライン全体を動かします (~~30 チェック~~ 53 チェック)。

取り込みと冪等な再取り込み、artifact の外部化と保存前の秘匿化、n-gram 検索のプリミティブ
(`explodeForIndex`、`buildFtsQuery`)、4 つのスコープすべて、要約ツリーの決定性、FTS のみの
検索 (フォールバックではなくインデックスの経路を通ることを証明)、CJK 検索、短いクエリの
スキャンフォールバック、要約の部分木の限定、段階的な展開、自動呼び戻しの上限、レジュメノート、
pin、blob の統計、doctor の修復、保持ポリシーのドライランと適用、コンパクション、
スナップショットの往復、ツールペイロードの除外を網羅します。

`test/recall.mjs` は、ライブの Harness を最も必要とせず、テストを最も必要とする判断を
網羅します。注入されたコンテキストに対するアンカーの選択、継続バッチの辞退、所有する Agent を
解決する 3 つの情報源 (例外を投げるスコープを含む)、注入の上限とタグ付け、レジュメノートの
昇格がちょうど 1 回だけ消費されること、ステップの判断の残りを失わずにプランをマージすること
です (~~11 チェック~~ 17 チェック)。

`test/plugin.mjs` は、再起動なしでライブ実行に最も近いものです。ローダーとまったく同じように
`index.js` をインポートし、最小限の偽の Cordis ホストに対して `apply()` を実行したうえで、
すべての登録が同期パス上で起きたこと、18 個のツールすべてが使えるスキーマを備えていること、
システムヒントが設定された順序の 1 つの非補間セクションであること、スコープ付きリスナーが
`global: true` で購読していること、ライブの `session/event` がインラインで書き込まれず
バッファリングされること、ツール呼び出しがアーカイブをバックフィルすること、実際の
`agent/pre-step` のディスパッチがタグ付きの呼び戻しコンテキストを、判断の残りを保ったまま
注入すること、そして `/lcm` の定義がコマンドレジストリの契約 (名前の形、空でない説明、
空でない入力ヒント、ハンドラ関数) を満たすこと — レジストリが実際に渡す生入力の形、
区切りの空白も含めて — を検証します (~~16 チェック~~ 20 チェック)。

開発プロファイルでのライブ状態 (2026-10-06、**直近のメンテナンス後の実測値**):

```
schema_version=4        fts_available=true      capture_failures=0
session_count=30        message_count=11565     summary_nodes=2299
artifacts=3472          artifact_blobs=3608     orphan_blobs=183
db_bytes=106.2 MB       wal_bytes=0
```

このときの手順は、そのままアーカイブ整理の正しい順序でもあります: `lcm_doctor apply=true` で派生層を再構築 → `lcm_pin_session` で残すべきセッションを固定 → `lcm_retention_prune` を 2 日閾値で実行して古い 12 セッションを削除 (−962 メッセージ、−283 artifact) → `lcm_compact apply=true` (剪枝 + VACUUM) で **一度に 12.4 MiB を回収**。実行前は 42 セッション、12,527 メッセージ、**104.9 MiB** でした。

~~以前の読み取り (2026-10-02) は schema_version=4、message_count=6923、summary_nodes=1368、artifacts=2582、artifact_blobs=2589、shared_blobs=13、orphan_blobs=36、db_bytes=64.8 MiB、wal_bytes=7.4 MiB でした。~~ その前の schema_version=3 の読み取り (91.7 MiB) は、schema 4 への移行とコンパクションにより無効です。

スキーマ v2 -> v3 の検索インデックス移行は、そのライブアーカイブのコピーに対して測定しました。
有効化の間に 9,625 ドキュメントが 1.7 秒で再インデックス化され、その後 `召回`、`诊断`、
`召回诊断`、`归档` — いずれも 2 文字の中国語の語 — がすべてインデックスだけで一致しました
(`allowScan: false`)。また `看下召回诊断` の自動呼び戻しは、以前は 0 件だったところ 3 件の
ヒットを返しました。

`lcm_grep "trigram tokenizer"` はアシスタントメッセージと 2 つの外部化された artifact に
またがるランク付きのヒットを返しました。`lcm_expand` は実際のログシーケンス 1007–1144 に対して
3 レベルの要約ツリーを構築して辿りました。

## 制限事項

- **アーカイブのサイズは現実的です。** ~~6,376 メッセージで ~92 MB になりました。~~ 現在は 6,923 メッセージで
  データベース 64.8 MiB (WAL が別途 7.4 MiB) です — schema 4 では artifact の本文は内容アドレス方式の
  blob に 1 部だけ置かれ、インデックスにはプレビューだけが入ります。解放されたページを実際にディスクへ
  戻すのは `lcm_compact apply=true` です。大きな取り込みの後はそれを実行し、増加の確認には
  `lcm_retention_report` を使ってください。
- **要約ノードはダイジェストであり、代替物ではありません。** 1,500 文字のルートが数千の
  メッセージを代表できるはずはなく、ツリーは生テキストまで下りるために存在します。だからこそ
  `lcm_expand includeRaw=true` が最後の手段であり続けます。
- **`tools.enabled` が true の間は、ツールスキーマがリクエストごとにプロンプトトークンを
  消費します。**
- **コードの変更にはアプリケーション全体の再起動が必要です。** プロファイルのリロードは
  キャッシュされたモジュール世代を再利用するため、プラグインの編集はプロセスを再起動するまで
  何も起きていないように見えます。
- `node:sqlite` が必要です。この Harness ビルドでは利用可能です (同梱の
  `dsh-session-query-sqlite` パッケージが同じモジュールを使っています)。それを持たないビルドでは、
  プラグインはアーカイブのエラーを報告して劣化動作に落ち、会話を失敗させはしません。
- **類似度による呼び戻しは既定で無効で、それを報告する 2 つの入口も一緒に劣化します。**
  `automaticRetrieval.enabled: false` のとき自動呼び戻しは決して走らないため、
  `lcm_retrieval_debug` と `/lcm debug` は **Deprecated** です (「まだ実行されていない」としか
  答えられません)。さらにそのテレメトリはメモリ上のマップなので、有効にしても現在のプロセスを
  説明するだけで、再起動で失われます。
- **保持ポリシーは既定の設定では何も削除しません。** `retention.staleSessionDays` は既定で無効で、
  `/lcm retention apply` は閾値を受け取らず設定どおりに実行するだけ — つまり空操作です。実際に
  削除できるのはツール `lcm_retention_prune` (`staleSessionDays` / `orphanBlobDays` を渡せます) です。
- **年齢による整理の前には必ず pin してください。** 古いかどうかはアーカイブの `updated` 列で
  判定され、**現在のツリーのルートセッションは更新されません** — 事前に `lcm_pin_session` しないと、
  自分の分岐ツリーのルートを消してしまい、セッション横断の呼び戻しが効かなくなります。
- **blob GC の猶予期間は設定値のみを見ます。** `lcm_blob_gc` は `orphanBlobDays` の上書きを無視します
  (0 を渡しても空操作で、新たに孤立した blob に印を付けて計時を始めるだけ。削除は後続の呼び出し)。
  すぐに回収したい場合は `lcm_retention_prune` を使ってください。また 1 回あたり各種類 50 行が上限なので、
  数百件を消すには繰り返し呼ぶ必要があります。
- **容量の大半はメッセージ行と FTS インデックスで、blob ではありません。** 実測で blob 3,700 個は
  合計約 14 MB、データベースは約 100 MB です。その領域をディスクへ返すのが
  `lcm_compact apply=true` (VACUUM) で、実測では 1 回で 12 MB を回収しました。

## 謝辞とライセンス

MIT — [LICENSE](./LICENSE) を参照してください。

この設計は **Isaac Grumberg** による [`opencode-lcm`](https://github.com/Plutarch01/opencode-lcm)
(MIT)、すなわち Lossless Context Memory の OpenCode 実装から移植されました。上流の著作権表示は
[NOTICE](./NOTICE) に、この手法の出典である論文とともに保持されています。

これはコミュニティによる移植です。DeepSeek Harness や OpenCode のプロジェクトと提携して
おらず、承認も受けていません。
