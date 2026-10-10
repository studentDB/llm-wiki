# 16 · Docker 部署

> 目标：把 LLM Wiki 跑在容器里，且**后续更新不需要在服务器上构建镜像**。
> 更新动作固定为三步：**打包 → 覆盖宿主机 `./app` → 重建容器**。
>
> **要操作步骤，请看 `docs/17-deployment-runbook.md`**（逐条命令 + 预期输出 + 排障表）。
> 本文件讲**为什么这么设计**。

---

## 0. 结论

| 问题 | 做法 |
| --- | --- |
| 镜像里放什么？ | **只放运行时**（Node 20 + pnpm + 预热好的 pnpm store + 编译好的 `node_modules`），**不放业务代码** |
| 代码从哪来？ | 宿主机 `./app` **bind mount** 覆盖容器内 `/app` |
| 怎么更新？ | 开发机打包 → 上传 → `./update.sh xxx.tgz`（自动备份、解压、`restart`、打日志） |
| 数据会丢吗？ | 不会。`wikis/` 与全局配置都在宿主机 `./data/` 下 |
| 依赖要重装吗？ | 不用。`node_modules` 在命名卷里，重建容器时 `pnpm install` 是 no-op（除非 lockfile 变了） |

---

## 1. 目录结构

服务器上的部署根（默认 `/srv/llm-wiki`）：

```
/srv/llm-wiki/
├── docker-compose.yml        # 本仓库根目录同名文件
├── Dockerfile                # 本仓库根目录同名文件
├── docker-entrypoint.sh      # 容器启动前置逻辑
├── update.sh                 # 服务端一键更新 + 回滚提示
├── .dockerignore             # 构建上下文过滤（尤其排除 data/ 与 .env*）
├── app/                      # ← 每次更新就是整体替换这里
│   ├── apps/web/
│   ├── packages/
│   ├── package.json
│   ├── pnpm-workspace.yaml
│   └── pnpm-lock.yaml
└── data/
    ├── wikis/                # wiki 内容（核心资产，持久化）
    └── config/               # ~/.llm-wiki 的替代位置（activeWiki、密钥兜底）
```

> ⚠️ 部署工具包（上面前 5 个文件）**必须放在 `/srv/llm-wiki/` 根目录，不能放进 `./app`**。
> `update.sh` 会整体搬走 `./app`，工具包留在里面会把自己一起弄丢。

> `apps/web/.env.local` **不进发布包**，由运维在 `./app/apps/web/.env.local` 单独维护；`update.sh` 在覆盖前会自动从备份里把它带回来。

### 1.1 为什么源码在 `./app` 里而 Dockerfile 在外面

两者的目录层级不一样，Dockerfile 里用 `ARG APP_SRC` 吸收了这个差异：

| 构建位置 | 布局 | 取值 |
| --- | --- | --- |
| **服务器部署根**（主用法） | 源码在 `./app/` | `APP_SRC=app`（Dockerfile 默认值，compose 里也显式写了） |
| 开发机仓库根 | 源码在 `./` | `docker build --build-arg APP_SRC=. .` |

如果 `APP_SRC` 写错，症状是构建期 `COPY pnpm-lock.yaml: not found`，**发生在构建阶段，不会拖到线上才炸**——这是刻意选的失败模式。

---

## 2. 首次部署

```bash
# 1) 建部署目录
mkdir -p /srv/llm-wiki/data/wikis /srv/llm-wiki/data/config
cd /srv/llm-wiki

# 2) 放代码：把开发机上 pack-for-deploy.ps1 产出的 tgz 解开
#    （压缩包内已带 app/ 顶层目录，故用 --strip-components=1 解到 ./app）
mkdir -p app
tar -xzf llm-wiki-app.tgz -C app --strip-components=1

# 3) 把部署工具包提到部署根 —— 它必须活过 ./app 的整体替换
cp app/Dockerfile app/docker-compose.yml app/docker-entrypoint.sh app/update.sh /srv/llm-wiki/
cp app/.dockerignore /srv/llm-wiki/ 2>/dev/null || true
chmod +x update.sh          # git 不保留执行位，首次需要手动加

# 4) 密钥（不要提交进代码包）
cp /path/to/your/.env.local app/apps/web/.env.local

# 5) 建镜像并起容器
docker compose up -d --build

# 6) 看日志
docker compose logs -f wiki
```

浏览器打开 `http://<服务器IP>:3737`。
完整步骤（含前置检查、验收、回滚）见 `docs/17-deployment-runbook.md`。

---

## 3. 日常更新（核心诉求）

**开发机（Windows，PowerShell）：**

```powershell
cd E:\CodeRepository\CodeTest\llm-wiki
git add -A && git commit -m "..."     # 先提交：打包用的是 git 已跟踪文件
.\pack-for-deploy.ps1                 # 产出 llm-wiki-app.tgz
```

**服务器：**

```bash
cd /srv/llm-wiki
./update.sh /path/to/llm-wiki-app.tgz
```

`update.sh` 内部依次做：备份 `./app` → `app.bak.<时间戳>` → 解压覆盖 → 从备份续回 `.env.local` → `docker compose up -d --force-recreate wiki` → 打印日志与回滚命令。

> 这里必须是 `--force-recreate` 而不是 `restart`：备份用的是 `mv`，`./app` 已经是**另一个 inode** 的新目录，部分 Docker 版本下 `restart` 会复用原容器的挂载命名空间继续读旧树，表现为"更新没生效"。

因为 `node_modules` 与 `.next` 都在**命名卷**里，这一步是**增量**的：依赖没变就不装，代码增量编译。

**回滚**（脚本结尾会打印，把 `<TS>` 换成实际时间戳）：

```bash
cd /srv/llm-wiki
rm -rf app && mv app.bak.<TS> app
docker compose up -d --force-recreate wiki
```

> 用 `--force-recreate` 而不是 `stop`/`start`：回滚同样是整目录替换，必须让 Docker 重新解析 bind 源，否则新容器可能继续挂旧的（已被 `mv` 走的）inode。

---

## 4. 卷映射

| 宿主机 / 卷 | 容器内 | 内容 | 更新时被覆盖？ |
| --- | --- | --- | --- |
| `./app` | `/app` | 业务代码 | ✅ 是（正是我们要的） |
| `./data/wikis` | `/app/apps/web/wikis` | wiki 内容 | ❌ 否 |
| `./data/config` | `/data/llm-wiki-config` | `activeWiki`、recentWikis、密钥兜底 | ❌ 否 |
| `nm_root` 等 5 个命名卷 | `node_modules` | 依赖（含原生模块） | ❌ 否（有意隔离） |
| `next_build` 命名卷 | `/app/apps/web/.next` | 构建产物 + cache | ❌ 否（保证增量） |

### 为什么 node_modules 必须用命名卷

`better-sqlite3` 和 `keytar` 是**原生模块**，ABI 与编译它的 Node major 绑定：

- 开发机是 Windows + Node 22（PATH 上的版本），容器是 Linux + Node 20；
- 一旦把宿主机的 `node_modules` 挂进去，数据库模块加载必然失败。

命名卷还带来一个好处：**首次挂载时 Docker 会把镜像里已有的内容复制进卷**，所以第一次启动不需要重新下载依赖——构建期就装好了。

---

## 5. 环境变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `HOSTNAME` | `0.0.0.0` | **必须**。覆盖 Docker 注入的容器 ID，见下方「坑 1」 |
| `LLM_WIKI_HOST` | `0.0.0.0` | CLI / 配置层读取的绑定地址 |
| `PORT` | `3737` | 与 `ports` 右侧保持一致 |
| `LLM_WIKI_CONFIG` | `/app/apps/web/llm-wiki.config.json` | 绝对路径，避免 cwd 差异 |
| `LLM_WIKI_CONFIG_DIR` | `/data/llm-wiki-config` | 把 `~/.llm-wiki` 移到持久卷 |
| `WIKI_MODE` | `prod` / `dev` | `dev` = `next dev`，跳过构建 |
| `NO_UPDATE_NOTIFIER` | `1` | 容器里别查 npm registry |

---

## 6. 三个必须绕开的坑

### 坑 1：`HOSTNAME` 是 Docker 注入的容器 ID（致命）

Docker / K8s / 多数 PaaS 会自动注入 `HOSTNAME=<container id>`，而 Next 在没有 `-H` 参数时会回退读 `process.env.HOSTNAME` 作为绑定地址 → 服务器尝试绑到一个无法解析的主机名，表现为**启动就崩**。

本次已修代码：`apps/web/bin/llm-wiki.mjs` 不再透传 `HOSTNAME`，改为解析 `LLM_WIKI_HOST → config.server.host → 127.0.0.1`，并用结果**覆写** `HOSTNAME`，保证 `-H` 参数和环境变量不会打架。

compose 里仍然显式写了 `HOSTNAME: "0.0.0.0"` 作为二次保险（因为 `next start` 是我们直接启动、不经过 CLI 的）。

### 坑 2：原生模块 ABI

见 4.1。**不要把宿主机的 `node_modules` 打进发布包**，`pack-for-deploy.ps1` 已排除。

### 坑 3：容器端口漂移会导致映射失效

CLI 的 `findAvailablePort()` 在端口被占用时会**自动 +1**。容器里几乎没有别的进程，风险低，但一旦发生，`ports: "3737:3737"` 就会指向错误端口。

排查：`docker compose logs wiki | head`，看实际打印的是哪个端口。

---

## 7. 已知限制

1. **构建期需要访问 Google Fonts**。`app/layout.tsx` 用了 `next/font/google`，`next build` 时会去下载字体。国内服务器若无外网，构建会失败——解决方式：给构建阶段配代理（`HTTP_PROXY` / `HTTPS_PROXY` 构建参数），或改用本地字体文件。
2. **依赖变更仍需重建镜像**。改动 `package.json` / `pnpm-lock.yaml` 时，entrypoint 的 `pnpm install --frozen-lockfile` 会失败（lockfile 与 manifests 不一致）。此时需在服务器上 `docker compose up -d --build`，或先 `docker compose run --rm wiki pnpm install` 更新卷内依赖。
3. **`next build` 需在 Linux 环境执行**。本机（Windows + 沙箱）无法完成构建，该镜像**未在本机构建验证过**；首次部署请按第 2 节跑通后再对外提供服务。
4. **密钥不走 keychain**。容器内通常没有 keyring daemon，`keytar` 探测失败后会自动降级为文件存储（落在 `./data/config/config.json`）。功能正常，但密钥是明文落盘——请确保 `./data` 的目录权限受控。

---

## 8. 更新后自检清单

```bash
docker compose ps                      # 状态应为 Up (healthy)
docker compose logs --tail=100 wiki    # 无 ERROR / MODULE_NOT_FOUND

curl -s http://127.0.0.1:3737/api/wikis/health
curl -s http://127.0.0.1:3737/ | grep -o '<html lang="[^"]*"'
curl -s -H "X-Wiki-Product: ConST560" http://127.0.0.1:3737/api/wikis | head -c 400
```

预期：健康检查 `ok`；`<html lang="zh-CN">`；带 header 的请求返回对应产品的 wiki。

---

## 9. 相关文档

- `docs/13-multi-wiki.md` —— 多 wiki 路由与优先级契约
- `docs/09-cli-distribution.md` —— CLI 命令与启动参数
- `../需求变更-01-配置固化与中英切换.md` —— 配置文件分层（`llm-wiki.config.json` + `.env.local`）
