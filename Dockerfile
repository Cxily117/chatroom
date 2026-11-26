# 星火聊天室 · 单服务镜像（前端页面 + Express API + 云数据库）
#
# 一个容器同时提供：
#   /            → index.html（前端）
#   /api/*       → 后端接口
# 所以云托管创建服务时，「目标目录」填仓库根目录 .（不是 server），
# 服务端口填 80，访问端口填 80，一次部署全部搞定，不需要静态网站托管。

FROM node:18-alpine

WORKDIR /app

# 依赖单独一层，index.html 改动时不用重装依赖
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# 后端代码
COPY server/index.js ./index.js

# 前端页面：放到 /app/public，server/index.js 会自动识别这个目录
COPY index.html ./public/index.html

# 分开写，避免续行符在不同换行风格下解析出错
ENV PORT=80
ENV DB_DRIVER=cloudbase
ENV COLLECTION=chat_messages

EXPOSE 80

CMD ["node", "index.js"]
