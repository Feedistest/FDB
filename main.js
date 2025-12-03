// 修正版: Feeder <-> Discord ブリッジ（重複起動対策・エラーハンドリング強化）
// 注意: 実行前に DISCORD_TOKEN を環境変数に設定してください（絶対にコード内に直書きしないこと）
// main.js の先頭で
// stealth の evasions を全部バンドルさせる
require('puppeteer-extra-plugin-stealth/evasions/chrome.app');
require('puppeteer-extra-plugin-stealth/evasions/chrome.runtime');
require('puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow');
require('puppeteer-extra-plugin-stealth/evasions/media.codecs');
require('puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency');
require('puppeteer-extra-plugin-stealth/evasions/navigator.languages');
require('puppeteer-extra-plugin-stealth/evasions/navigator.permissions');
require('puppeteer-extra-plugin-stealth/evasions/navigator.plugins');
require('puppeteer-extra-plugin-stealth/evasions/navigator.vendor');
require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
require('puppeteer-extra-plugin-stealth/evasions/webgl.vendor');
require('puppeteer-extra-plugin-stealth/evasions/window.outerdimensions');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { Client, GatewayIntentBits } = require('discord.js');

const FEEDER_URL = 'https://www1.x-feeder.info/FU33iSqr/';
const FEEDER_PASS = 'South-Sudan-1993';
const EMAIL = 'nj2qkir95a@sute.jp';
const EMAIL_PASS = 'MBpjHcX8';
const CHECK_INTERVAL = 10000; // 10秒ごと
const DISCORD_TOKEN = "MTQzOTE4MzgxNTExNjQ2MDA3NA.GmZDyD.r1jfDRgBr3CgMQ6UE0hQS2ktNIeLNrRGG3dK20";
const CHANNEL_ID = '1439147927896461432';

if (!DISCORD_TOKEN) {
    console.error('エラー: 環境変数 DISCORD_TOKEN を設定してください（コードに直書きしないで）。');
    process.exit(1);
}

const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

let browser = null;
let page = null;

// ループ防止
let lastDiscordPost = null; // Discord → Feeder
let lastFeederPost = null;  // Feeder → Discord

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ルームパスワード入力後にヘッダーが出るまで待つ
async function waitForHeaderAccount(p, timeout = 20000) {
    try {
        return await p.waitForSelector('#header_account', { visible: true, timeout });
    } catch {
        throw new Error('#header_account が見つかりません。ページ構造が変わった可能性があります。');
    }
}

async function loginFeeder(p) {
    console.log("Feederログイン開始");

    await p.goto(FEEDER_URL, { waitUntil: "networkidle2" });

    // ルームパスワード入力
    const passwdInput = await p.$('input[name=passwd]');
    if (passwdInput) {
        await p.type('input[name=passwd]', FEEDER_PASS);
        await Promise.all([
            p.click('input[type=submit]'),
            p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
        ]);
    }
    const skipBtn = await p.$('a.introjs-skipbutton');
    if (skipBtn) await skipBtn.click();
    await sleep(500);
    // overlayやskipを削除
    await p.evaluate(() => {
        document.querySelectorAll('.introjs-overlay, .introjs-skipbutton').forEach(el => el.remove());
    });

    // ヘッダーが表示されるまで待機
    const headerAccount = await waitForHeaderAccount(p);

    await headerAccount.click();

    // アカウントフォームが表示されるまで待機
    await p.waitForSelector('#header_account_contents', { visible: true, timeout: 10000 });

    // メール・パスワード入力
    await p.type('#email', EMAIL);
    await p.type('#account_pw', EMAIL_PASS);

    await Promise.all([
        p.click('#account_login'),
        p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
    ]);

    // ログイン成功判定
    await p.waitForSelector('#post_form_single', { visible: true, timeout: 30000 });
    console.log("Feederログイン成功");
}



async function getSecondComment(p) {
    await p.waitForFunction(() => document.querySelectorAll('.comment').length >= 2, { timeout: 5000 }).catch(() => null);

    return await p.evaluate(() => {
        const list = [...document.querySelectorAll('.comment')];
        const c = list[1];
        if (!c) return null;

        const nameEl = c.parentElement ? c.parentElement.querySelector('.name') : null;
        const name = (nameEl && nameEl.innerText) ? nameEl.innerText.trim() : "不明";

        // テキストノードだけ抽出
        let text = "";
        for (const node of c.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                const t = node.textContent.trim();
                if (t) {
                    if (text) text += ' ';
                    text += t;
                }
            }
        }

        // fallback: 要素内テキスト全部を取る
        if (!text) text = c.innerText ? c.innerText.trim() : "";

        return { name, text };
    });
}

async function startBrowserOnce() {
    if (browser && page) {
        // すでに起動済みなら使い回す
        try {
            await page.title(); // 簡易ヘルスチェック
            return;
        } catch (err) {
            // 既存ブラウザが死んでいたら破棄して再作成
            try { await browser.close(); } catch { }
            browser = null;
            page = null;
        }
    }

    browser = await puppeteer.launch({
        headless: true, // 必須
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage"
        ],
    });


    page = await browser.newPage();
    // 必要なら UA や viewport を設定
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/117.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
    console.log("Stage3突破")
    await loginFeeder(page);
    console.log("Stage4突破")

}
async function safeRestart(reason) {
    console.error('再起動します:', reason);

    // 状態をリセット
    lastDiscordPost = null;
    lastFeederPost = null;

    try { await browser?.close(); } catch { }
    browser = null;
    page = null;

    await sleep(3000); // 少し待機してから再起動
    await mainOnce();   // 再帰的に再起動
}

// Discord -> Feeder
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== CHANNEL_ID) return;

    try {
        const content = message.content;
        if (!content) return; // MessageContent intent が無効なとき対策

        if (content === lastDiscordPost) return;
        lastDiscordPost = content;
        lastFeederPost = "ディスコより:" + message.author.username + ": " + content;

        const inputSelector = '#post_form_single';
        const nameSelector = '#post_form_name';

        await page.waitForSelector(inputSelector, { visible: true, timeout: 10000 });

        // 名前セット（value 直接操作）
        await page.evaluate((sel, val) => {
            const el = document.querySelector(sel);
            if (el) el.value = val;
        }, nameSelector, "ディスコより:" + message.author.username);

        // 本文セット
        await page.evaluate((sel, val) => {
            const el = document.querySelector(sel);
            if (el) el.value = val;
            // 必要ならイベント発火
            el?.dispatchEvent(new Event('input', { bubbles: true }));
        }, inputSelector, content);

        // 送信ボタンをクリックする（Enter に頼らない）
        const submitBtn = await page.$('#post_form_submit') || await page.$('input[type=submit]');
        if (submitBtn) {
            await submitBtn.click();
        } else {
            // フォールバックで Enter を送る（最後の手段）
            await page.focus(inputSelector);
            await page.keyboard.press('Enter');
        }

        console.log('Feederに投稿完了:', content);

    } catch (err) {
        await safeRestart('Feeder投稿エラー: ' + err.message);
    }
});

// Feeder -> Discord
async function startBridge() {
    const channel = await discordClient.channels.fetch(CHANNEL_ID);
    if (!channel) throw new Error('指定したチャンネルが取得できません: ' + CHANNEL_ID);

    // setInterval を使うが、例外が出てもループは継続するようにする
    setInterval(async () => {
        try {
            if (!page) return;
            const post = await getSecondComment(page);
            if (!post) return;
            const combined = `${post.name}: ${post.text}`;
            if (combined === lastFeederPost) return;
            lastFeederPost = combined;
            // トリムして先頭改行を消す
            const body = `${post.name}:\n${post.text}`.replace(/^(\r?\n)/, '');
            await channel.send(body);
            console.log('Discordに送信:', combined);
        } catch (err) {
            console.error('Feederチェック中にエラー:', err);
        }
    }, CHECK_INTERVAL);
}

async function mainOnce() {
    if (!discordClient.user) {
        try {
            await discordClient.login(DISCORD_TOKEN);
            console.log("Stage1突破")
        } catch (err) {
            console.error('Discord login failed:', err);
            return;
        }
    }

    // ready イベント
    console.log("Stage2突破")
    await startBrowserOnce();
    await startBridge();
    discordClient._bridgeStarted = true;
}

// Node.js レベルの未捕捉例外もキャッチして再起動
process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    await safeRestart('unhandledRejection');
});

process.on('uncaughtException', async (err) => {
    console.error('Uncaught Exception:', err);
    await safeRestart('uncaughtException');
});

// safeRestartを改善して安全に再起動
async function safeRestart(reason) {
    console.error('=== 再起動トリガー:', reason, '===');

    try {
        // 既存ブラウザを閉じる
        if (browser) await browser.close();
    } catch {}
    browser = null;
    page = null;

    try {
        // Discordクライアントを破棄
        if (discordClient) await discordClient.destroy();
    } catch {}

    // 投稿キャッシュをリセット
    lastDiscordPost = null;
    lastFeederPost = null;

    // 少し待ってから再起動
    await sleep(3000);

    console.log('再起動処理完了、再度ブリッジを起動します…');
    await runLoop(); // 再帰で再起動
}

// runLoopはエラーが発生しても安全に再起動
async function runLoop() {
    while (true) {
        try {
            console.log('ブリッジ起動処理開始');
            await mainOnce();
            console.log("ブリッジ起動完了、待機中…");
            await new Promise(() => {}); // 永久待機
        } catch (err) {
            console.error('runLoop内で致命的エラー:', err);
            await safeRestart(err.message);
        }
    }
}
runLoop();