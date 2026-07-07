# mail_to_telegram_forwarder

Forward incoming emails to a Telegram bot for real-time notifications or multi-mailbox aggregation. Implemented with Cloudflare Workers.

[中文说明](./README_zh.md)

## Cloudflare deployment and domain setup

### 1. Add the domain to Cloudflare

1. Add the domain in Cloudflare
2. Update the nameservers at your domain registrar to the values assigned by Cloudflare
3. Wait until the domain status becomes `Active`

### 2. Deploy the Worker

#### Option A: Cloudflare dashboard

1. Open **Workers & Pages**
2. Create a Worker
3. Paste the contents of `worker.js`
4. Save and deploy

#### Option B: Wrangler

```bash
npx wrangler login
npx wrangler deploy worker.js
```

### 3. Configure Worker variables

Add the following in **Settings / Variables**:

Required:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional:

- `EMAIL_OUTPUT_MODE`
- `EMAIL_RENDER_SERVICE_URL`
- `EMAIL_RENDER_SERVICE_TOKEN`

### 4. Enable Email Routing

1. Open the domain dashboard
2. Open **Email**
3. Enable **Email Routing**

### 5. Configure DNS

Add the records shown on the Cloudflare Email Routing page:

- MX
- TXT

### 6. Create the Email Routing rule

1. Create a rule in Email Routing
2. Set the Cloudflare recipient address, for example: `notify@yourdomain.com` or `*@yourdomain.com`
3. Choose **Send to Worker**
4. Select the deployed Worker

### 7. Send a test email

1. Send a test email to the Cloudflare recipient address
2. Check whether Telegram receives the message

### 8. Troubleshooting order

1. Check whether Email Routing is enabled
2. Check whether MX / TXT records are active
3. Check whether the Email Routing rule matches the Cloudflare recipient address
4. Check whether the Email Routing rule is bound to the correct Worker
5. Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
6. Check whether the Telegram bot can send messages to the target chat

### 9. Enable forwarding for the source mailbox

1. Open the forwarding settings for the source mailbox in your mail provider
2. Add the Cloudflare recipient address as the forwarding target
3. Complete any verification required by the mail provider
4. Enable forwarding
5. Send another test email and check whether Telegram receives the forwarded content

## Image render service API

An example image render service is included in the repository under `email-renderer/`. It can be used as a reference implementation for the service pointed to by `EMAIL_RENDER_SERVICE_URL`.

When `EMAIL_OUTPUT_MODE=image`, the Worker sends a request to `EMAIL_RENDER_SERVICE_URL`:

```http
POST <EMAIL_RENDER_SERVICE_URL>
Content-Type: application/json
Authorization: Bearer <EMAIL_RENDER_SERVICE_TOKEN> # sent only when configured
```

Example request body:

```json
{
  "from": "sender@example.com",
  "to": "recipient@example.com",
  "subject": "Email subject",
  "contentType": "text/html; charset=utf-8",
  "rawBody": "Raw email body",
  "html": "Parsed HTML content",
  "text": "Plain-text fallback content"
}
```

Recommended response: return image bytes directly:

- `Content-Type: image/png`, `image/jpeg`, or `image/webp`
- Response body: raw image bytes

JSON response is also supported:

```json
{
  "mimeType": "image/png",
  "base64": "..."
}
```

If image rendering or image delivery fails, the Worker falls back to text mode automatically.
