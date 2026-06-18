/**
 * 6-18: 客户自助加号 — Agent 内置一个只绑 127.0.0.1 的本地小网页(控制台)。
 * 客户点「登录抖音/登录视频号」按钮 → 服务器侧建占位号(绑本机)→ 本机弹登录页扫码 → 自动变真号。
 * 全程客户零打字、老韩零操作。仅本机可访问(localhost), 无需鉴权。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { exec } from "node:child_process";
import { logger } from "./log.js";

const PORTS = [17653, 17654, 17655];

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>BossMate · 添加发布账号</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,system-ui,"Microsoft YaHei",sans-serif;background:#f5f6fa;margin:0;padding:36px 18px;color:#1b1b1f}
.card{max-width:440px;margin:0 auto;background:#fff;border-radius:18px;padding:30px 26px;box-shadow:0 6px 30px rgba(0,0,0,.07)}
h1{font-size:21px;margin:0 0 8px}.sub{color:#8a8a93;font-size:13.5px;line-height:1.6;margin:0 0 24px}
button{width:100%;padding:17px;font-size:17px;font-weight:600;border:0;border-radius:13px;color:#fff;margin-bottom:14px;cursor:pointer;transition:opacity .15s}
button:active{opacity:.8}.dy{background:#161823}.wv{background:#fa9d3b}
#msg{margin-top:10px;font-size:14px;line-height:1.7;color:#333;min-height:24px}
.ok{color:#16a34a}.err{color:#dc2626}
.tip{margin-top:22px;font-size:12px;color:#aeaeb6;line-height:1.7}
</style></head><body><div class="card">
<h1>添加发布账号</h1>
<p class="sub">点下面按钮 → 会弹出登录页 → 用手机扫码登录你的号 → 自动加好并绑定这台电脑。<b>全程不用打字。</b></p>
<button class="dy" onclick="add('douyin','抖音',this)">＋ 登录抖音</button>
<button class="wv" onclick="add('wechat_video','视频号',this)">＋ 登录视频号</button>
<div id="msg"></div>
<p class="tip">扫码成功后，账号会自动出现在 BossMate 后台并绑定本机，可重复点按钮添加多个号。本页只在本机有效，可随时关闭。</p>
</div><script>
async function add(p,label,btn){
  var m=document.getElementById('msg');
  btn.disabled=true; m.className=''; m.textContent='正在打开'+label+'登录页，请稍候…';
  try{
    var r=await fetch('/add?platform='+p,{method:'POST'});
    var j=await r.json();
    if(j.ok){ m.className='ok'; m.innerHTML='✅ 已打开'+label+'登录页，请在弹出的浏览器里用手机扫码。<br>扫完这个号就加好了，可以再点按钮加下一个。'; }
    else{ m.className='err'; m.textContent='出错了：'+(j.message||'未知'); }
  }catch(e){ m.className='err'; m.textContent='请求失败，请确认 BossMate 程序窗口还开着。'; }
  finally{ setTimeout(function(){btn.disabled=false;},2500); }
}
</script></body></html>`;

/** 在系统默认浏览器打开 URL(跨平台) */
export function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* 打不开就算了, 客户可手动开 */ });
}

/**
 * 启动本地控制台。onAdd(platform) 由 cli 注入: 建号 + 弹登录页(后台执行, 不阻塞 HTTP 响应)。
 * 返回 { server, port } 或 null(端口都被占用 → 不影响发布)。
 */
export async function startControlServer(
  onAdd: (platform: "douyin" | "wechat_video") => void,
): Promise<{ server: Server; port: number } | null> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "POST" && u.pathname === "/add") {
      const platform = u.searchParams.get("platform");
      if (platform !== "douyin" && platform !== "wechat_video") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "平台无效" }));
        return;
      }
      onAdd(platform); // 后台执行(建号+弹登录), 立即回响应, 不等扫码
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  };

  for (const port of PORTS) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = createServer(handler);
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        (startControlServer as any)._ready = { server, port };
        resolve(true);
      });
    });
    if (ok) {
      const ready = (startControlServer as any)._ready as { server: Server; port: number };
      return ready;
    }
  }
  return null;
}
