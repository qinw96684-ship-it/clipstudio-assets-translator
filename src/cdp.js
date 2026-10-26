// 极简 CDP 客户端（零依赖，手写 WebSocket 帧）
// 用于连接 CLIP STUDIO 内置 WebView2 的调试端口
const http = require("http");
const crypto = require("crypto");

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(new Error("timeout")); });
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ""),
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (res, socket) => {
      const api = { socket, nextId: 1, pending: new Map(), handlers: new Map(), closed: false };
      let buf = Buffer.alloc(0);
      socket.on("close", () => { api.closed = true; });
      socket.on("error", () => { api.closed = true; });
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const b1 = buf[1] & 0x7f;
          let off = 2, len = b1;
          if (b1 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (b1 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len).toString("utf8");
          buf = buf.slice(off + len);
          let msg;
          try { msg = JSON.parse(payload); } catch (e) { continue; }
          if (msg.id && api.pending.has(msg.id)) {
            const fn = api.pending.get(msg.id);
            api.pending.delete(msg.id);
            fn(msg);
          }
          if (msg.method && api.handlers.has(msg.method)) {
            try { api.handlers.get(msg.method)(msg.params); } catch (e) {}
          }
        }
      });
      api.send = (method, params) => new Promise((res) => {
        if (api.closed) { res({ error: { message: "socket closed" } }); return; }
        const id = api.nextId++;
        const data = Buffer.from(JSON.stringify({ id, method, params: params || {} }), "utf8");
        const mask = crypto.randomBytes(4);
        let header;
        if (data.length < 126) { header = Buffer.from([0x81, 0x80 | data.length]); }
        else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
        const timer = setTimeout(() => { if (api.pending.has(id)) { api.pending.delete(id); res({ error: { message: "cdp timeout" } }); } }, 20000);
        api.pending.set(id, (m) => { clearTimeout(timer); res(m); });
      });
      api.close = () => { try { socket.destroy(); } catch (e) {} };
      resolve(api);
    });
    req.on("error", reject);
    req.end();
  });
}

async function listTargets(port) {
  return httpGet(port, "/json/list");
}

module.exports = { httpGet, wsConnect, listTargets };
