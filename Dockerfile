FROM node:22.16.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
    libcups2 libgdk-pixbuf2.0-0 libnspr4 libnss3 libxss1 xdg-utils libgbm-dev libglib2.0-0 \
    libxrandr2 libgtk-3-0 libgtk-3-common libxcomposite1 libxcursor1 libxdamage1 libxext6 \
    libxfixes3 libxi6 libxrandr2 libxrender1 libxshmfence1 libxkbcommon0 -y

RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/trusted.gpg.d/google-chrome.gpg \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update -y && apt-get install google-chrome-stable -y

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome-stable"

CMD ["node", "index.js"]
