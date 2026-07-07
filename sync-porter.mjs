#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import * as yaml from "js-yaml";
const { load } = yaml;

/* ==========================================================================
 * 📖 【脚本使用说明】
 * ==========================================================================
 * 1. 作用：单目录联合解析下载器。
 * - 首次使用：同时放 pnpm-lock.yaml 和 package.json，拉取全量树进行一键下载。
 * - 增量使用：删掉或不提供 lockfile，仅在 package.json 写入新包，脚本将自动过滤
 * 目标目录中已存在的老包，实现精准的单目录增量追加。
 * 2. 依赖安装：
 * npm install js-yaml
 * 3. 运行方式：
 * node sync-porter.cjs
 * ========================================================================== */

/* ==========================================================================
 * 🛠️  【用户自定义配置中心】 (可按需任意修改默认值)
 * ========================================================================== */
const DEFAULT_CONFIG = {
  // 1. 需要解析的 pnpm-lock.yaml 文件路径
  lockFile: "./file/pnpm-lock.yaml",

  // 2. 项目 package.json 路径 
  packageFile: "./file/package.json",

  // 3. 所有 .tgz 包唯一的存放和输出目录
  outputDir: "./_npm_cache",

  // 4. 并发下载数量
  concurrency: 10,

  // 5. 错误日志文件名称与存放路径
  logFile: "./download_errors.log",
};

/* ==========================================================================
 * 🚀  【核心逻辑处理区】 (通用底层，无需修改)
 * ========================================================================== */

const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  return args[index + 1];
}

const LOCK_FILE = getArg("--lock", DEFAULT_CONFIG.lockFile);
const PACKAGE_FILE = getArg("--package", DEFAULT_CONFIG.packageFile);
const WORKDIR = getArg("--output", DEFAULT_CONFIG.outputDir);
const CONCURRENCY = parseInt(getArg("--concurrency", String(DEFAULT_CONFIG.concurrency)), 10);
const LOG_FILE = path.resolve(getArg("--log", DEFAULT_CONFIG.logFile));

// 确保输出目录存在 (如果存在则保留，不会清空它)
if (!fs.existsSync(WORKDIR)) {
  fs.mkdirSync(WORKDIR, { recursive: true });
}

// 初始化日志
fs.writeFileSync(LOG_FILE, `=== 离线包下载失败日志 (${new Date().toLocaleString()}) ===\n\n`);

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

function parsePackageKey(key) {
  if (key.startsWith("/")) {
    const m = key.match(/^\/(.+)\/([^/]+)$/);
    if (!m) return null;
    return { name: m[1], version: m[2] };
  }
  const index = key.lastIndexOf("@");
  if (index <= 0) return null;
  return { name: key.substring(0, index), version: key.substring(index + 1) };
}

/* 核心断点续传/老包校验：支持精准版本和模糊版本匹配 */
function isAlreadyDownloaded(name, version, workdir) {
  let cleanName = name.startsWith("@") ? name.substring(1).replace("/", "-") : name;
  
  if (version) {
    // 1. 如果有具体版本号（来自 Lockfile），直接对齐 npm 命名规则查原件
    const expectedFileName = `${cleanName}-${version}.tgz`;
    return fs.existsSync(path.join(workdir, expectedFileName));
  } else {
    // 2. 如果没有具体版本号（Lock被删后，来自 package.json 的纯新包）
    // 检索该目录下是否已经有这个包的任意 tgz。如果有，就代表曾经下过，直接跳过
    const files = fs.readdirSync(workdir);
    return files.some(file => file.startsWith(`${cleanName}-`) && file.endsWith(".tgz"));
  }
}

function writeErrorLog(dep, errorMsg) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleTimeString()}] 包: ${dep}\n失败原因:\n${errorMsg}\n------------------------------------------------------\n`);
}

async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = new Set();
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= poolLimit) await Promise.race(executing);
  }
  return Promise.all(ret);
}

/* ==========================================================================
 * 主程序
 * ========================================================================== */
async function main() {
  const finalDepsMap = new Map();
  let lockCount = 0;
  let pkgCount = 0;

  // 1. 尝试解析 pnpm-lock.yaml 提取全量深层依赖
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = load(fs.readFileSync(LOCK_FILE, "utf8"));
      const packages = lock.packages || {};
      for (const key of Object.keys(packages)) {
        const parsed = parsePackageKey(key);
        if (!parsed) continue;
        const pkg = packages[key];
        if (["directory", "file", "git", "link"].includes(pkg?.resolution?.type)) continue;

        finalDepsMap.set(parsed.name, {
          name: parsed.name,
          version: parsed.version,
          rawDep: `${parsed.name}@${parsed.version}`
        });
        lockCount++;
      }
    } catch (e) {
      console.warn("⚠️ 读取 Lock 文件失败，将跳过锁文件解析。");
    }
  } else {
    console.log("ℹ️ 未检测到 Lock 文件（已自动切换为纯 package.json 增量模式）。");
  }

  // 2. 读取 package.json 提取顶层依赖并与 Lock 结果去重合并
  if (fs.existsSync(PACKAGE_FILE)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8"));
      const combinedDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.optionalDependencies
      };

      for (const [name, versionRange] of Object.entries(combinedDeps)) {
        if (versionRange.startsWith("workspace:") || versionRange.startsWith("link:") || versionRange.startsWith("file:")) {
          continue;
        }

        // 核心去重：如果 Lock 提取依赖或者已有合并中包含它，直接跳过
        if (finalDepsMap.has(name)) {
          continue;
        }

        finalDepsMap.set(name, {
          name: name,
          version: null, // 无确切版本，交由 npm 拉取最新符合条件的包
          rawDep: versionRange.includes(":") ? name : `${name}@${versionRange}`
        });
        pkgCount++;
      }
    } catch (e) {
      console.warn("⚠️ 读取 package.json 失败或格式错误。");
    }
  }

  const depList = Array.from(finalDepsMap.values());

  console.log("====================================");
  console.log(`📑 依赖梳理完成！合并去重后独立依赖共：${depList.length} 个`);
  console.log(`   └─ 来自 Lockfile 锁定依赖: ${lockCount} 个`);
  console.log(`   └─ 来自 package.json 补充依赖: ${pkgCount} 个`);
  console.log(`⚡ 当前并发下载数：${CONCURRENCY}`);
  console.log(`📁 目标输出目录：${path.resolve(WORKDIR)}`);
  console.log("====================================");

  if (depList.length === 0) {
    console.log("ℹ️ 未检测到任何有效依赖，任务结束。");
    process.exit(0);
  }

  let success = 0; let failed = 0; let skipped = 0;

  // 3. 执行单目录并发下载
  async function processDependency(pkgInfo) {
    // 智能识别：无论是精准版本还是模糊新包，只要本地 outputDir 已经存在，立刻跳过
    if (isAlreadyDownloaded(pkgInfo.name, pkgInfo.version, WORKDIR)) {
      skipped++;
      return;
    }

    try {
      await runAsync(`npm pack "${pkgInfo.rawDep}" --pack-destination "${WORKDIR}"`);
      success++;
      console.log(`✅ [下载成功] [${success}]: ${pkgInfo.rawDep}`);
    } catch (e) {
      failed++;
      console.error(`❌ [下载失败]: ${pkgInfo.rawDep}`);
      writeErrorLog(pkgInfo.rawDep, e.message);
    }
  }

  await asyncPool(CONCURRENCY, depList, processDependency);

  console.log("");
  console.log("====================================");
  console.log("🏁 下载任务全部完成");
  console.log("------------------------------------");
  console.log("最终分析总数：", depList.length);
  console.log("本地已有跳过：", skipped);
  console.log("本次新增成功：", success);
  console.log("本次下载失败：", failed);
  if (failed > 0) {
    console.log(`⚠️  请查看错误日志了解详情: ${LOG_FILE}`);
  }
  console.log("====================================");
}

main().catch(console.error);