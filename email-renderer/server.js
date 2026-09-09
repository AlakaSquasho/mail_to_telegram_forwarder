const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
// 邮件 HTML 可能比较大，提高 JSON Body 解析限制
app.use(express.json({ limit: '10mb' }));

// 环境变量配置
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // 如果不设置则无需鉴权

let browser;   // 当前可用的浏览器实例
let launching; // 正在启动浏览器时的 Promise（避免并发重复 launch）

// 判断浏览器实例是否仍处于连接状态。
// puppeteer v25 已把 `browser.isConnected()` 方法移除、改成 `browser.connected` getter，
// 这里两种都兼容，避免按 "latest" 装上新版 puppeteer 后直接抛 TypeError。
function isBrowserConnected(b) {
    if (typeof b.connected === 'boolean') return b.connected;
    if (typeof b.isConnected === 'function') return b.isConnected();
    return true;
}

// 获取（或启动）常驻浏览器实例
async function getBrowser() {
    if (browser && isBrowserConnected(browser)) return browser;
    if (launching) return launching;

    launching = puppeteer.launch({
        timeout: 60000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    }).then(instance => {
        browser = instance;
        // 浏览器进程意外退出时清空引用，下一个请求会自动重新拉起
        browser.on('disconnected', () => {
            if (browser === instance) browser = null;
        });
        console.log('✅ Browser instance initialized.');
        return browser;
    }).finally(() => {
        launching = null;
    });

    return launching;
}

// 关闭当前浏览器。渲染一旦报错就回收实例，下一个请求会用全新实例重来，
// 避免“运行一段时间后 Chromium 进入异常状态、只能手动重启”的情况。
async function recycleBrowser() {
    const old = browser;
    browser = null;
    if (old) {
        await old.close().catch(() => {});
        console.log('♻️ Browser instance recycled.');
    }
}

// 串行队列：同一时间只允许一次渲染。
// 之前每个请求都 newPage + 全页截图，多个请求并发时 Chromium 内存会被瞬间打满
// （docker-compose 里限制了 512M），内存一紧张，setContent 就容易 10s 超时。
let chain = Promise.resolve();
function serial(task) {
    const result = chain.then(() => task());
    chain = result.catch(() => {});
    return result;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 页面统一设置：
// - 关闭 JS，只做静态排版，防止邮件里的脚本干扰渲染
// - 用 request interception 屏蔽会拖慢/卡住渲染的外部资源（CSS/字体/脚本），
//   但保留远程图片正常加载。
//   之前用 Network.setBlockedURLs 把 http(s) 全部屏蔽，邮件 HTML 里远程引用的
//   图片（logo、插图等）也被一起屏蔽，导致渲染出的邮件图里这些位置全是破图“？”。
//   CSS/字体/脚本会阻塞 DOMContentLoaded/首屏，图片不会，所以只拦这几类即可，
//   需要 abort 的请求数量很少，不会像以前那样制造大量被中止的请求。
async function setupPage(page) {
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', request => {
        // 导航请求与 data: URI（内联 base64 图片等）一律放行
        if (request.isNavigationRequest() || request.url().startsWith('data:')) {
            request.continue();
            return;
        }
        const type = request.resourceType();
        if (type === 'stylesheet' || type === 'font' || type === 'script') {
            request.abort();
        } else {
            request.continue();
        }
    });
}

// 等待页面字体加载完成，最多 3 秒，超时则放弃等待使用后备字体
async function waitForFonts(page) {
    await Promise.race([
        page.evaluate(() => document.fonts.ready),
        new Promise(resolve => setTimeout(resolve, 3000))
    ]);
}

// 等待远程图片加载完成，最多 12 秒，超时则放弃。
// domcontentloaded 之后立刻截图会截到还没开始加载（或没加载完）的图片，显示为破图，
// 所以截图前要等图片 complete；对个别一直连不上的图片用 deadline 兜底，避免卡死。
async function waitForImages(page) {
    const deadline = Date.now() + 12000;
    for (;;) {
        const pending = await page.evaluate(() =>
            Array.from(document.images).filter(img => !img.complete).length
        );
        if (pending === 0) return;
        if (Date.now() >= deadline) {
            console.log(`⏳ Image load wait timed out with ${pending} image(s) still pending.`);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

// 渲染一张邮件图片
async function renderEmail(contentToRender) {
    const activeBrowser = await getBrowser();
    const page = await activeBrowser.newPage();
    try {
        // 对 Telegram 图片预览比较友好的宽度 + 高分屏渲染避免截图模糊
        await page.setViewport({
            width: 800,
            height: 600,
            deviceScaleFactor: 2
        });
        await setupPage(page);

        // 注入 HTML 内容，等待 DOM 就绪
        await page.setContent(contentToRender, {
            waitUntil: 'domcontentloaded',
            timeout: 15000
        });

        await waitForFonts(page);

        // 截图前等远程图片加载完成（否则邮件里的图片显示为破图）
        await waitForImages(page);

        // 强制白色背景（有些邮件 HTML 没写背景色，默认透明会导致文字看不清）
        await page.evaluate(() => {
            document.body.style.backgroundColor = 'white';
        });

        // 全页面截图
        return await page.screenshot({
            fullPage: true,
            type: 'png'
        });
    } finally {
        // 必须关闭页面，防止内存泄漏
        await page.close().catch(() => {});
    }
}

// 渲染接口
app.post('/', async (req, res) => {
    // Token 鉴权 (匹配 worker.js 的 Bearer Auth)
    if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).send('Unauthorized: Invalid or missing token');
    }

    // 提取数据
    const { html, text } = req.body || {};

    // 如果没有 html，则使用 text 并用 <pre> 包裹，保证纯文本也有合适的排版
    let contentToRender = html || (text ? `<pre style="white-space: pre-wrap; word-wrap: break-word; padding: 16px; font-family: sans-serif;">${escapeHtml(text)}</pre>` : '');

    if (!contentToRender) {
        return res.status(400).send('Bad Request: Both html and text are empty.');
    }

    try {
        // 串行执行渲染，避免并发请求把内存顶爆
        const imageBuffer = await serial(() => renderEmail(contentToRender));
        res.setHeader('Content-Type', 'image/png');
        res.send(imageBuffer);
    } catch (error) {
        console.error('❌ Render error:', error);
        // 出错后回收浏览器，让下一个请求从干净实例开始，避免持续超时
        await recycleBrowser();
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
});

// 优雅退出
async function closeBrowser() {
    if (browser) {
        await browser.close().catch(() => {});
    }
    process.exit(0);
}

process.on('SIGINT', closeBrowser);
process.on('SIGTERM', closeBrowser);

// 启动前冒烟自检：真实开页并渲染一次，确认 puppeteer API 与浏览器实例可用。
// 这类运行时问题（例如新版 puppeteer 移除 isConnected、浏览器起不来）此前要等第一封
// 邮件到达才暴露；自检让它们在启动阶段就报错并退出，由 docker 自动重启策略处理。
async function smokeTest() {
    const activeBrowser = await getBrowser();
    const page = await activeBrowser.newPage();
    try {
        await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
        await setupPage(page);
        await page.setContent('<h1>smoke test</h1>', { waitUntil: 'domcontentloaded' });
        const buf = await page.screenshot({ fullPage: true, type: 'png' });
        if (!buf || buf.length === 0) {
            throw new Error('smoke test produced an empty screenshot');
        }
    } finally {
        await page.close().catch(() => {});
    }
}

// 启动服务
smokeTest().then(() => {
    console.log('✅ Smoke test passed: browser can open a page and render.');
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Email Render Service is running on port ${PORT}`);
    });
}).catch(err => {
    console.error('❌ Startup self-check failed:', err);
    process.exit(1);
});
