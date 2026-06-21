// Cloudflare Worker Script for Forwarding Gmail to Telegram (Optimized)

/**
 * 类型定义辅助 - 消除编辑器报错
 *
 * @typedef {Object} Env
 * @property {string} TELEGRAM_BOT_TOKEN
 * @property {string} TELEGRAM_CHAT_ID
 * @property {string=} EMAIL_OUTPUT_MODE text/image，默认 text
 * @property {string=} EMAIL_RENDER_SERVICE_URL image 模式下使用的外部渲染服务地址
 * @property {string=} EMAIL_RENDER_SERVICE_TOKEN 可选，调用外部渲染服务时使用的 Bearer Token
 */

/**
 * @typedef {Object} EmailMessage
 * @property {string} from
 * @property {string} to
 * @property {Headers} headers
 * @property {ReadableStream} raw
 * @property {number} rawSize
 * @property {function} forward
 * @property {function} setReject
 */

/**
 * @typedef {Object} ExecutionContext
 * @property {function} waitUntil
 */

// Cloudflare Worker Script for Forwarding Gmail to Telegram (Optimized)
export default {
  /**
   * @param {EmailMessage} message
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    // 1. 检查环境变量
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
      return;
    }

    // 2. 获取基础信息
    const originalSender = message.headers.get("From") || message.from;
    const subject = message.headers.get("subject") || "(No Subject)";
    const recipientEmail = getRealRecipientEmail(message);

    console.log(`Processing email from: ${originalSender} to: ${recipientEmail}`);

    // 3. 提取内容
    const MAX_BYTES = 128 * 1024; // 提升读取上限到 128KB 以应对大邮件
    let rawBody = "";

    try {
      // 读取流
      const reader = message.raw.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
      let bytesRead = 0;

      while (bytesRead < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        rawBody += decoder.decode(value, { stream: true });
        bytesRead += value.byteLength;
      }
      rawBody += decoder.decode(); // Flush

    } catch (e) {
      console.error("Stream reading error:", e);
      rawBody = "[Error reading email stream]";
    }

    // 4. 解析并清理内容
    const contentType = message.headers.get("Content-Type") || "";
    const parsedContent = parseEmailContent(rawBody, contentType);
    let cleanContent = parsedContent.text || stripHtml(parsedContent.html) || "[No readable text found]";

    // 截断内容，保留足够空间给头部信息 (Telegram限制4096，预留1000给Header，正文留3000)
    if (cleanContent.length > 3000) {
      cleanContent = cleanContent.substring(0, 3000) + "\n...[Message Truncated]...";
    }

    // 5. 按配置发送消息。默认文字；图片模式失败时回退文字。
    const outputMode = getOutputMode(env);
    if (outputMode === "image") {
      await sendImageNotification(env, originalSender, recipientEmail, subject, {
        rawBody,
        contentType,
        html: parsedContent.html,
        text: cleanContent,
      });
      return;
    }

    await sendNotification(env, originalSender, recipientEmail, subject, cleanContent);
  },
};

// --- 配置 ---

function getOutputMode(env) {
  const mode = (env.EMAIL_OUTPUT_MODE || "text").toLowerCase().trim();
  if (mode === "text" || mode === "image") return mode;

  console.warn(`Unknown EMAIL_OUTPUT_MODE "${env.EMAIL_OUTPUT_MODE}", falling back to text.`);
  return "text";
}

// --- 核心逻辑函数 ---

/**
 * 发送通知，采用三级降级策略：MarkdownV2 -> HTML -> 纯文本
 */
async function sendNotification(env, from, to, subject, body) {
  // --- 尝试 1: MarkdownV2 (最美观，但对特殊字符最敏感) ---
  try {
    const header = `📬 *New Email* to \`${escapeMarkdown(to)}\`\n` +
                   `*From:* \`${escapeMarkdown(from)}\`\n` +
                   `*Subject:* \`${escapeMarkdown(subject)}\`\n` +
                   `━━━━━━━━━━━━━━━━━━\n`;

    // 使用代码块包裹正文，最安全
    const markdownBody = header + "```\n" + escapeCodeBlock(body) + "\n```";

    await sendToTelegram(env, markdownBody, "MarkdownV2");
    console.log("Sent via MarkdownV2");
    return; // 发送成功，直接结束
  } catch (e) {
    console.warn("MarkdownV2 send failed, retrying with HTML...", e.message);
  }

  // --- 尝试 2: HTML (容错率较高) ---
  try {
    // 必须转义 HTML 特殊字符，否则 Telegram 会报 400 错误
    const safeTo = escapeHtml(to);
    const safeFrom = escapeHtml(from);
    const safeSubject = escapeHtml(subject);
    const safeBody = escapeHtml(body);

    const htmlMsg = `<b>📬 New Email to</b> <code>${safeTo}</code>\n` +
                    `<b>From:</b> <code>${safeFrom}</code>\n` +
                    `<b>Subject:</b> <code>${safeSubject}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<pre>${safeBody}</pre>`; // <pre> 标签保留换行符

    await sendToTelegram(env, htmlMsg, "HTML");
    console.log("Sent via HTML fallback");
    return; // 发送成功，直接结束
  } catch (e) {
    console.warn("HTML send failed, retrying with Plain Text...", e.message);
  }

  // --- 尝试 3: 纯文本 (保底方案，肯定能发出去) ---
  const plainText = `📬 New Email to ${to}\n` +
                    `From: ${from}\n` +
                    `Subject: ${subject}\n` +
                    `------------------\n` +
                    body;

  try {
    await sendToTelegram(env, plainText, undefined); // undefined 不使用解析模式
    console.log("Sent via Plain Text fallback");
  } catch (e) {
    console.error("All send attempts failed. Please check Bot Token/Chat ID.", e);
  }
}

async function sendImageNotification(env, from, to, subject, content) {
  try {
    if (!env.EMAIL_RENDER_SERVICE_URL) {
      throw new Error("EMAIL_RENDER_SERVICE_URL is required when EMAIL_OUTPUT_MODE=image.");
    }

    const image = await renderEmailToImage(env, from, to, subject, content);
    await sendPhotoToTelegram(env, image, buildPhotoCaption(from, to, subject));
    console.log("Sent rendered email image");
  } catch (e) {
    console.warn("Image notification failed, falling back to text...", e.message);
    await sendNotification(env, from, to, subject, content.text);
  }
}

async function renderEmailToImage(env, from, to, subject, content) {
  const headers = { "Content-Type": "application/json" };
  if (env.EMAIL_RENDER_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${env.EMAIL_RENDER_SERVICE_TOKEN}`;
  }

  const response = await fetch(env.EMAIL_RENDER_SERVICE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to,
      subject,
      contentType: content.contentType,
      rawBody: content.rawBody,
      html: content.html,
      text: content.text,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Render service error ${response.status}: ${err}`);
  }

  const responseType = response.headers.get("Content-Type") || "";
  if (responseType.includes("application/json")) {
    const data = await response.json();
    if (!data || !data.base64) {
      throw new Error("Render service JSON response must include base64.");
    }

    return {
      bytes: base64ToUint8Array(data.base64),
      mimeType: data.mimeType || "image/png",
    };
  }

  if (!responseType.startsWith("image/")) {
    throw new Error(`Render service returned unsupported Content-Type: ${responseType || "unknown"}`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: responseType.split(";")[0],
  };
}

async function sendToTelegram(env, text, parseMode) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: text,
    disable_web_page_preview: true,
  };

  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`TG API Error ${response.status}: ${err}`);
  }
}

async function sendPhotoToTelegram(env, image, caption) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const formData = new FormData();
  const extension = getImageExtension(image.mimeType);

  formData.append("chat_id", env.TELEGRAM_CHAT_ID);
  formData.append("photo", new Blob([image.bytes], { type: image.mimeType }), `email.${extension}`);
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");

  const response = await fetch(url, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`TG Photo API Error ${response.status}: ${err}`);
  }
}

function buildPhotoCaption(from, to, subject) {
  const caption = `<b>📬 New Email to</b> <code>${escapeHtml(to)}</code>\n` +
                  `<b>From:</b> <code>${escapeHtml(from)}</code>\n` +
                  `<b>Subject:</b> <code>${escapeHtml(subject)}</code>`;

  // Telegram photo caption 限制为 1024 字符。
  return caption.length > 1024 ? caption.substring(0, 1021) + "..." : caption;
}

function getImageExtension(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

// --- 邮件解析工具 ---

function parseEmailBody(rawContent, mainContentType) {
  const parsed = parseEmailContent(rawContent, mainContentType);
  return parsed.text || stripHtml(parsed.html) || "[No readable text found]";
}

function parseEmailContent(rawContent, mainContentType) {
  // 1. 分离 Header 和 Body
  const { headersBlock, bodyBlock } = splitHeadersAndBody(rawContent);
  if (!headersBlock) {
    if (mainContentType.includes("text/html")) {
      return { html: rawContent.trim(), text: stripHtml(rawContent).trim() };
    }
    return { html: "", text: stripHtml(rawContent).trim() };
  }

  // 2. 检测传输编码 (Transfer-Encoding)
  const transferEncoding = getHeaderValue(headersBlock, "Content-Transfer-Encoding");

  // 3. 处理 Multipart
  if (mainContentType.includes("multipart/")) {
    const boundaryMatch = mainContentType.match(/boundary="?([^";\s]+)"?/i);
    if (boundaryMatch) {
      return extractContentFromMultipart(bodyBlock, "--" + boundaryMatch[1]);
    }
  }

  // 4. 处理单一部分 (Single Part)
  return decodeEmailPart(bodyBlock, transferEncoding, mainContentType);
}

function splitHeadersAndBody(content) {
  let headerEnd = content.indexOf("\r\n\r\n");
  let separatorLength = 4;
  if (headerEnd === -1) {
    headerEnd = content.indexOf("\n\n");
    separatorLength = 2;
  }

  if (headerEnd === -1) return { headersBlock: "", bodyBlock: content };

  return {
    headersBlock: content.substring(0, headerEnd),
    bodyBlock: content.substring(headerEnd + separatorLength),
  };
}

function extractFromMultipart(fullBody, boundary) {
  const parsed = extractContentFromMultipart(fullBody, boundary);
  return parsed.text || stripHtml(parsed.html) || "[No readable text found]";
}

function extractContentFromMultipart(fullBody, boundary) {
  const parts = fullBody.split(boundary);
  let htmlPart = "";
  let textPart = "";

  // 遍历所有部分，寻找 text/plain 和 text/html
  for (const part of parts) {
    if (part.trim().length < 5 || part.trim() === "--") continue; // 忽略结束符

    const { headersBlock, bodyBlock } = splitHeadersAndBody(part);
    if (!headersBlock) continue;

    const type = getHeaderValue(headersBlock, "Content-Type") || "";
    const encoding = getHeaderValue(headersBlock, "Content-Transfer-Encoding");
    const decoded = decodeTransferEncoding(bodyBlock, encoding);

    if (type.includes("text/plain")) {
      textPart += decoded.trim();
    } else if (type.includes("text/html")) {
      htmlPart += decoded.trim();
    }
  }

  // 优先返回纯文本，如果没有则返回处理过的 HTML
  return {
    html: htmlPart.trim(),
    text: textPart.trim() || stripHtml(htmlPart).trim(),
  };
}

function decodeAndClean(content, encoding, contentType) {
  const decoded = decodeTransferEncoding(content, encoding);

  // 如果是 HTML，去除标签
  if (contentType && contentType.includes("text/html")) {
    return stripHtml(decoded).trim();
  }

  return decoded.trim();
}

function decodeEmailPart(content, encoding, contentType) {
  const decoded = decodeTransferEncoding(content, encoding);

  if (contentType && contentType.includes("text/html")) {
    return {
      html: decoded.trim(),
      text: stripHtml(decoded).trim(),
    };
  }

  return {
    html: "",
    text: decoded.trim(),
  };
}

function decodeTransferEncoding(content, encoding) {
  if (encoding && encoding.toLowerCase().includes("base64")) {
    return decodeBase64(content);
  }

  if (encoding && encoding.toLowerCase().includes("quoted-printable")) {
    return decodeQuotedPrintable(content);
  }

  return content;
}

// --- 辅助工具函数 ---

function getRealRecipientEmail(message) {
  const headers = ["X-Original-To", "Delivered-To", "To"];
  for (const h of headers) {
    const val = message.headers.get(h);
    if (val) {
      const match = val.match(/[\w\.-]+@[\w\.-]+\.\w+/);
      if (match) return match[0];
    }
  }
  return message.to;
}

function getHeaderValue(block, name) {
  const regex = new RegExp(`^${name}:\\s*(.+)`, "im");
  const match = block.match(regex);
  return match ? match[1].trim() : null;
}

// HTML 转义函数 (Telegram HTML 模式只支持有限的标签，且必须转义以下字符)
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 鲁棒的 Base64 解码
function decodeBase64(str) {
  try {
    // 移除所有非 Base64 字符（如换行）
    const clean = str.replace(/[^A-Za-z0-9+/=]/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return `[Base64 Decode Error]`;
  }
}

function base64ToUint8Array(str) {
  const binary = atob(str.replace(/^data:image\/\w+;base64,/, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Quoted-Printable 解码
function decodeQuotedPrintable(str) {
  try {
    return str.replace(/=\r?\n/g, "")
              .replace(/=([a-fA-F0-9]{2})/g, (match, hex) =>
                String.fromCharCode(parseInt(hex, 16))
              );
    // 注意：这里简单的解码可能无法处理多字节字符（UTF-8 QP），
    // 但在无第三方库环境下这是最安全的折衷方案。
  } catch (e) {
    return str;
  }
}

// 简单的 HTML 标签去除
function stripHtml(html) {
  if (!html) return "";
  let text = html.replace(/<style([\s\S]*?)<\/style>/gi, "")
                 .replace(/<script([\s\S]*?)<\/script>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n")
             .replace(/<\/p>/gi, "\n\n")
             .replace(/<\/div>/gi, "\n");
  text = text.replace(/<[^>]+>/g, ""); // 移除所有标签
  text = text.replace(/&nbsp;/g, " ")
             .replace(/&amp;/g, "&")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">");
  return text.replace(/\n\s*\n/g, "\n\n").trim();
}

// MarkdownV2 转义
function escapeMarkdown(text) {
  if (!text) return "";
  // 需要转义: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// 代码块内容转义 (只需转义 ` 和 \)
function escapeCodeBlock(text) {
  if (!text) return "";
  return text.replace(/`/g, '\\`').replace(/\\/g, '\\\\');
}
