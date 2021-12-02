FROM mcr.microsoft.com/playwright:focal

COPY . /redashbot
WORKDIR /redashbot

RUN npm i

EXPOSE 3000
CMD ["npm", "start"]
