// Cloudflare Worker Script for Forwarding Gmail to Telegram (Revised & Fixed)

export default {
  /**
   * The email handler function is triggered when an email arrives
   * @param {EmailMessage} message - The email message object. See JSDoc below for rough structure.
   * @param {Env} env - Environment variables (including secrets).
   * @param {ExecutionContext} ctx - The execution context. See JSDoc below.
   */
  async email(message, env, ctx) {
    console.log(`Received email for: ${message.to}`);

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secret.");
      return;
    }

    const originalSender = message.headers.get("From") || message.from;
    console.log(`Original Sender Header: ${message.headers.get("From")}, Envelope Sender: ${message.from}`);
    const subject = message.headers.get("subject") || "No Subject";
    
    // 获取真实的目标邮箱地址
    const recipientEmail = getRealRecipientEmail(message);
    console.log(`Real recipient email: ${recipientEmail}`);

    let bodySnippet = "[Could not extract body snippet]";
    const MAX_BODY_SNIPPET_BYTES = 16384; // 增加读取的字节数以获得更好的预览
    const TARGET_SNIPPET_LENGTH = 800; // 增加目标长度以获得更好的预览

    try {
      const extractedContent = await extractEmailContent(
          message.raw,
          message.headers.get("Content-Type"),
          MAX_BODY_SNIPPET_BYTES
      );
      
      // 生成格式化的邮件内容预览
      bodySnippet = formatEmailPreview(extractedContent, TARGET_SNIPPET_LENGTH);
      console.log("Extracted email content successfully.");
    } catch (e) {
      console.error("Error extracting email content:", e.message, e.stack);
    }

    // 修改标题以包含邮箱地址
    let telegramMessage = `📬 *New Email Received* : \`${escapeMarkdown(recipientEmail)}\`\n\n`;
    telegramMessage += `*From:* \`${escapeMarkdown(originalSender)}\`\n`;
    telegramMessage += `*Subject:* \`${escapeMarkdown(subject)}\`\n`;
    telegramMessage += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    // 使用可折叠的格式显示邮件内容
    telegramMessage += bodySnippet;

    try {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramMessage);
      console.log("Successfully sent notification to Telegram.");
    } catch (error) {
      console.error("Failed to send Telegram message:", error.message);
    }
  },
};

// 新增函数：获取真实的收件人邮箱地址
function getRealRecipientEmail(message) {
  // 尝试从不同的邮件头部字段获取真实的收件人地址
  const possibleHeaders = [
    "X-Original-To",        // 常见的原始收件人头部
    "Delivered-To",         // Gmail等使用的头部
    "X-Envelope-To",        // 信封收件人
    "X-Final-Recipient",    // 最终收件人
    "To",                   // 标准收件人头部
    "Cc",                   // 抄送
    "Bcc"                   // 密送
  ];

  for (const header of possibleHeaders) {
    const value = message.headers.get(header);
    if (value) {
      // 提取邮箱地址（处理可能的显示名称）
      const emailMatch = value.match(/[\w\.-]+@[\w\.-]+\.\w+/);
      if (emailMatch) {
        console.log(`Found recipient email in ${header}: ${emailMatch[0]}`);
        return emailMatch[0];
      }
    }
  }

  // 如果都找不到，返回转发地址
  console.log("Could not find real recipient email, using forwarding address");
  return message.to;
}

// 新增函数：格式化邮件内容预览
function formatEmailPreview(content, maxLength) {
  if (!content || content.trim() === "") {
    return "*Preview:* _\\(Empty email content\\)_";
  }

  let preview = content.trim();
  
  // 检测是否为HTML内容
  const isHtml = preview.includes('<') && preview.includes('>');
  
  if (isHtml) {
    // 如果是HTML，进行基本的格式化
    preview = formatHtmlPreview(preview);
  } else {
    // 纯文本格式化
    preview = formatPlainTextPreview(preview);
  }

  // 截取适当长度
  // const shortPreview = preview.length > 200 ? preview.substring(0, 200) + "..." : preview;
  const fullPreview = preview.length > maxLength ? preview.substring(0, maxLength) + "..." : preview;
  return `*Preview:*\n${escapeMarkdown(preview)}`;
  // 如果内容较短，直接显示
  /*if (preview.length <= 200) {
    return `*Preview:*\n${escapeMarkdown(preview)}`;
  }

  // 创建可折叠的格式
  let formattedPreview = `*Preview:*\n`;
  formattedPreview += `${escapeMarkdown(shortPreview)}\n\n`;
  formattedPreview += `||_Click to expand full content_||\n`;
  formattedPreview += `||${escapeMarkdown(fullPreview)}||`;

  return formattedPreview;*/
}

// 新增函数：格式化HTML预览
function formatHtmlPreview(htmlContent) {
  let text = htmlContent;
  
  // 保留段落结构
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<\/li>/gi, "\n");
  
  // 处理标题
  text = text.replace(/<h[1-6][^>]*>/gi, "\n**");
  text = text.replace(/<\/h[1-6]>/gi, "**\n");
  
  // 处理加粗和斜体
  text = text.replace(/<(strong|b)[^>]*>/gi, "**");
  text = text.replace(/<\/(strong|b)>/gi, "**");
  text = text.replace(/<(em|i)[^>]*>/gi, "_");
  text = text.replace(/<\/(em|i)>/gi, "_");
  
  // 处理链接
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "[$2]($1)");
  
  // 移除其他HTML标签
  text = text.replace(/<[^>]*>/g, "");
  
  // 解码HTML实体
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
  
  // 清理多余空白
  text = text.replace(/\n\s*\n/g, "\n\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  
  return text.trim();
}

// 新增函数：格式化纯文本预览
function formatPlainTextPreview(textContent) {
  let text = textContent;
  
  // 检测并格式化可能的标题行（全大写或以特定符号开头）
  text = text.replace(/^([A-Z\s]{5,})\s*$/gm, "**$1**");
  text = text.replace(/^([-=*]{3,})\s*$/gm, "━━━━━━━━━━━━━━━━━━━━━━━━");
  
  // 检测并格式化可能的列表项
  text = text.replace(/^[\s]*[-*•]\s/gm, "• ");
  text = text.replace(/^[\s]*\d+\.\s/gm, match => `${match.trim()} `);
  
  // 检测并格式化可能的引用
  text = text.replace(/^>\s/gm, "▶ ");
  
  // 保持段落结构
  text = text.replace(/\n\s*\n/g, "\n\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  
  return text.trim();
}

// 新增函数：提取邮件内容（改进版）
async function extractEmailContent(rawStream, contentTypeHeader, maxBytesToRead) {
  const reader = rawStream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let rawContent = "";
  let bytesRead = 0;

  // 读取邮件原始内容
  while (bytesRead < maxBytesToRead) {
    const { done, value } = await reader.read();
    if (done) break;
    rawContent += decoder.decode(value, { stream: true });
    bytesRead += value.byteLength;
  }
  rawContent += decoder.decode();
  reader.releaseLock();

  console.log(`Read ${bytesRead} bytes for content extraction.`);

  // 分离头部和正文
  let headersEndPos = rawContent.indexOf("\r\n\r\n");
  if (headersEndPos === -1) headersEndPos = rawContent.indexOf("\n\n");
  
  if (headersEndPos === -1) {
    console.log("Could not find headers separator, treating as plain text");
    return cleanTextContent(rawContent);
  }

  const headersPart = rawContent.substring(0, headersEndPos);
  const bodyPart = rawContent.substring(headersEndPos + (rawContent[headersEndPos + 2] === '\r' ? 4 : 2));

  console.log("Headers part length:", headersPart.length);
  console.log("Body part length:", bodyPart.length);

  // 解析内容类型
  const mainContentType = (contentTypeHeader || "").toLowerCase();
  const mainEncoding = (getHeaderValue(headersPart, "Content-Transfer-Encoding") || "7bit").toLowerCase();
  
  console.log("Main content type:", mainContentType);
  console.log("Main encoding:", mainEncoding);

  let extractedContent = "";

  if (mainContentType.includes("multipart/")) {
    extractedContent = extractMultipartContent(bodyPart, mainContentType);
  } else if (mainContentType.includes("text/")) {
    extractedContent = extractSinglePartContent(bodyPart, mainContentType, mainEncoding);
  } else {
    console.log("Unknown content type, attempting text extraction");
    extractedContent = extractSinglePartContent(bodyPart, "text/plain", mainEncoding);
  }

  return cleanTextContent(extractedContent);
}

// 新增函数：提取多部分邮件内容
function extractMultipartContent(bodyPart, contentType) {
  const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
  if (!boundaryMatch) {
    console.log("Multipart email but no boundary found");
    return bodyPart;
  }

  const boundary = "--" + boundaryMatch[1];
  const parts = bodyPart.split(boundary);
  
  console.log(`Found ${parts.length} parts in multipart email`);

  let bestContent = "";
  let priority = 0; // 0=none, 1=html, 2=plain text

  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i].trim();
    if (!part) continue;

    const partHeadersEnd = part.indexOf("\r\n\r\n");
    if (partHeadersEnd === -1) continue;

    const partHeaders = part.substring(0, partHeadersEnd);
    const partBody = part.substring(partHeadersEnd + 4);

    const partContentType = (getHeaderValue(partHeaders, "Content-Type") || "").toLowerCase();
    const partEncoding = (getHeaderValue(partHeaders, "Content-Transfer-Encoding") || "7bit").toLowerCase();

    console.log(`Part ${i}: Content-Type=${partContentType}, Encoding=${partEncoding}`);

    if (partContentType.includes("text/plain") && priority < 2) {
      bestContent = decodeContent(partBody, partEncoding);
      priority = 2;
      console.log("Found plain text part, using as best content");
    } else if (partContentType.includes("text/html") && priority < 1) {
      bestContent = decodeContent(partBody, partEncoding);
      priority = 1;
      console.log("Found HTML part, using as fallback content");
    }
  }

  return bestContent || "[No suitable text content found]";
}

// 新增函数：提取单部分邮件内容
function extractSinglePartContent(bodyPart, contentType, encoding) {
  console.log(`Extracting single part content: ${contentType}, ${encoding}`);
  
  const decodedContent = decodeContent(bodyPart, encoding);
  
  if (contentType.includes("text/html")) {
    console.log("Converting HTML to text");
    return stripHtml(decodedContent);
  }
  
  return decodedContent;
}

// 新增函数：清理文本内容
function cleanTextContent(content) {
  if (!content) return "[Empty content]";
  
  let cleaned = content.trim();
  
  // 移除邮件客户端添加的常见签名分隔符
  cleaned = cleaned.replace(/^--\s*$/gm, "");
  
  // 移除过多的空行
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, "\n\n");
  
  // 移除行首尾空白
  cleaned = cleaned.replace(/^[ \t]+|[ \t]+$/gm, "");
  
  // 移除常见的邮件头部信息（如果意外包含）
  cleaned = cleaned.replace(/^(From|To|Subject|Date|Message-ID|Content-Type|MIME-Version):\s*.+$/gim, "");
  
  // 移除空行
  cleaned = cleaned.replace(/^\s*$/gm, "");
  cleaned = cleaned.replace(/\n+/g, "\n");
  
  return cleaned.trim() || "[No readable content found]";
}

async function sendTelegramMessage(botToken, chatId, text) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
    };

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.text();
        console.error("Telegram API Payload:", JSON.stringify(payload));
        throw new Error(`Telegram API error: ${response.status} ${response.statusText} - ${errorData}`);
    }
    return response;
}

async function extractTextSnippet(rawStream, contentTypeHeader, maxBytesToRead, targetSnippetLength) {
  const reader = rawStream.getReader();
  // FIX: Added ignoreBOM: true
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let rawContent = "";
  let bytesRead = 0;

  while (bytesRead < maxBytesToRead) {
    const { done, value } = await reader.read();
    if (done) break;
    rawContent += decoder.decode(value, { stream: true });
    bytesRead += value.byteLength;
  }
  rawContent += decoder.decode();
  reader.releaseLock();

  console.log(`Read ${bytesRead} bytes for snippet extraction.`);

  let body = "";
  let headersEndPos = rawContent.indexOf("\r\n\r\n");
  if (headersEndPos === -1) headersEndPos = rawContent.indexOf("\n\n");
  if (headersEndPos === -1) {
    console.log("Could not find end of headers.");
    // If no headers found, assume entire content might be body (e.g., simple text email)
    body = rawContent; // Use raw content directly
    // Attempt decoding based on potential overall encoding if available, else assume UTF-8/pass-through
    const mainEncoding = (getHeaderValue(contentTypeHeader || '', "Content-Transfer-Encoding") || "7bit").toLowerCase(); // Check overall header passed in
     console.log("Assuming no headers, attempting decode with assumed encoding:", mainEncoding);
     body = decodeContent(body, mainEncoding); // Apply basic decoding
     return sanitizeAndTruncate(body, targetSnippetLength); // Sanitize and return directly
  }

  const headersPart = rawContent.substring(0, headersEndPos);
  let bodyPart = rawContent.substring(headersEndPos + (rawContent[headersEndPos + 2] === '\r' ? 4 : 2)); // Check for \r\n\r\n vs \n\n

  let mainContentType = (contentTypeHeader || "").toLowerCase();
  let mainEncoding = (getHeaderValue(headersPart, "Content-Transfer-Encoding") || "7bit").toLowerCase();

  if (mainContentType.includes("multipart/")) {
    const boundaryMatch = mainContentType.match(/boundary="?([^"]+)"?/);
    if (!boundaryMatch) {
      console.log("Multipart email but no boundary found.");
       body = decodeContent(bodyPart.substring(0, maxBytesToRead), mainEncoding);
       return sanitizeAndTruncate(body, targetSnippetLength);
    }
    const boundary = "--" + boundaryMatch[1];
    const parts = bodyPart.split(boundary);

    let plainTextPart = "";
    let htmlPart = "";

    for (let i = 1; i < parts.length -1; i++) {
      const partContent = parts[i].trim();
      const partHeadersEndPos = partContent.indexOf("\r\n\r\n");
       if (partHeadersEndPos === -1) continue;

      const partHeaders = partContent.substring(0, partHeadersEndPos);
      const partBody = partContent.substring(partHeadersEndPos + 4);

      const partContentType = (getHeaderValue(partHeaders, "Content-Type") || "").toLowerCase();
      const partEncoding = (getHeaderValue(partHeaders, "Content-Transfer-Encoding") || "7bit").toLowerCase();

      if (partContentType.startsWith("text/plain") && !plainTextPart) {
         console.log(`Found text/plain part (Encoding: ${partEncoding})`);
         plainTextPart = decodeContent(partBody, partEncoding);
         break;
      } else if (partContentType.startsWith("text/html") && !htmlPart) {
         console.log(`Found text/html part (Encoding: ${partEncoding})`);
         htmlPart = decodeContent(partBody, partEncoding);
      }
    }

    if (plainTextPart) {
        body = plainTextPart;
    } else if (htmlPart) {
        body = htmlPart; // 保留HTML内容，让formatEmailPreview处理
    } else {
       body = "[No suitable text part found in multipart]";
    }

  } else if (mainContentType.startsWith("text/plain")) {
    body = decodeContent(bodyPart, mainEncoding);
  } else if (mainContentType.startsWith("text/html")) {
    body = decodeContent(bodyPart, mainEncoding);
    // 不在这里strip HTML，让formatEmailPreview处理
  } else {
     console.log(`Unknown or non-text main content type: ${mainContentType}. Attempting basic decode.`);
     body = decodeContent(bodyPart, mainEncoding);
  }

  return sanitizeAndTruncate(body, targetSnippetLength);
}

function decodeContent(content, encoding) {
    if (encoding === "base64") {
        try {
            const binaryString = atob(content.replace(/\s/g, ''));
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }
            // FIX: Added ignoreBOM: true
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            return decoder.decode(bytes);
        } catch (e) {
            console.error("Base64 decoding failed:", e.message);
            return "[Base64 Decode Error]";
        }
    } else if (encoding === "quoted-printable") {
        return decodeQuotedPrintable(content);
    }
    return content;
}

function decodeQuotedPrintable(input) {
    let cleaned = input.replace(/=\r?\n/g, '');
    try {
        const bytes = [];
        for (let i = 0; i < cleaned.length; i++) {
            if (cleaned[i] === '=' && i + 2 < cleaned.length) {
                const hex = cleaned.substring(i + 1, i + 3);
                const byteVal = parseInt(hex, 16);
                if (!isNaN(byteVal)) {
                    bytes.push(byteVal);
                    i += 2;
                } else {
                    bytes.push(cleaned.charCodeAt(i));
                }
            } else {
                bytes.push(cleaned.charCodeAt(i));
            }
        }
        // FIX: Added ignoreBOM: true (though less likely needed here, keep consistent)
        const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
        return decoder.decode(new Uint8Array(bytes));
    } catch(e) {
        console.error("Quoted-Printable decoding error:", e);
        // Basic fallback regex replace
        return cleaned.replace(/=([A-F0-9]{2})/gi, (match, hex) => {
            try { return String.fromCharCode(parseInt(hex, 16)); } catch { return match; }
        });
    }
}

// 改进HTML剥离函数
function stripHtml(html) {
  if (!html) return "";
  
  let text = html;
  
  // 移除样式和脚本
  text = text.replace(/<style[^>]*>.*?<\/style>/gis, "");
  text = text.replace(/<script[^>]*>.*?<\/script>/gis, "");
  
  // 处理常见的HTML结构，保留文本内容
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|ul|ol)[^>]*>/gi, "\n");
  text = text.replace(/<\/?(span|strong|b|em|i|u)[^>]*>/gi, " ");
  
  // 移除所有其他HTML标签
  text = text.replace(/<[^>]*>/g, "");
  
  // 解码HTML实体
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&hellip;/g, "...");
  
  // 清理空白字符
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\n\s*\n/g, "\n\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  
  return text.trim();
}

function sanitizeAndTruncate(text, maxLength) {
    if (!text) return "[No content extracted]";
    let cleaned = text.trim();
    cleaned = cleaned.replace(/(\r?\n\s*){3,}/g, "\n\n");
    cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
    return cleaned || "[Empty Body]";
}

function getHeaderValue(headersBlock, headerName) {
    const regex = new RegExp(`^${headerName}:\\s*(.+)`, "im");
    const match = headersBlock.match(regex);
    return match ? match[1].trim() : null;
}

function escapeMarkdown(text) {
  if (typeof text !== 'string') { text = String(text); }
  // Escaped chars: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
  // Note: Added escaping for \ itself
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}


// --- Simplified JSDoc Definitions (No Imports) ---
/**
 * Represents the incoming email message.
 * Structure is simplified for documentation.
 * @typedef {object} EmailMessage
 * @property {string} from - Envelope sender address.
 * @property {string} to - Recipient address (Worker's route).
 * @property {Headers} headers - Email headers object (like Fetch API Headers).
 * @property {ReadableStream} raw - Raw email content stream.
 * @property {number} rawSize - Size in bytes.
 * @property function forward
 * @property function setReject
 * @property function reply // Added for completeness, though not used here
 */
/**
 * Represents the environment bindings and secrets.
 * @typedef {object} Env
 * @property {string} TELEGRAM_BOT_TOKEN
 * @property {string} TELEGRAM_CHAT_ID
 * // Add other expected bindings here
 */
/**
 * Represents the execution context.
 * @typedef {object} ExecutionContext
 * @property {function} waitUntil
 * @property {function} passThroughOnException
 */
