.PHONY: install ci frontend verify build image up

install:
	cd frontend && npm install

# CI/线上同流程：按锁版本文件安装，依赖不漂移
ci:
	cd frontend && npm ci

frontend:
	cd frontend && npm run dev

verify:
	cd frontend && npm run verify

build:
	cd frontend && npm run build

# 同一流程构建部署：验证 → 构建 → 静态镜像
image:
	docker compose build

up:
	docker compose up -d
