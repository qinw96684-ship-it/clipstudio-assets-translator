const { listTargets, wsConnect } = require("./cdp");
const PORT = 9222;
const MATCH = new RegExp(process.argv[3] || "assets\\.clip-studio\\.com", "i");

(async () => {
  const list = await listTargets(PORT);
  const pages = list.filter((t) => t.type === "page");
  const page = pages.find((t) => MATCH.test(t.url));
  if (!page) {
    console.log("未找到匹配页面，当前页面：");
    pages.forEach((p) => console.log("  - [" + p.title + "] " + p.url));
    process.exit(1);
  }
  const cdp = await wsConnect(page.webSocketDebuggerUrl);
  const r = await cdp.send("Runtime.evaluate", {
    expression: process.argv[2] || "document.title",
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.error) console.log("CDP ERR", JSON.stringify(r.error));
  else if (r.result && r.result.exceptionDetails) console.log("JS EXC", JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  else console.log(JSON.stringify(r.result.result.value, null, 2));
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
