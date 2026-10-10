# 部署步骤

按顺序做四件事：**本地打包 → 上传 → 摆好目录 → 用 docker-compose 启动**。

- 开发机 = 你的 Windows 电脑
- 服务器 = Linux 服务器，下面统一用 `/srv/llm-wiki` 作为部署目录

---

# 一、本地怎么打包

打开 **PowerShell**，依次执行：

```powershell
cd E:\CodeRepository\CodeTest\llm-wiki
git add -A
git commit -m "release: 本次改了什么"
.\pack-for-deploy.ps1
```

看到这两行就成功了：

```
[pack] verified: 1234 entries, kit + config present, no secrets
release/ is ready:
```

**产出物**在 `E:\CodeRepository\CodeTest\llm-wiki\release\`，里面有 3 个文件：

| 文件 | 是什么 | 每次都要传吗 |
|---|---|---|
| `llm-wiki-app.tgz` | 程序代码 | ✅ 每次更新都要传 |
| `docker-compose.yml` | 容器启动配置 | ❌ 只在第一次传 |
| `update.sh` | 服务器一键更新脚本 | ❌ 只在第一次传 |

> ⚠️ **最容易踩的坑**：打包是**按 git 已提交的文件**打的。如果你改了代码没 commit，`pack-for-deploy.ps1` 会打印黄色警告或直接报错退出——**它不是在做无用功，是在拦你**。看到就回去 `git add -A && git commit`，再重新打包。

---

# 二、上传到服务器

用你手头的工具（WinSCP / FileZilla / Xftp 都行），把 `release\` 里的东西传到服务器：

```
本地 release\llm-wiki-app.tgz        →  服务器 /srv/llm-wiki/llm-wiki-app.tgz
本地 release\docker-compose.yml     →  服务器 /srv/llm-wiki/docker-compose.yml
本地 release\update.sh              →  服务器 /srv/llm-wiki/update.sh
```

**注意：是传到 `/srv/llm-wiki/` 这个目录下面，不要多建一层 `release` 目录。**

---

# 三、服务器目录结构

传完之后，服务器上应该是这样（第一次的话后面两步命令会自动建 `app/` 和 `data/`）：

```
/srv/llm-wiki/
├── llm-wiki-app.tgz        ← 每次更新，替换这个文件
├── docker-compose.yml      ← 传一次，基本不动
├── update.sh               ← 传一次，基本不动
│
├── app/                    ← 程序代码（脚本自动解压，你不用管）
│   ├── Dockerfile
│   ├── apps/
│   ├── packages/
│   ├── package.json
│   ├── pnpm-lock.yaml
│   └── pnpm-workspace.yaml
│
└── data/                   ← 数据，更新代码不会动它
    ├── wikis/              ← wiki 内容（重要！就是这个）
    └── config/             ← 当前选中哪个 wiki、密钥等
```

**要记住的三句话：**

1. **只有 `app/` 里的东西会被更新覆盖。** 每次更新，脚本先把旧的 `app/` 整个搬到 `app.bak.<时间>`，再把新代码解压出来。
2. **`data/` 里的东西永远不动**，更新代码不会丢 wiki 数据。
3. `docker-compose.yml` 和 `update.sh` **必须在 `/srv/llm-wiki/` 根目录，不能放进 `app/`** —— 放进去了会被更新时一起搬走，下次就没法更新了。

---

# 四、在 Linux 服务器上用 docker-compose

## 4.1 先确认服务器上有 Docker

```bash
docker --version
docker compose version
```

两条都要有输出。没有的话先装 Docker（Ubuntu 20.04/22.04 上是 `apt install docker.io docker-compose-plugin`），**服务器不需要装 Node 或 pnpm**。

## 4.2 写密钥文件（第一次）

```bash
mkdir -p /srv/llm-wiki
nano /srv/llm-wiki/app/apps/web/.env.local
```

内容（把等号后面换成你自己的 key，没有的留空）：

```
CUSTOM_OPENAI_API_KEY=
ALIYUN_API_KEY=
OPENROUTER_API_KEY=
```

保存退出（nano：`Ctrl+O` 回车，再 `Ctrl+X`）。

> 这个文件**不会**被打进代码包，也**不会**在更新时被删掉（脚本会自动从备份里带回来）。

## 4.3 启动（第一次，约 3~8 分钟）

```bash
cd /srv/llm-wiki
chmod +x update.sh
./update.sh ./llm-wiki-app.tgz
```

脚本会依次打印 `[1/4]` 到 `[4/4]`，第一次它会自动帮你**构建镜像并启动**。

然后看启动日志：

```bash
docker compose logs -f wiki
```

看到这一行就说明好了：

```
[wiki-entrypoint] starting: node .../next start -p 3737 -H 0.0.0.0
```

`Ctrl+C` 退出日志跟随（**不会停掉服务**）。

浏览器打开 `http://<服务器IP>:3737`。云服务器记得在安全组里放行 **3737** 端口。

## 4.4 以后每次更新

**本地**：改完代码 → commit → `.\pack-for-deploy.ps1` → 上传 `llm-wiki-app.tgz` 覆盖服务器同名文件。

**服务器**，就这一条：

```bash
cd /srv/llm-wiki && ./update.sh ./llm-wiki-app.tgz
```

通常 **30~90 秒**完成。

---

# 五、常用命令（都在 `/srv/llm-wiki` 目录下执行）

```bash
docker compose ps                 # 看状态，正常是 Up (healthy)
docker compose logs -f wiki       # 跟随日志，Ctrl+C 退出
docker compose logs --tail=100 wiki   # 看最后 100 行
docker compose restart wiki       # 重启
docker compose stop wiki          # 停止
docker compose start wiki         # 启动
docker compose down               # 停止并删除容器（数据还在 data/）
```

**回滚到上一个版本：**

```bash
cd /srv/llm-wiki
ls -d app.bak.*                                 # 看有哪些历史版本
rm -rf app && mv app.bak.<时间戳> app
docker compose up -d --force-recreate wiki
```

**备份数据（建议定期做）：**

```bash
cd /srv/llm-wiki && tar -czf backup-$(date +%F).tgz data
```

---

# 六、出问题看这里

| 现象 | 怎么办 |
|---|---|
| `docker compose: command not found` | 装 `docker-compose-plugin`；别用老的 `docker-compose`（带横杠） |
| 构建很久卡住，日志有 `fonts.googleapis.com` | 服务器访问不了 Google Fonts。构建时加代理：<br>`docker compose build --build-arg HTTP_PROXY=http://<代理地址>:<端口> --build-arg HTTPS_PROXY=http://<代理地址>:<端口>` |
| 页面打不开 | ① `docker compose ps` 看是否 Up；② 云服务器检查 3737 安全组；③ `docker compose logs --tail=100 wiki` |
| 更新后页面没变化 | 强制重建一次：`docker compose up -d --force-recreate wiki` |
| 报 `permission denied: ./update.sh` | `chmod +x update.sh` |
| 报 `$'\r': command not found` 或 `/usr/bin/env: 'bash\r'` | 脚本换行符是 Windows 的 CRLF。新版打包脚本已自动转 LF——回本地重新 `.\pack-for-deploy.ps1` 再传一次；应急可在服务器执行 `sed -i 's/\r$//' update.sh` |
| 报 `COPY ... not found` | `./app` 里的代码没解开。检查 `ls /srv/llm-wiki/app` 有没有 `apps/` 和 `packages/` |

---

# 七、改了 package.json（依赖变了）才需要做的事

平时改业务代码**不需要**这一步。只有当 `package.json` 或 `pnpm-lock.yaml` 变了：

```bash
cd /srv/llm-wiki && docker compose up -d --build
```
