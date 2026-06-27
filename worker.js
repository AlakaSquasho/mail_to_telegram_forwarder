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
 * @property {string=} IMAGE_MAX_DIMENSION 可选，图片模式下的最大宽高限制，超过则发送为文件，默认 3000
 * @property {string=} IMAGE_MAX_FILESIZE 可选，图片模式下的最大文件大小限制，超过则发送为文件，默认 2.5MB
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
    let originalSender = message.headers.get("From") || message.from;
    let subject = message.headers.get("subject") || "(No Subject)";
    
    // 增加：自动解码 RFC 2047 格式的标题和发件人名称 (处理中文 Base64/QP 编码)
    originalSender = decodeRFC2047(originalSender);
    subject = decodeRFC2047(subject);

    const recipientEmail = getRealRecipientEmail(message);

    console.log(`Processing email from: ${originalSender} to: ${recipientEmail}`);

    // 3. 提取内容
    const MAX_BYTES = 1024 * 1024; // 提升读取上限到 1MB 以应对大邮件
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
    const rootEncoding = message.headers.get("Content-Transfer-Encoding") || "";
    const parsedContent = parseEmailContent(rawBody, contentType, rootEncoding);
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
  // 1. 获取图片实际尺寸
  const dimensions = getImageDimensions(image.bytes, image.mimeType);
  
  // 2. 判断发送策略（设置阈值为长或宽 3000 像素）
  // Telegram 如果高度超长，会严重压缩模糊，这里一旦超过就转为文件
  const MAX_DIMENSION = env.IMAGE_MAX_DIMENSION ? parseInt(env.IMAGE_MAX_DIMENSION) : 3000;
  const MAX_FILESIZE = env.IMAGE_MAX_FILESIZE ? parseInt(env.IMAGE_MAX_FILESIZE) : 2.5 * 1024 * 1024;
  let sendAsDocument = false;

  if (dimensions) {
    console.log(`Rendered Image Size: ${dimensions.width} x ${dimensions.height}`);
    if (dimensions.width > MAX_DIMENSION || dimensions.height > MAX_DIMENSION) {
      sendAsDocument = true;
    }
  } else {
    // 降级方案：如果尺寸解析失败，但文件超过 2.5MB，也保守视为长图发送
    if (image.bytes.byteLength > MAX_FILESIZE) {
      sendAsDocument = true;
    }
  }

  // 3. 根据判断结果，动态选择发送的 API 路径和表单字段名
  const apiMethod = sendAsDocument ? "sendDocument" : "sendPhoto";
  const fieldName = sendAsDocument ? "document" : "photo";

  console.log(`Sending to Telegram via: ${apiMethod}`);

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${apiMethod}`;
  const formData = new FormData();
  const extension = getImageExtension(image.mimeType);

  formData.append("chat_id", env.TELEGRAM_CHAT_ID);
  formData.append(fieldName, new Blob([image.bytes], { type: image.mimeType }), `email.${extension}`);
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");

  const response = await fetch(url, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`TG ${apiMethod} API Error ${response.status}: ${err}`);
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

function parseEmailContent(rawContent, mainContentType, rootEncoding = "") {
  // 1. 分离 Header 和 Body
  const { headersBlock, bodyBlock } = splitHeadersAndBody(rawContent);
  if (!headersBlock) {
    if (mainContentType.includes("text/html")) {
      return { html: rawContent.trim(), text: stripHtml(rawContent).trim() };
    }
    return { html: "", text: stripHtml(rawContent).trim() };
  }

  // 2. 检测传输编码 (当前块没有时，回退使用根节点的 Encoding)
  const transferEncoding = getHeaderValue(headersBlock, "Content-Transfer-Encoding") || rootEncoding;

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

  // 遍历所有部分，寻找 text/plain、text/html 以及嵌套的 multipart
  for (const part of parts) {
    if (part.trim().length < 5 || part.trim() === "--") continue; // 忽略结束符

    const { headersBlock, bodyBlock } = splitHeadersAndBody(part);
    if (!headersBlock) continue;

    const type = getHeaderValue(headersBlock, "Content-Type") || "";
    const encoding = getHeaderValue(headersBlock, "Content-Transfer-Encoding");

    // ====================================================================
    // 【核心修复】递归处理嵌套的 multipart
    // ====================================================================
    if (type.toLowerCase().includes("multipart/")) {
      // 将当前整个 part (包含 headers 和 body) 作为独立的邮件结构继续向下解析
      const nestedContent = parseEmailContent(part.trim(), type, encoding);
      if (nestedContent.html) htmlPart += nestedContent.html + "\n";
      if (nestedContent.text) textPart += nestedContent.text + "\n";
      continue;
    }

    // 处理普通的文本或 HTML 节点
    const charsetMatch = type.match(/charset=["']?([\w-]+)["']?/i);
    const charset = charsetMatch ? charsetMatch[1] : "utf-8";

    // 传入 charset 进行精准解码
    const decoded = decodeTransferEncoding(bodyBlock, encoding, charset);

    if (type.toLowerCase().includes("text/plain")) {
      textPart += decoded.trim() + "\n";
    } else if (type.toLowerCase().includes("text/html")) {
      htmlPart += decoded.trim() + "\n";
    }
  }

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
  // 【新增】智能提取字符集
  const charsetMatch = (contentType || "").match(/charset=["']?([\w-]+)["']?/i);
  const charset = charsetMatch ? charsetMatch[1] : "utf-8";

  const decoded = decodeTransferEncoding(content, encoding, charset);

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

function decodeTransferEncoding(content, encoding, charset = "utf-8") {
  const encLower = (encoding || "").toLowerCase();

  if (encLower.includes("base64")) {
    return decodeBase64(content, charset);
  }

  if (encLower.includes("quoted-printable")) {
    return decodeQuotedPrintable(content, charset);
  }

  // 【新增核心修复】启发式检测 Quoted-Printable
  if (!encLower) {
    // 特征：如果正文中包含 "=3D" (HTML中常见的 =' 等号被转义) 或者是 "=E4" 的十六进制，并含有软换行 "=\r\n"
    const looksLikeQP = (content.includes("=3D") || /=[0-9A-F]{2}/i.test(content)) && /=\r?\n/.test(content);
    if (looksLikeQP) {
      return decodeQuotedPrintable(content, charset);
    }
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

// 解码邮件头中的 RFC 2047 编码 (例如 =?UTF-8?B?...?=)
function decodeRFC2047(text) {
  if (!text) return "";
  // 移除相邻编码词之间的多余空格（符合 RFC 2047 规范）
  let processedText = text.replace(/\?=\s+=\?/g, "?==?");

  return processedText.replace(/=\?([\w-]+)\?([B|Q|b|q])\?([^?]+)\?=/g, (match, charset, encoding, data) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return decodeBase64(data, charset);
      } else if (encoding.toUpperCase() === "Q") {
        // RFC 2047 的 Q 编码中，下划线 '_' 代表空格
        const qData = data.replace(/_/g, " ");
        return decodeQuotedPrintable(qData, charset);
      }
      return match;
    } catch (e) {
      return match;
    }
  });
}

// 鲁棒的 Base64 解码 (增加了对指定字符集的支持)
function decodeBase64(str, charset = "utf-8") {
  try {
    const clean = str.replace(/[^A-Za-z0-9+/=]/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    
    // 尝试使用邮件头声明的字符集，如果不支持则回退到 utf-8
    let decoder;
    try { decoder = new TextDecoder(charset.toLowerCase()); } 
    catch (e) { decoder = new TextDecoder("utf-8"); }
    
    return decoder.decode(bytes);
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

// Quoted-Printable 解码 (终极修复版：完美兼容原生 Emoji 和多字节隐藏字符)
function decodeQuotedPrintable(str, charset = "utf-8") {
  try {
    const cleanStr = str.replace(/=\r?\n/g, ""); // 移除软换行
    const bytes = [];
    const encoder = new TextEncoder(); // 用于将原生字符安全编码为 UTF-8 字节流
    
    for (let i = 0; i < cleanStr.length; i++) {
      // 处理标准的 =XX 转义序列
      if (cleanStr[i] === "=" && i + 2 < cleanStr.length) {
        const hex = cleanStr.substring(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      
      // 处理未转义的普通字符或原生多字节字符 (中文、Emoji、隐藏控制符等)
      const codePoint = cleanStr.codePointAt(i);
      const char = String.fromCodePoint(codePoint);
      const charBytes = encoder.encode(char);
      
      for (let j = 0; j < charBytes.length; j++) {
        bytes.push(charBytes[j]);
      }
      
      // 如果是占用 4 个字节的 Surrogate Pair (如 Emoji)，需要跳过半个字符
      if (codePoint > 0xFFFF) {
        i++; 
      }
    }

    // 将组装好的纯净字节流还原为字符串
    let decoder;
    try { decoder = new TextDecoder(charset.toLowerCase()); } 
    catch (e) { decoder = new TextDecoder("utf-8"); }
    
    return decoder.decode(new Uint8Array(bytes));
  } catch (e) {
    return str; // 如果发生极其罕见的错误，原样返回保底
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

// 直接从图片的 Uint8Array 字节流中提取长宽尺寸
function getImageDimensions(bytes, mimeType) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (mimeType === "image/png") {
      // PNG 的宽和高固定在第 16 和 20 字节，采用大端序读取 (Big-Endian)
      return {
        width: dv.getUint32(16, false),
        height: dv.getUint32(20, false)
      };
    }

    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xFF) break;
        while (bytes[offset] === 0xFF) offset++; // 跳过填充
        const marker = bytes[offset++];
        const length = dv.getUint16(offset, false);
        // 匹配 SOFn (Start Of Frame) 标记，里面包含了高度和宽度
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return {
            height: dv.getUint16(offset + 3, false),
            width: dv.getUint16(offset + 5, false)
          };
        }
        offset += length;
      }
    }
  } catch (e) {
    console.error("Failed to parse image dimensions", e);
  }
  return null;
}