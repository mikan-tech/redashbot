FROM mcr.microsoft.com/playwright:v1.46.1-focal

COPY package*.json /redashbot/
WORKDIR /redashbot
RUN npm ci --omit=dev

COPY . /redashbot

EXPOSE 3000
CMD ["npm", "start"]
