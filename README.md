# TRIPLITH

ゴシック調の3人対戦カードゲーム「TRIPLITH」のWebアプリ試作版です。

## ファイル構成
- `index.html` / `style.css` / `app.js`：GitHub Pages等で公開するフロントエンド
- `firebase-config.js`：Firebaseプロジェクトの接続設定
- `functions/index.js`：山札・手札・ターン・得点を管理するサーバー処理
- `database.rules.json`：クライアントから非公開ゲーム状態へアクセスできないようにするルール
- `assets/cards/`：保存済みのTRIPLITHカード画像を使用

## 必要なもの
- Firebaseプロジェクト
- Firebase Authentication の匿名認証を有効化
- Realtime Database（ロケーションは `asia-southeast1` を推奨）
- Firebase CLI
- Node.js 20
- GitHubアカウント（GitHub Pagesで公開する場合）

## セットアップ

1. Firebase Consoleでプロジェクトを作成する。
2. Authentication → Sign-in method → Anonymous を有効にする。
3. Realtime Databaseを作成する。ロケーションは `asia-southeast1` にする。
4. Project settings → Your apps → Web app を作成し、設定値を `firebase-config.js` に入力する。
5. Firebase CLIをインストールしてログインする。

```bash
npm install -g firebase-tools
firebase login
firebase use --add
```

6. Cloud Functionsをセットアップ・デプロイする。

```bash
cd functions
npm install
cd ..
firebase deploy --only database,functions
```

7. フロントエンドをGitHubリポジトリにアップロードする。GitHub Pagesを有効にする。
   またはFirebase Hostingで公開する場合：

```bash
firebase deploy --only hosting
```

## 重要なセキュリティ設計
- 実際の手札・山札・ゲーム進行状態は `/rooms/{roomId}/state` に保存し、クライアントからの読み書きを禁止しています。
- クライアントには公開状態と、そのプレイヤー向けの個別ビューだけを配信します。
- 山札のシャッフル、配札、カード交換、勝敗判定はCallable Functions側で実行します。
- FirebaseのWeb APIキーは秘密情報ではありません。Realtime Database Rulesとサーバー関数による保護が必要です。

## 現在の試作版の仕様・暫定事項
- 3席固定。空席にはホストがCPUを追加できます。
- CPUは簡易AI（ベット前はチェック中心、ベット後はコール中心）です。
- チェンジ：ベット前、1〜3枚。交換前カードを山札に戻してシャッフルします。
- スワップ：ベット後、1〜3枚、1人1回。交換前カードを山札に戻しません。交換後も同じ手番で別の行動ができます。
- スワップ前のカードは他プレイヤーから見えているため、交換前後のカードは全員に公開されます。
- 自分のカードの数字は画面に表示しません。スター所持だけ裏面の違いで判別できます。
- 特殊役は通常の積にボーナスを加える方式で仮実装しています（TRIPLITH +1000 / SYMBOL +400 / DOUBLES +200）。
- 全員チェックで公開します。
- 現在の精算処理はポットを勝者（同点なら勝者間）で分配する簡易版です。オールインのサイドポット、同点時の「レイズしていない者で山分け」、オールイン時の相手からの徴収上限は、最終仕様に合わせた追加調整が必要です。
- CPUは現時点で高度な戦略を持ちません。

## フォント
- Noto Serif JP：Google Fontsから読み込みます。SIL Open Font License 1.1。
- Old London：CSSでフォント名を指定していますが、フォントファイル自体は同梱していません。利用者が配布元の現行ライセンスを確認し、適法に取得したファイルを `assets/fonts/OldLondon.ttf` として配置したうえで、必要に応じてCSSに `@font-face` を追加してください。

## 既知の注意
このプロジェクトは初期試作版です。公開前に必ずFirebaseのテストプロジェクトで複数端末テストを行ってください。特に同時操作、切断復帰、点数精算、レイズ上限、フォールド条件、オールインを重点的に確認してください。
