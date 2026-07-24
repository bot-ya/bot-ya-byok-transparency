#!/usr/bin/env node
// scripts/build-connector.cjs
// bot-ya コネクタ(connector/bot-ya-connector.js)を「Node なしで動く単一 Windows .exe」に
// ビルドする(B-3 ①)。Node 24 標準の SEA(Single Executable Applications)を使う。
//
// SEA は *単一ファイル* しか取り込めない(require で node_modules を解決できない)ので、
// まず esbuild で connector + ws を1ファイルにバンドルしてから blob を作る。
//
// 手順:
//   1) esbuild で connector を 1 つの CJS にバンドル(ws を inline)
//   2) SEA コンフィグを書き、`node --experimental-sea-config` で blob を生成
//   3) いま動いている node 実行体(process.execPath)を exe としてコピー
//   4) postject で blob を exe に注入
//
// 出力: connector/dist/bot-ya-connector.exe (gitignore 済み)。
// 注意: ここで作るのは「このマシンと同じ OS/arch」向けの exe。Windows で実行すれば
//       Windows 版が出る。本番(macmini)で Windows 配布物を作る場合は、同バージョンの
//       Windows 版 node.exe をベースに同じ手順を踏む必要がある(クロスビルドは follow-up)。

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const { inject } = require('postject');
const { rcedit } = require('rcedit');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'connector', 'bot-ya-connector.js');
const DIST = path.join(ROOT, 'connector', 'dist');
const BUNDLE = path.join(DIST, 'bundle.cjs');
const SEA_CONFIG = path.join(DIST, 'sea-config.json');
const BLOB = path.join(DIST, 'sea-prep.blob');
const EXE_NAME = process.platform === 'win32' ? 'bot-ya-connector.exe' : 'bot-ya-connector';
const EXE = path.join(DIST, EXE_NAME);

// SEA のセンチネル(fuse)を *ベース node 実行体から実測* する。
// Node ドキュメントの例値(...2b0c8)はビルドによって異なり、固定すると postject が
// 「sentinel が見つからない」で失敗する(実際 v24.12.0 は別ハッシュだった)。
// バイナリに焼かれた `NODE_SEA_FUSE_<hex>:<flag>` を拾い、`:flag` を除いた本体を使う。
function detectFuse(nodeBinaryPath) {
    const buf = fs.readFileSync(nodeBinaryPath);
    const at = buf.indexOf(Buffer.from('NODE_SEA_FUSE_'));
    if (at < 0) throw new Error('ベース node 実行体に SEA fuse が見つかりません(SEA 非対応の node?)');
    let s = '';
    for (let i = at; i < at + 80; i++) {
        const c = buf[i];
        if (c === 0x3a /* ':' */ || c < 0x20 || c >= 0x7f) break; // フラグ(:0)・非表示文字で終端
        s += String.fromCharCode(c);
    }
    return s;
}
const FUSE = detectFuse(process.execPath);

(async () => {
    fs.mkdirSync(DIST, { recursive: true });

    // 1) esbuild で 1 ファイルへバンドル。
    //    bufferutil / utf-8-validate は ws の *任意* ネイティブ最適化依存。未導入環境では
    //    ws が純 JS 実装にフォールバックするので external 指定で除外してよい。
    console.log('[build] bundling connector with esbuild...');
    await esbuild.build({
        entryPoints: [SRC],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: BUNDLE,
        external: ['bufferutil', 'utf-8-validate'],
        logLevel: 'info'
    });

    // 2) SEA コンフィグ → blob 生成。
    //    useCodeCache/useSnapshot は false(互換重視。常駐コネクタなので起動速度より堅牢性)。
    fs.writeFileSync(SEA_CONFIG, JSON.stringify({
        main: BUNDLE,
        output: BLOB,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false
    }, null, 2));
    console.log('[build] generating SEA blob...');
    execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit' });

    // 3) いまの node 実行体を exe ベースとしてコピー。
    console.log('[build] copying node runtime as base exe...');
    fs.copyFileSync(process.execPath, EXE);

    // 3.5) VERSIONINFO リソースを製品情報に書き換える(Windows のみ)。
    //      素の node.exe のままだとタスクマネージャー等で「Node.js JavaScript Runtime」と
    //      表示され、ユーザーには正体不明のプロセスに見える(dogfood 所見・バックログ③)。
    //      リソース編集はセクション配置を変え得るので、必ず blob 注入 *前* に行うこと。
    if (process.platform === 'win32') {
        const pkgVersion = require(path.join(ROOT, 'package.json')).version; // e.g. '1.0.0-beta'
        const numericVersion = `${(pkgVersion.match(/^\d+\.\d+\.\d+/) || ['0.0.0'])[0]}.0`;
        console.log(`[build] rewriting VERSIONINFO with rcedit... (v${pkgVersion})`);
        await rcedit(EXE, {
            'version-string': {
                ProductName: 'bot-ya コネクタ',
                FileDescription: 'bot-ya コネクタ（接続アプリ）',
                CompanyName: 'bot-ya.app',
                LegalCopyright: `(c) ${new Date().getFullYear()} bot-ya.app`,
                OriginalFilename: EXE_NAME,
                InternalName: 'bot-ya-connector'
            },
            'file-version': numericVersion,
            'product-version': pkgVersion
        });
    } else {
        console.log('[build] skipping VERSIONINFO rewrite (win32 only)');
    }

    // 4) postject で blob を注入。
    //    Windows の node.exe は Authenticode 署名済みで、注入すると署名は無効化されるが
    //    実行はできる(本 MVP は元々未署名配布なので問題なし)。
    console.log(`[build] injecting SEA blob with postject... (fuse=${FUSE})`);
    const blob = fs.readFileSync(BLOB);
    await inject(EXE, 'NODE_SEA_BLOB', blob, { sentinelFuse: FUSE });

    const mb = (fs.statSync(EXE).size / (1024 * 1024)).toFixed(1);
    console.log(`[build] done -> ${path.relative(ROOT, EXE)} (${mb} MB)`);
})().catch((e) => {
    console.error('[build] FAILED:', e && e.stack ? e.stack : e);
    process.exit(1);
});
