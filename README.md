# 📦 内网前端依赖（增量）搬运工具链说明

本工具链包含两个脚本：**外网联合下载脚本** 与 **内网批量发布脚本**，专门解决内网开发无法连接公网下载 npm 包的痛点。

---

## 📥 步骤一：外网下载 (`sync-porter.mjs`)

### 1. 怎么用？

- **首次全量下载**：把内网项目的 `pnpm-lock.yaml` 和 `package.json` 一起拷到外网脚本的对应目录下，执行命令，全家桶包会被一次性全量下载到 `./_npm_cache`。
- **后续新增包（增量）**：**删掉外网的 `pnpm-lock.yaml**`，直接在外网的 `package.json`里手动添加你要的新包名。执行命令后，脚本会自动识别老包并跳过，**只下载你新加的包**到`./\_npm_cache` 里。

### 2. 执行命令：

```bash
# 运行前请确保安装了 yaml 解析依赖：npm install js-yaml
node sync-porter.cjs

```

> **💡 捞包技巧**：下载完成后，在 `./_npm_cache` 文件夹中**按文件的修改时间排序**，把今天新下载的那几个 `.tgz` 文件捞出来带进内网就行。

---

## 🚀 步骤二：内网发布 (`publish-to-nexus.cjs`)

### 1. 怎么用？

1. 把在外网捞出来的新包（`.tgz` 文件）拷贝进内网。
2. 在正式发布前，确保你在内网终端**手动登录过一次内网 Nexus 宿主库（hosted）**：

```bash
npm login --registry=http://10.1.1.1:8081/repository/npm-hosted/

```

3. 把包丢进脚本指定的输入目录，直接运行发布脚本。

### 2. 执行命令：

```bash
node publish-to-nexus.cjs

```

> **💡 脚本特性**：内网脚本支持多线程高并发上传。如果包在 Nexus 里已经存在，会自动打印 `[跳过-已存在]`，绝不重复覆盖；如果是全新包，则会正常 `[发布成功]`。

---

## 🏁 终极目标：团队内网完全无感开发

为了让所有人装包最省心，请在内网项目的根目录下放置一个统一的 **`.npmrc`** 文件，锁死内网源：

```ini
# 锁死为内网 Nexus 的组仓库 (group)
registry=http://10.1.1.1:8081/repository/npm-group/

```

配置好后，内网任何人需要安装包，不需要去关心文件在哪，直接在项目里正常敲 **`pnpm install`**，即可秒级从 Nexus 自动拉取安装！

## 其他

下载某个包的命令
npm pack dayjs --pack-destination ./\_npm_cache

npm login --registry=http://10.1.1.1:8081/repository/npm-hosted/

admin
Lhcz@0630

# 语法：npm publish <tarball文件路径> --registry=<你的hosted仓库地址>

npm publish supports-color-5.5.0.tgz --registry=http://10.1.1.1:8081/repository/npm-hosted/ --provenance=false --audit=false

pnpm publish --registry http://10.1.1.1:8081/repository/npm-hosted/
