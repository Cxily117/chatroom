# 星火聊天室后端 · 云托管镜像
# 云托管创建服务时：服务端口填 80，访问端口 80（与本文件 EXPOSE/ENV 一致）
FROM node:18-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存：index.js 改动时不必重装
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

# 分开写，避免续行符在不同换行风格下解析出错
ENV PORT=80
ENV DB_DRIVER=cloudbase
ENV COLLECTION=chat_messages

EXPOSE 80

CMD ["node", "index.js"]
