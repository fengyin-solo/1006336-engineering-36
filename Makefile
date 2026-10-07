.PHONY: install verify build frontend image up

install:
	cd frontend && npm install

# 数据层核对：种子/迁移/核对清单/事务回滚，不过不允许构建上线
verify:
	cd frontend && npm run verify

build: verify
	cd frontend && npm run build

frontend:
	cd frontend && npm run dev

# 与线上相同的镜像构建流程（npm ci → verify → build → nginx 静态托管）
image:
	docker compose build

up:
	docker compose up -d
