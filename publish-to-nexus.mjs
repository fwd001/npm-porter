#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { exec } from "child_process";

/* ==========================================================================
 * 🛠️  【用户自定义配置中心】 (可按需任意修改)
 * ========================================================================== */
const DEFAULT_CONFIG = {
  // 1. 存放大量 .tgz 离线包的文件夹路径 (支持相对路径或绝对路径)
  inputDir: "./_npm_cache",

  // 2. 内网 Nexus 的 npm-(hosted) 宿主仓库地址 (发布只能推给 hosted，千万别推给 group)
  registry: "http://10.1.1.1:8081/repository/npm-hosted/",

  // 3. 并发上传数量。内网建议 3~5，配置太高可能会把内部私服服务器压垮导致大量 500 报错
  concurrency: 5,

  // 4. 最终生成的日志文件名称与存放路径 (默认放在当前执行目录下)
  logFile: "./publish_result.log",
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

// 自动适配：优先读取命令行传入的参数，如果没有则读取上面的默认配置
const WORKDIR = getArg("--input", DEFAULT_CONFIG.inputDir);
const REGISTRY = getArg("--registry", DEFAULT_CONFIG.registry);
const CONCURRENCY = parseInt(
  getArg("--concurrency", String(DEFAULT_CONFIG.concurrency)),
  10,
);
const LOG_FILE = path.resolve(getArg("--log", DEFAULT_CONFIG.logFile));

/* 校验离线包目录是否存在 */
if (!fs.existsSync(WORKDIR)) {
  console.error(`❌ 错误：离线包目录不存在，请检查路径: ${WORKDIR}`);
  process.exit(1);
}

// 写入初始化日志头部
fs.writeFileSync(
  LOG_FILE,
  `======================================================\n` +
    `📦 Nexus 内网自动化批量发布全量日志\n` +
    `📅 执行时间: ${new Date().toLocaleString()}\n` +
    `📁 目标目录: ${path.resolve(WORKDIR)}\n` +
    `🌐 目标私服: ${REGISTRY}\n` +
    `⚡ 并发限制: ${CONCURRENCY}\n` +
    `======================================================\n\n`,
);

/* 异步执行命令行工具 */
function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/* 结构化写入流日志 */
function appendLog(status, filename, extraMsg = "") {
  let logItem = "";
  const timeStr = new Date().toLocaleTimeString();

  if (status === "SUCCESS") {
    logItem = `[${timeStr}] [✅ SUCCESS] 成功发布: ${filename}\n`;
  } else if (status === "SKIPPED") {
    logItem = `[${timeStr}] [⏭️ SKIPPED] 跳过(私服已存在): ${filename}\n`;
  } else if (status === "FAILED") {
    logItem =
      `\n######################################################\n` +
      `[${timeStr}] [❌ CRITICAL_FAILED] 发布严重失败: ${filename}\n` +
      `报错详情:\n${extraMsg}\n` +
      `######################################################\n\n`;
  }
  fs.appendFileSync(LOG_FILE, logItem);
}

/* 高性能并发滑动窗口调度器 */
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = new Set();
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= poolLimit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

/* 主运行函数 */
async function main() {
  console.log("🔍 正在扫描内网离线包目录...");
  const allFiles = fs.readdirSync(WORKDIR);
  const tgzFiles = allFiles.filter((file) => file.endsWith(".tgz"));

  console.log("====================================");
  console.log(`📦 扫描完成！待处理离线包总数：${tgzFiles.length} 个`);
  console.log(`🚀 目标私服仓库：${REGISTRY}`);
  console.log(`⚡ 当前并发数：${CONCURRENCY}`);
  console.log("====================================");

  if (tgzFiles.length === 0) {
    console.log("ℹ️ 没有发现任何 .tgz 后缀的文件，任务提前结束。");
    process.exit(0);
  }

  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  // 单包核心发布逻辑
  async function publishPackage(filename) {
    // ⭐ 核心修复点：通过 path.resolve 将相对路径强制转换为内网绝对路径，打断 npm 的 Git 错误解析
    const absoluteFilePath = path.resolve(WORKDIR, filename);

    try {
      // ⭐ 优化点：增加 --ignore-scripts 防止离线包自带的生命周期钩子在无网环境乱跑报错
      await runAsync(
        `npm publish "${absoluteFilePath}" --registry=${REGISTRY} --no-git-checks --ignore-scripts --provenance=false --audit=false`,
      );
      successCount++;
      console.log(`✅ [发布成功]: ${filename}`);
      appendLog("SUCCESS", filename);
    } catch (e) {
      const errMsg = e.message;

      // 智能状态判定：如果 Nexus 返回 403 或 400 且含有包已存在的特定关键词，判定为跳过
      if (
        errMsg.includes("403 Forbidden") ||
        errMsg.includes("400 Bad Request") ||
        errMsg.includes("cannot be overwritten") ||
        errMsg.includes("already exists")
      ) {
        skippedCount++;
        console.log(`⏭️  [跳过-已存在]: ${filename}`);
        appendLog("SKIPPED", filename);
      } else {
        failedCount++;
        console.error(`❌ [严重失败]: ${filename} (报错已记入日志)`);
        appendLog("FAILED", filename, errMsg);
      }
    }
  }

  // 启动并发池
  await asyncPool(CONCURRENCY, tgzFiles, publishPackage);

  // 组装总结报表
  const summaryText =
    `\n======================================================\n` +
    `🏁 任务统计总结\n` +
    `------------------------------------------------------\n` +
    `📦 扫描离线包总数: ${tgzFiles.length}\n` +
    `✅ 首次发布成功数: ${successCount}\n` +
    `⏭️  远程已有而跳过: ${skippedCount}\n` +
    `❌ 真正发布失败数: ${failedCount}\n` +
    `======================================================\n`;

  fs.appendFileSync(LOG_FILE, summaryText);

  // 控制台打印报表
  console.log(summaryText);
  console.log(`📊 详尽发布日志已保存至: ${LOG_FILE}\n`);
}

main().catch(console.error);
