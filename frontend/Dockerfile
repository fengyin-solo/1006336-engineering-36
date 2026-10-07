# 生产镜像：本地开发与线上读同一份种子（src/data/seed-measured.ts 编进包内），
# 依赖按 package-lock.json 锁定安装，构建流程与仓库内 npm run build 完全一致。
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 数据层规则验证作为构建闸门：迁移/核对/落库规则不过，镜像不出。
RUN npm run verify
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /srv/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
