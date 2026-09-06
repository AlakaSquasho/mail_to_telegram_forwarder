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

// 获取（或启动）常驻浏览器实例
async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
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
// - 通过 CDP 在“发起请求前”就屏蔽所有 http(s) 子资源。
//   相比 page.setRequestInterception + request.abort()，这种方式不会在 CDP 通道里
//   制造海量“被拦截/被中止”的请求——大量 abort 正是 puppeteer 偶发
//   `Navigation timeout`（setContent 卡死）的常见诱因之一。
async function setupPage(page) {
    await page.setJavaScriptEnabled(false);
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    await client.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
}

// 等待页面字体加载完成，最多 3 秒，超时则放弃等待使用后备字体
async function waitForFonts(page) {
    await Promise.race([
        page.evaluate(() => document.fonts.ready),
        new Promise(resolve => setTimeout(resolve, 3000))
    ]);
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

// 启动服务
getBrowser().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Email Render Service is running on port ${PORT}`);
    });
});
