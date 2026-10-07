# 生产镜像：多阶段构建 —— 依赖锁定后本地与线上走同一流程。
# 1) 依赖安装严格按 package-lock.json（npm ci）
# 2) 数据层核对（npm run verify）不过则镜像构建失败
# 3) 类型检查 + 生产构建（npm run build）
# 4) 静态产物由 nginx 托管
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run verify && npm run build

FROM nginx:1.27-alpine
COPY --from=build /srv/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
