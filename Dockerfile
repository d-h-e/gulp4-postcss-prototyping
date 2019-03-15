FROM node:11.11.0-alpine

WORKDIR /starterfiles

RUN apk update && apk upgrade

COPY package.json package.json
RUN npm install && npm i -g yarn && npm i -g gulp
# ADD . ./starterfiles

EXPOSE 3020
