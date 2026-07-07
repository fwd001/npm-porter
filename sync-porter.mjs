#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import * as yaml from "js-yaml";
const { load } = yaml;

/* ==========================================================================
 * 📖 【脚本使用说明】
 * ==========================================================================
 * 1. 作用：全版本无损单目录下载器。
 * - 完美修复了同名包多版本被覆盖的 Bug，严格支持 Lockfile 中同一依赖的全部历史版本下载。
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

if (!fs.existsSync(WORKDIR)) {
  fs.mkdirSync(WORKDIR, { recursive: true });
}

fs.writeFileSync(LOG_FILE, `=== 离线包下载失败日志 (${new Date().toLocaleString()}) ===\n\n`);

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

/* 兼容解析 pnpm 各种大版本的依赖 Key 格式 */
function parsePackageKey(key) {
  // pnpm v6 格式: "/uuid/8.3.2" 或带 peer 依赖的 "/@babel/core/7.20.0(@babel/preset-env@7.20.0)"
  if (key.startsWith("/")) {
    // 移除可能存在的括号及其内部的 peer 依赖声明
    const cleanKey = key.split("(")[0];
    const m = cleanKey.match(/^\/(.+)\/([^/]+)$/);
    if (!m) return null;
    return { name: m[1], version: m[2] };
  }
  // pnpm v9/v10 格式: "uuid@8.3.2" 或 "uuid@8.3.2(peerDep)"
  const cleanKey = key.split("(")[0];
  const index = cleanKey.lastIndexOf("@");
  if (index <= 0) return null;
  return { name: cleanKey.substring(0, index), version: cleanKey.substring(index + 1) };
}

/* 核心断点续传/老包校验：严格区分版本 */
function isAlreadyDownloaded(name, version, workdir) {
  let cleanName = name.startsWith("@") ? name.substring(1).replace("/", "-") : name;
  
  if (version) {
    // 1. 如果有具体版本号（来自 Lockfile），直接对齐 npm 命名规则查原件，做到版本隔离
    const expectedFileName = `${cleanName}-${version}.tgz`;
    return fs.existsSync(path.join(workdir, expectedFileName));
  } else {
    // 2. 如果没有具体版本号（增量手写阶段），检索该目录下是否已经有这个包的任意 tgz
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
  // ⭐ 核心修复：使用“name@version”作为唯一 Key，防止同名不同版本的包被覆盖
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

        // 以唯一标示 name@version 存储
        const uniqueKey = `${parsed.name}@${parsed.version}`;
        if (!finalDepsMap.has(uniqueKey)) {
          finalDepsMap.set(uniqueKey, {
            name: parsed.name,
            version: parsed.version,
            rawDep: uniqueKey
          });
          lockCount++;
        }
      }
    } catch (e) {
      console.warn("⚠️ 读取 Lock 文件失败，将跳过锁文件解析。报错原因:", e.message);
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

        // 检查 Map 中是否已经存在该包的任何一个版本
        // 增量模式下：只有当 Lockfile 和 Map 里完全没有任何一个版本的该依赖时，才作为全新包引入
        const hasExisting = Array.from(finalDepsMap.values()).some(item => item.name === name);
        if (hasExisting) {
          continue;
        }

        const uniqueKey = `${name}@${versionRange}`;
        if (!finalDepsMap.has(uniqueKey)) {
          finalDepsMap.set(uniqueKey, {
            name: name,
            version: null, 
            rawDep: versionRange.includes(":") ? name : uniqueKey
          });
          pkgCount++;
        }
      }
    } catch (e) {
      console.warn("⚠️ 读取 package.json 失败或格式错误。");
    }
  }

  const depList = Array.from(finalDepsMap.values());

  console.log("====================================");
  console.log(`📑 依赖梳理完成！多版本完美共存后总包数：${depList.length} 个`);
  console.log(`   └─ 来自 Lockfile 的精确依赖(含多版本): ${lockCount} 个`);
  console.log(`   └─ 来自 package.json 的新增依赖: ${pkgCount} 个`);
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
    // 严格的版本级断点续传校验
    if (isAlreadyDownloaded(pkgInfo.name, pkgInfo.version, WORKDIR)) {
      skipped++;
      return;
    }

    try {
      await runAsync(`npm pack "${pkgInfo.rawDep}" --pack-destination "${WORKDIR}"`);
      success++;
      console.log(`✅ [下载成功] [${success}/${depList.length}]: ${pkgInfo.rawDep}`);
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
