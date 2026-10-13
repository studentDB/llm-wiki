# 发版与部署步骤（FTP 直传版）

## 先回答"构建在哪做"

**构建确实存在，只是不在你的 Windows 上做，而在服务器容器里做。**

| | Windows 开发机 | Linux 容器（服务器） |
|---|---|---|
| 装依赖 `pnpm install` | ❌ 不做 | ✅ 启动时做（增量，通常 no-op） |
| 编译 `next build` | ❌ 不做 | ✅ 启动时做（增量，走 `.next` 缓存） |
| 产出 | 无（就是源码本身） | `.next` + `node_modules`，都在数据卷里 |

**为什么不能在本机构建？** `node_modules` 里的 `better-sqlite3`、`keytar` 是原生模块，ABI 跟编译它的操作系统和 Node 大版本绑死；`.next` 同理。Windows 上编出来的东西放进 Linux 容器必然加载失败。所以**发布物就是源码本身**，构建交给目标环境的容器去做。

**那本地就什么都不用做吗？** 不——有一件必须做：**发布前自检**（第 0 步）。因为构建在服务器进行，一旦代码编译不过，表现是"容器起不来"，排查成本高得多。自检把这道关挪到你手边。

---

## 第 0 步：本地——自检 + 定版本

```powershell
cd E:\CodeRepository\CodeTest\llm-wiki

# 0.1 发布前自检：类型检查 + 中英词条校验 + 单测（约 1 分钟）
.\precheck.ps1

# 0.2 定版本（可选但推荐）
git add -A
git commit -m "release: 这次改了什么"
git tag v1.2.4
```

`precheck.ps1` 全绿会打印 `== READY TO PUBLISH ==`；有红字就先修，别急着传。

```powershell
.\precheck.ps1 -SkipTests   # 跳过单测，只查类型 + 词条（十几秒）
.\precheck.ps1 -Build       # 额外在本地试编一次 next build（慢，产出不上传）
```

> ⚠️ 已知假警报：本机磁盘偶尔 IO 抖动，单测会报 `Hook timed out in 10000ms`——**那是环境问题，不是代码坏了**，换个时间重跑或加 `-SkipTests` 即可。
>
> `-Build` 编出来的 `.next` **留在本地**，绝对不要传上去（第 1 步禁传清单里有它）。

---

## 第 1 步：本地——选好要传的文件

FTP 工具连上服务器之后，把下面这些拖过去：

| 本地路径（`E:\CodeRepository\CodeTest\llm-wiki\` 下） | 传到服务器 |
|---|---|
| `apps` | `/srv/llm-wiki/app/apps` |
| `packages` | `/srv/llm-wiki/app/packages` |
| `package.json` | `/srv/llm-wiki/app/` |
| `pnpm-workspace.yaml` | `/srv/llm-wiki/app/` |
| `pnpm-lock.yaml` | `/srv/llm-wiki/app/` |
| `Dockerfile` | `/srv/llm-wiki/app/` |
| `docker-entrypoint.sh` | `/srv/llm-wiki/app/` |
| `.dockerignore` | `/srv/llm-wiki/app/` |
| `docker-compose.yml` | `/srv/llm-wiki/` ← **根目录，不要放进 app** |

**❌ 绝不传：**

| 不要传 | 原因 |
|---|---|
| `node_modules`（任何层级） | 容器里自己装；传了也没用（被数据卷遮住），只会浪费时间 |
| `.next`（任何层级） | 编译产物，容器里自己生成 |
| `apps\web\wikis` | **这是数据**，覆盖会毁掉服务器上的 wiki 内容 |
| `.env` / `.env.local` | 密钥，在服务器上单独建（第 3 步） |
| `.git`、`docs`、`release`、`00-cmd-*.txt` | 没必要 |

> FTP 弹"文件已存在"时选 **覆盖 / 全部替换 / Overwrite**。
> **日常更新只要传 `apps` 和 `packages` 就行**（外加三个根文件）；`Dockerfile` 那三个只有它们自己变了才需要重传。
>
> 一句话记住：**用 FTP 拖，别用 `scp -r`**。`scp -r apps` 会把里头的 `node_modules`、`.next`、`wikis` 一股脑传上去，又慢又有害；FTP 拖同样两个目录时，你在工具里看到的就是全部内容，边界更直观。

---

## 第 2 步：服务器——目录应该长这样

```
/srv/llm-wiki/
├── docker-compose.yml      容器配方（根目录，传一次基本不动）
├── .env                     API 密钥（根目录，建一次；不在代码目录里）
│
├── app/                    程序代码 ← 每次更新覆盖这里
│   ├── Dockerfile
│   ├── docker-entrypoint.sh
│   ├── .dockerignore
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── pnpm-workspace.yaml
│   ├── apps/               网页程序主体
│   └── packages/           公共代码包
│
└── data/                   数据，更新代码永远不动
    ├── wikis/              wiki 内容（重要资产）
    └── config/             全局配置：实际就一个 config.json
                            （当前选中哪个 wiki、最近打开列表、主题、密钥兜底）
```

三句话：

1. 只有 `app/` 会被覆盖，`data/` 不会丢。
2. `docker-compose.yml` 在**根**目录，`Dockerfile`/`docker-entrypoint.sh`/`.dockerignore` 在 **`app/` 里**（它们要和代码同源）。
3. `data/` 第一次启动时 Docker 自动建，不用手动建。

---

## 第 3 步：服务器——命令

### 3.1 只在第一天做：检查 Docker + 建密钥

```bash
docker --version
docker compose version
```

两条都要有输出。没有的话：`apt install docker.io docker-compose-plugin`（Ubuntu/Debian）。注意是 `docker compose`（空格），不是带横杠的旧命令。**服务器不需要装 Node、不需要装 pnpm。**

**建密钥文件**（部署根，不在 `app/` 里）：

```bash
nano /srv/llm-wiki/.env
```

内容（等号后面换成你自己的 key，没有的留空）：

```
CUSTOM_OPENAI_API_KEY=
ALIYUN_API_KEY=
OPENROUTER_API_KEY=
```

保存退出（nano：`Ctrl+O` → 回车 → `Ctrl+X`）。

> **为什么密钥要单独放 `/srv/llm-wiki/.env`，而不是跟着代码传？**
>
> | 理由 | 说明 |
> |---|---|
> | 代码会被覆盖 | `app/` 每次发版都整体替换，密钥不该待在会被替换的目录里 |
> | 换密钥不用重发代码 | 改这一个文件 + `restart` 即可，不用再传一遍 `apps/` |
> | 权限分离 | 能看代码目录的人（比如 CI、只读备份）不会顺手拿到密钥 |
>
> 容器启动时 compose 会把这个文件注入成环境变量，程序直接从 `process.env` 读，**不需要额外配置**。
>
> ⚠️ **别从 Windows 直接传这个文件** —— Windows 换行符会让密钥值带上肉眼看不见的 `\r`，调用大模型时报鉴权失败。已经传上去的话在服务器执行一次 `sed -i 's/\r$//' /srv/llm-wiki/.env` 即可。
>
> （另一个可行位置是 `app/apps/web/.env.local`，Next 会自动加载。但它落在代码目录里，会被覆盖，所以不推荐。）

### 3.2 第一次启动（建镜像，3~8 分钟）

```bash
cd /srv/llm-wiki
docker compose up -d --build
```

### 3.3 每次发版更新（就这一条）

```bash
cd /srv/llm-wiki && docker compose restart wiki
```

如果改了 `docker-compose.yml` 本身：

```bash
cd /srv/llm-wiki && docker compose up -d --force-recreate wiki
```

### 3.4 什么时候才需要重新 `--build`

只有 `Dockerfile`、`docker-entrypoint.sh`、`package.json`、`pnpm-lock.yaml` 变了才要：

```bash
cd /srv/llm-wiki && docker compose up -d --build
```

---

## 第 4 步：验证发布成功

```bash
docker compose logs -f wiki
```

看到这一行就起来了（`Ctrl+C` 退出跟随，**不会停服务**）：

```
[wiki-entrypoint] starting: node /app/apps/web/node_modules/next/dist/bin/next start -p 3737 -H 0.0.0.0
```

再验一下对外服务：

```bash
docker compose ps                                               # 状态应为 Up (healthy)
curl -s http://127.0.0.1:3737/api/wikis/health                  # 健康检查通过
curl -s http://127.0.0.1:3737/ | grep -o '<html lang="[^"]*"'   # 应为 zh-CN
```

浏览器打开 `http://<服务器IP>:3737`，云服务器记得在安全组放行 **3737**。

---

## 常用命令（都在 `/srv/llm-wiki` 下敲）

```bash
docker compose ps                      # 看状态
docker compose logs -f wiki            # 跟随日志
docker compose logs --tail=100 wiki    # 看最后 100 行
docker compose restart wiki            # 重启（日常发版用这个）
docker compose stop wiki               # 停止
docker compose start wiki              # 启动
docker compose down                    # 停止并删除容器（data/ 数据还在）
```

**备份**（建议发版前顺手做）：

```bash
cd /srv/llm-wiki
cp -a app app.bak.$(date +%Y%m%d-%H%M)     # 代码快照
tar -czf backup-$(date +%F).tgz data       # 数据备份（wiki 内容）
```

**回滚**：

```bash
cd /srv/llm-wiki
ls -d app.bak.*                            # 看有哪些历史版本
rm -rf app && mv app.bak.<时间戳> app
docker compose restart wiki
```

---

## 迁移已有的 wiki 库（可选）

本地 `apps\web\wikis\` 里如果有灌好的库（ConST560、ConST326 等），**别跟着代码一起传**，单独放到数据目录一次：

```
本地 apps\web\wikis\ConST560  →  /srv/llm-wiki/data/wikis/ConST560
本地 apps\web\wikis\ConST326  →  /srv/llm-wiki/data/wikis/ConST326
```

传完 `docker compose restart wiki`，页面上就能看到了。

> 新建（未预置）的库在**首次访问/首次灌库**时会自动生成自己的 `.llm-wiki/settings.json`，内容继承 `app/apps/web/llm-wiki.config.json` 的 `defaults`（模型槽位、开关）。生成之后这个库的配置就**冻结**了——之后改部署默认值不再影响它，要改就进该库的设置页或直接编辑 `data/wikis/<产品>/.llm-wiki/settings.json`。

---

## 出问题看这里

| 现象 | 怎么办 |
|---|---|
| `docker compose: command not found` | 装 `docker-compose-plugin`；命令是 `docker compose`（空格） |
| 构建卡住，日志里有 `fonts.googleapis.com` | 服务器访问不了 Google Fonts。加代理重建：<br>`docker compose build --build-arg HTTP_PROXY=http://<代理>:<端口> --build-arg HTTPS_PROXY=http://<代理>:<端口>` |
| 页面打不开 | ① `docker compose ps` 是否 Up；② 云服务器检查 3737 安全组；③ `docker compose logs --tail=100 wiki` |
| 更新后页面没变化 | `docker compose up -d --force-recreate wiki` |
| 容器起来就退，报 `exec ... entrypoint.sh: no such file` 或 `env: 'bash\r'` | 镜像是旧的，重新构建一次 `docker compose up -d --build`（新 Dockerfile 会自动清掉 Windows 换行符） |
| `docker-compose.yml` 报 YAML 解析错 | `sed -i 's/\r$//' docker-compose.yml` |
| 报 `Address already in use` | 3737 被占。改 `docker-compose.yml` 里 `ports` 的**左边**：`"3737:3737"` → `"8080:3737"` |
| 灌库/问答报鉴权失败 | 检查 `/srv/llm-wiki/.env`；如果是从 Windows 传来的，执行 `sed -i 's/\r$//' /srv/llm-wiki/.env` 后 `docker compose restart wiki` |
| 报 `COPY ... not found` | `app/` 缺文件。检查 `ls /srv/llm-wiki/app` 有没有 `apps/`、`packages/`、`pnpm-lock.yaml` |
