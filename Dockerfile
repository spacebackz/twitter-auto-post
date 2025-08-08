# Use an official Node.js runtime as a parent image
FROM node:18-bookworm-slim

# Set the working directory in the container
WORKDIR /app

# Install necessary dependencies for Puppeteer's bundled Chromium
RUN apt-get update \
    && apt-get install -yq --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libexpat1 \
    libfontconfig1 libgbm1 libgconf-2-4 libgdk-pixbuf2.0-0 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
    libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json to install dependencies
COPY package.json ./

# Install app dependencies
# The puppeteer install script will download a compatible browser
RUN npm install

# Bundle app source
COPY . .

# Defines the command to run your app
CMD ["node", "index.js"]
