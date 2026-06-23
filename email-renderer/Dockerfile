FROM node:20-slim

# 安装 Chromium，并替换为 Noto CJK (完美支持各种字重) 和 Emoji 字体
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-cjk fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 核心环境变量：禁止 Puppeteer 下载自带的 Chrome，强制指定使用刚刚通过 apt 安装的系统级 Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

# 拷贝依赖配置并安装
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝主程序
COPY server.js ./

EXPOSE 3000

CMD ["npm", "start"]
