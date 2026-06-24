const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
// 邮件 HTML 可能比较大，提高 JSON Body 解析限制
app.use(express.json({ limit: '10mb' }));

// 环境变量配置
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // 如果不设置则无需鉴权

let browser;

// 初始化常驻浏览器实例
async function initBrowser() {
    browser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // 解决 Docker 内存限制导致的崩溃
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    });
    console.log('✅ Browser instance initialized.');
}

// 渲染接口
app.post('/', async (req, res) => {
    // 1. 简单的 Token 鉴权 (匹配 worker.js 的 Bearer Auth)
    if (AUTH_TOKEN) {
        const authHeader = req.headers.authorization || '';
        if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
            return res.status(401).send('Unauthorized: Invalid or missing token');
        }
    }

    // 2. 提取数据
    const { html, text } = req.body;
    
    // 如果没有 html，则使用 text 并用 <pre> 包裹，保证纯文本也有合适的排版
    let contentToRender = html || (text ? `<pre style="white-space: pre-wrap; word-wrap: break-word; padding: 16px; font-family: sans-serif;">${text}</pre>` : '');

    if (!contentToRender) {
        return res.status(400).send('Bad Request: Both html and text are empty.');
    }

    let page;
    try {
        // 3. 打开新标签页
        page = await browser.newPage();
        
        // 设置一个友好的移动端/平板宽度（对 Telegram 图片预览比较友好）
        await page.setViewport({ 
            width: 800, 
            height: 600, 
            // 设置高分屏渲染，避免截图模糊
            deviceScaleFactor: 2
        });

        // 4. 注入 HTML 内容，等待内容加载完毕 (最多等 10 秒，避免死锁)
        await page.setContent(contentToRender, { 
            waitUntil: 'networkidle2', // 等待网络请求基本结束（允许有少量如跟踪像素失败）
            timeout: 10000 
        });

        // ================= 优雅修复：等待 Web 字体加载 =================
        // 让浏览器等待外部字体加载（如 Google Sans），最多等 3 秒。
        // 如果 3 秒后外部字体还没下载完（网络卡顿），浏览器会自动放弃等待并显示本地后备字体，这样截图就不会是空白了。
        await Promise.race([
            page.evaluate(() => document.fonts.ready),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
        // ===============================================================

        // 强制设置白色背景 (有些邮件 HTML 没写背景色，默认会变成透明导致字看不清)
        await page.evaluate(() => {
            document.body.style.backgroundColor = 'white';
        });

        // 5. 截图 (全页面截图)
        const imageBuffer = await page.screenshot({ 
            fullPage: true, 
            type: 'png' 
        });

        // 6. 返回图片流 (匹配 worker.js 中的需求)
        res.setHeader('Content-Type', 'image/png');
        res.send(imageBuffer);

    } catch (error) {
        console.error('❌ Render error:', error);
        res.status(500).send(`Internal Server Error: ${error.message}`);
    } finally {
        // 7. 必须关闭页面，防止内存泄漏
        if (page) {
            await page.close().catch(e => console.error('Failed to close page:', e));
        }
    }
});

// 优雅退出
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit(0);
});

// 启动服务
initBrowser().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Email Render Service is running on port ${PORT}`);
    });
});
