/* CLIP STUDIO 素材库自动翻译 —— 守护进程
 *
 * 作用：连上 CLIP STUDIO 内置 WebView2 的调试端口，自动把 inject.js 注入
 *       assets.clip-studio.com 的每个页面（含之后新打开的、刷新过的页面）。
 *
 * 用法：node daemon.js [--port 9222] [--once] [--verbose] [--interval 2000]
 */
const fs = require("fs");
const path = require("path");
const { listTargets, wsConnect } = require("./cdp");

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const opt = {
  port: Number(getArg("--port", 9222)),
  once: args.includes("--once"),
  verbose: args.includes("--verbose"),
  interval: Number(getArg("--interval", 2000)),
};

const SRC = path.join(__dirname, "inject.js");
const DICT = path.join(__dirname, "dict.json");
// 配置文件：改这里就能换目标语言，不用动代码
const CONF = path.join(__dirname, "..", "config.json");
// 素材库 + CLIP STUDIO 首页（首页里也嵌着英文素材标题）
const TARGET_RE = /^https?:\/\/(assets|start)\.clip-studio\.com\//i;

// 支持的目标语言
const LANGS = ["zh-CN", "id", "pt", "th"];
const DEFAULT_LANG = "zh-CN";

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONF, "utf8"));
    let lang = c.targetLanguage || DEFAULT_LANG;
    // 容错：接受 id-ID / pt-BR / th-TH / zh 这类写法
    if (!LANGS.includes(lang)) {
      const base = String(lang).toLowerCase().split(/[-_]/)[0];
      const map = { zh: "zh-CN", cn: "zh-CN", id: "id", in: "id", pt: "pt", th: "th" };
      lang = map[base] || DEFAULT_LANG;
    }
    return { targetLanguage: lang };
  } catch (e) {
    return { targetLanguage: DEFAULT_LANG };
  }
}

const VERSION = (() => {
  try {
    const m = fs.readFileSync(SRC, "utf8").match(/var VERSION = "([^"]+)"/);
    return m ? m[1] : "0";
  } catch (e) { return "0"; }
})();

function log(...a) { if (opt.verbose) console.log(new Date().toLocaleTimeString(), ...a); }

function buildScript(lang) {
  const code = fs.readFileSync(SRC, "utf8");
  let dict = "{}";
  try { dict = JSON.stringify(JSON.parse(fs.readFileSync(DICT, "utf8"))); } catch (e) {
    console.error("词库解析失败:", e.message);
  }
  return "window.__CLIP_DICT__ = " + dict + ";\n" +
         "window.__CLIP_TARGET__ = " + JSON.stringify(lang) + ";\n" + code;
}

let scriptCache = null;
let lastBuild = 0;
let lastLang = null;
// 上一次真正下发给页面的语言。只有它变了才强制覆盖页面语言，
// 这样用户在浮动面板里手动切的语言不会被守护进程抢回去。
let lastAppliedLang = null;

function currentScript() {
  // 文件改动或目标语言变化后自动重编译
  const conf = readConfig();
  const mtime = Math.max(fs.statSync(SRC).mtimeMs, fs.statSync(DICT).mtimeMs);
  if (!scriptCache || mtime > lastBuild || conf.targetLanguage !== lastLang) {
    scriptCache = buildScript(conf.targetLanguage);
    lastBuild = mtime;
    lastLang = conf.targetLanguage;
  }
  return scriptCache;
}

async function injectInto(page) {
  const cdp = await wsConnect(page.webSocketDebuggerUrl);
  try {
    const wantLang = readConfig().targetLanguage;
    // 探针：同时看版本号和当前目标语言
    const probe = await cdp.send("Runtime.evaluate", {
      expression: "(function(){var t=window.__CLIP_TRANSLATOR__;return t? (t.version+'|'+(t.target||'')) : ''})()",
      returnByValue: true,
    });
    const cur = probe && probe.result && probe.result.result && probe.result.result.value;
    const want = VERSION + "|" + wantLang;

    if (cur && cur.split("|")[0] === VERSION) {
      const pageLang = cur.split("|")[1];

      // 只有「配置文件里的语言变了」才强制切换页面语言。
      // 否则尊重用户在面板里的手动选择，不覆盖。
      if (lastAppliedLang === null) {
        // 首次运行：以配置文件为准同步一次，之后不再强推
        lastAppliedLang = wantLang;
        if (pageLang && pageLang !== wantLang) {
          const sw0 = await cdp.send("Runtime.evaluate", {
            expression: "(function(){try{return window.__CLIP_TRANSLATOR__.setTarget(" + JSON.stringify(wantLang) + ") ? 'switched' : 'failed'}catch(e){return 'err:'+e.message}})()",
            returnByValue: true,
          });
          log("首次同步语言 " + wantLang, page.url, sw0 && sw0.result && sw0.result.result && sw0.result.result.value);
          return "init-lang";
        }
      }
      const configChanged = wantLang !== lastAppliedLang;
      if (pageLang !== wantLang && configChanged) {
        const sw = await cdp.send("Runtime.evaluate", {
          expression: "(function(){try{return window.__CLIP_TRANSLATOR__.setTarget(" + JSON.stringify(wantLang) + ") ? 'switched' : 'failed'}catch(e){return 'err:'+e.message}})()",
          returnByValue: true,
        });
        const sv = sw && sw.result && sw.result.result && sw.result.result.value;
        log("配置变更 → 切换语言 " + wantLang, page.url, sv);
        lastAppliedLang = wantLang;
        return sv;
      }

      // 版本/语言都稳定：只在页面内容变化时补扫，避免空转
      const st = await cdp.send("Runtime.evaluate", {
        expression: "(function(){var t=window.__CLIP_TRANSLATOR__;if(!t)return '';try{return t.needsRescan? (t.needsRescan()?'y':'n') : ''}catch(e){return ''}})()",
        returnByValue: true,
      });
      const need = st && st.result && st.result.result && st.result.result.value;
      if (need === "y") {
        await cdp.send("Runtime.evaluate", {
          expression: "try{window.__CLIP_TRANSLATOR__.rescan()}catch(e){}",
          returnByValue: true,
        });
        log("内容有更新，补扫", page.url);
        return "rescan";
      }
      return "skip";
    }

    const r = await cdp.send("Runtime.evaluate", {
      expression: currentScript(),
      returnByValue: true,
      awaitPromise: false,
    });
    const exc = r && r.result && r.result.exceptionDetails;
    if (exc) {
      console.error("注入异常:", page.url, (exc.text || "") + " " + JSON.stringify(exc.exception && exc.exception.description || "").slice(0, 300));
      return "error";
    }
    const val = r && r.result && r.result.result && r.result.result.value;
    log("已注入", page.url, "→", val);
    return val;
  } finally {
    cdp.close();
  }
}

let lastErrorAt = 0;
async function tick() {
  let targets;
  try {
    targets = await listTargets(opt.port);
    lastErrorAt = 0;
  } catch (e) {
    // 端口还没起来（CLIP STUDIO 未启动）时安静等待，避免刷屏
    if (opt.verbose && Date.now() - lastErrorAt > 30000) {
      lastErrorAt = Date.now();
      console.error("等待调试端口 " + opt.port + "（请先启动 CLIP STUDIO）");
    }
    return false;
  }
  const pages = targets.filter((t) => t.type === "page" && TARGET_RE.test(t.url || ""));
  if (!pages.length) return false;
  for (const p of pages) {
    try { await injectInto(p); }
    catch (e) { console.error("注入失败:", p.url, e.message); }
  }
  return true;
}

(async () => {
  const conf = readConfig();
  const meta = (() => {
    try {
      const d = JSON.parse(fs.readFileSync(DICT, "utf8"));
      return (d._meta && d._meta.targets) || {};
    } catch (e) { return {}; }
  })();
  const langName = (meta[conf.targetLanguage] && meta[conf.targetLanguage].name) || conf.targetLanguage;

  console.log("CLIP STUDIO 素材库翻译守护进程");
  console.log("  版本: " + VERSION + "   调试端口: " + opt.port);
  console.log("  目标语言: " + conf.targetLanguage + " (" + langName + ")");
  console.log("  监听: " + TARGET_RE);
  console.log("  改 config.json 可切换语言（zh-CN / id / pt / th）");

  if (opt.once) {
    const ok = await tick();
    console.log(ok ? "单次执行完成" : "未找到素材页（请先在 CLIP STUDIO 里打开素材库）");
    process.exit(ok ? 0 : 2);
  }
  process.on("SIGINT", () => { console.log("\n已停止"); process.exit(0); });
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, opt.interval));
  }
})();
