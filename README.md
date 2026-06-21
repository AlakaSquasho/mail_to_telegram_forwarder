# mail_to_telegram_forwarder

将邮件转发到telegram机器人以实现实时推送

---

此功能以cloudflare的workers实现。

## 配置

必填环境变量：

- `TELEGRAM_BOT_TOKEN`：Telegram Bot Token
- `TELEGRAM_CHAT_ID`：接收消息的 Telegram Chat ID

可选环境变量：

- `EMAIL_OUTPUT_MODE`：邮件内容输出形式，默认 `text`
  - `text`：按现有方式输出文字内容
  - `image`：调用外部渲染服务，将邮件内容渲染成图片后发送
- `EMAIL_RENDER_SERVICE_URL`：`EMAIL_OUTPUT_MODE=image` 时必填，外部邮件渲染服务地址
- `EMAIL_RENDER_SERVICE_TOKEN`：可选，调用外部渲染服务时通过 `Authorization: Bearer <token>` 发送

## 图片渲染服务接口

当 `EMAIL_OUTPUT_MODE=image` 时，Worker 会向 `EMAIL_RENDER_SERVICE_URL` 发送请求：

```http
POST <EMAIL_RENDER_SERVICE_URL>
Content-Type: application/json
Authorization: Bearer <EMAIL_RENDER_SERVICE_TOKEN> # 配置后才会发送
```

请求体示例：

```json
{
  "from": "sender@example.com",
  "to": "recipient@example.com",
  "subject": "邮件标题",
  "contentType": "text/html; charset=utf-8",
  "rawBody": "原始邮件内容",
  "html": "解析出的 HTML 内容",
  "text": "文字回退内容"
}
```

推荐渲染服务直接返回图片二进制：

- `Content-Type: image/png`、`image/jpeg` 或 `image/webp`
- Body 为图片字节

也支持 JSON 返回：

```json
{
  "mimeType": "image/png",
  "base64": "..."
}
```

如果图片渲染或发送失败，Worker 会自动回退到文字模式发送，避免通知丢失。
