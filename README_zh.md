# mail_to_telegram_forwarder

将邮件转发到 Telegram 机器人以实现实时推送或多邮箱消息聚合。此功能以 Cloudflare Workers 实现。

### English

- [README.md](./README.md)

## Cloudflare 部署与域名配置

### 1. 接入域名

1. 在 Cloudflare 中添加域名
2. 到域名注册商修改 NS 为 Cloudflare 指定值
3. 等待域名状态变为 `Active`

### 2. 部署 Worker

#### 方式 A：Cloudflare 控制台

1. 打开 **Workers & Pages**
2. 创建 Worker
3. 粘贴 `worker.js` 内容
4. 保存并部署

#### 方式 B：Wrangler

```bash
npx wrangler login
npx wrangler deploy worker.js
```

### 3. 配置 Worker 变量

在 Worker 的 **Settings / Variables** 中添加：

必填：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

可选：

- `EMAIL_OUTPUT_MODE`
- `EMAIL_RENDER_SERVICE_URL`
- `EMAIL_RENDER_SERVICE_TOKEN`

### 4. 启用 Email Routing

1. 进入域名控制台
2. 打开 **Email**
3. 启用 **Email Routing**

### 5. 配置 DNS

按 Cloudflare Email Routing 页面提示添加记录：

- MX
- TXT

### 6. 创建 Email Routing 规则

1. 在 Email Routing 中创建规则
2. 填写 Cloudflare 收件地址，例如：`notify@yourdomain.com` 或 `*@yourdomain.com`
3. 动作选择 **Send to Worker**
4. 选择已部署的 Worker

### 7. 发送测试邮件

1. 向 Cloudflare 收件地址发送测试邮件
2. 检查 Telegram 是否收到消息

### 8. 排查顺序

1. 检查 Email Routing 是否启用
2. 检查 MX / TXT 是否生效
3. 检查 Email Routing 规则是否命中 Cloudflare 收件地址
4. 检查 Email Routing 规则是否绑定到正确的 Worker
5. 检查 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`
6. 检查 Telegram 机器人是否有目标会话发送权限

### 9. 为源邮箱启用转发

1. 在邮箱服务商后台打开源邮箱的转发设置
2. 添加 Cloudflare 收件地址作为转发目标
3. 按邮箱服务商要求完成转发验证
4. 启用转发
5. 再次发送测试邮件，检查 Telegram 是否收到转发内容

## 图片渲染服务接口

示例图片渲染服务位于仓库中的 `email-renderer/` 目录，可作为 `EMAIL_RENDER_SERVICE_URL` 对应服务的参考实现。

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
