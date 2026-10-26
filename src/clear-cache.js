// 清空翻译缓存：让页面丢掉本地缓存的译文并重新翻译
const { listTargets, wsConnect } = require("./cdp");

const PORT = 9222;
const EXPR = [
  "(() => {",
  '  try { localStorage.removeItem("clipTrCache.v2"); } catch (e) {}',
  '  try { localStorage.removeItem("clipTrCache.v1"); } catch (e) {}',
  "  if (window.__CLIP_TRANSLATOR__) {",
  "    try { window.__CLIP_TRANSLATOR__.restore(); } catch (e) {}",
  "    setTimeout(function(){ try { window.__CLIP_TRANSLATOR__.rescan(true); } catch (e) {} }, 400);",
  "  }",
  '  return "cache-cleared";',
  "})()",
].join("\n");

(async () => {
  let list;
  try { list = await listTargets(PORT); }
  catch (e) {
    console.log("连不上调试端口 9222，请先启动 CLIP STUDIO。");
    process.exit(2);
  }
  const pages = list.filter(
    (t) => t.type === "page" && /^https?:\/\/(assets|start)\.clip-studio\.com\//i.test(t.url || "")
  );
  if (!pages.length) {
    console.log("当前没有打开的素材页/首页，先打开素材库再运行。");
    process.exit(0);
  }
  for (const p of pages) {
    try {
      const cdp = await wsConnect(p.webSocketDebuggerUrl);
      const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
      const v = r && r.result && r.result.result && r.result.result.value;
      console.log("已清空：" + p.url + " → " + v);
      cdp.close();
    } catch (e) {
      console.log("清理失败：" + p.url + " " + e.message);
    }
  }
  console.log("完成。若页面没变化，按 Ctrl+R 刷新一下。");
  process.exit(0);
})();
