FROM node:20-slim

# 更新源并安装 Chromium 以及中文字体包
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
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
