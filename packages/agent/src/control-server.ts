/**
 * 6-18 / 6-22: 客户自助加号 — Agent 内置一个只绑 127.0.0.1 的本地小网页(控制台)。
 *   打开即列出「本机还没登录的账号」, 客户点每个号后面的【登录】→ 弹出登录页扫码 → 绑定本机。
 *   也可点底部「新增抖音/视频号」加全新的号。全程客户零打字、老韩零操作, 仅本机可访问。
 *
 * 6-22 改: 启动不再自动弹一堆扫码页, 改为这个页面里逐个点登录(谁要登谁点)。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { exec } from "node:child_process";
import { logger } from "./log.js";

const PORTS = [17653, 17654, 17655];

export interface PendingAccount {
  id: string;
  platform: string;     // douyin | wechat_video
  accountName: string;
}

export interface ControlHandlers {
  /** 列出本机还没登录的已有账号(由 cli 注入: listAccounts ∩ 无本地档案) */
  listPending: () => Promise<PendingAccount[]>;
  /** 给某个已有账号弹登录扫码(后台执行, 不阻塞 HTTP 响应) */
  onLogin: (accountId: string) => void;
  /** 新增一个全新账号并弹登录(建号 + 扫码) */
  onAdd: (platform: "douyin" | "wechat_video") => void;
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>BossMate · 添加发布账号</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,system-ui,"Microsoft YaHei",sans-serif;background:#f5f6fa;margin:0;padding:36px 18px;color:#1b1b1f}
.card{max-width:460px;margin:0 auto;background:#fff;border-radius:18px;padding:30px 26px;box-shadow:0 6px 30px rgba(0,0,0,.07)}
h1{font-size:21px;margin:0 0 8px}.sub{color:#8a8a93;font-size:13.5px;line-height:1.6;margin:0 0 20px}
.sec{font-size:12.5px;font-weight:600;color:#8a8a93;margin:18px 0 10px;letter-spacing:.02em}
.row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #ececf1;border-radius:13px;margin-bottom:10px}
.row .nm{flex:1;min-width:0}
.row .nm b{display:block;font-size:15px;color:#1b1b1f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .nm span{font-size:12px;color:#aeaeb6}
.pill{font-size:11px;color:#fff;border-radius:6px;padding:2px 7px}
.pill.dy{background:#161823}.pill.wv{background:#fa9d3b}
.row button{padding:9px 18px;font-size:14px;font-weight:600;border:0;border-radius:10px;color:#fff;background:#3b6cfa;cursor:pointer;flex:0 0 auto}
.row button:disabled{opacity:.5;cursor:default}
.add{margin-top:8px}
.add button{width:100%;padding:15px;font-size:16px;font-weight:600;border:0;border-radius:13px;color:#fff;margin-bottom:12px;cursor:pointer}
.add .dy{background:#161823}.add .wv{background:#fa9d3b}
.empty{font-size:13px;color:#aeaeb6;padding:6px 2px 2px}
#msg{margin-top:12px;font-size:14px;line-height:1.7;color:#333;min-height:24px}
.ok{color:#16a34a}.err{color:#dc2626}
.tip{margin-top:22px;font-size:12px;color:#aeaeb6;line-height:1.7}
</style></head><body><div class="card">
<h1>添加发布账号</h1>
<p class="sub">下面列出还没在这台电脑登录的账号。点对应的【登录】→ 弹出登录页 → 用手机扫码即可。<b>全程不用打字。</b></p>

<div class="sec">待登录的账号</div>
<div id="list"><div class="empty">正在读取…</div></div>

<div class="sec">没有的号? 新增一个</div>
<div class="add">
  <button class="dy" onclick="add('douyin','抖音',this)">＋ 新增抖音</button>
  <button class="wv" onclick="add('wechat_video','视频号',this)">＋ 新增视频号</button>
</div>

<div id="msg"></div>
<p class="tip">扫码成功后账号即绑定本机, 可继续点下一个。本页只在本机有效, 可随时关闭。<a href="#" onclick="refresh();return false">刷新列表</a></p>
</div><script>
var LBL={douyin:'抖音',wechat_video:'视频号'};
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
async function refresh(){
  var box=document.getElementById('list');
  try{
    var r=await fetch('/accounts'); var list=await r.json();
    if(!Array.isArray(list)||list.length===0){ box.innerHTML='<div class="empty">这台电脑的账号都已登录 ✓(没有需要登录的号)。要加新号就点下面的按钮。</div>'; return; }
    box.innerHTML=list.map(function(a){
      var p=LBL[a.platform]||a.platform; var cls=a.platform==='wechat_video'?'wv':'dy';
      return '<div class="row"><span class="pill '+cls+'">'+p+'</span>'+
        '<div class="nm"><b>'+esc(a.accountName||'(未命名)')+'</b><span>未在本机登录</span></div>'+
        '<button onclick="login(\\''+a.id+'\\',\\''+esc(a.accountName||p)+'\\',this)">登录</button></div>';
    }).join('');
  }catch(e){ box.innerHTML='<div class="empty err">读取失败, 请确认 BossMate 程序窗口还开着。<a href="#" onclick="refresh();return false">重试</a></div>'; }
}
async function login(id,name,btn){
  var m=document.getElementById('msg'); btn.disabled=true; m.className=''; m.textContent='正在打开 '+name+' 的登录页, 请稍候…';
  try{
    var r=await fetch('/login?accountId='+encodeURIComponent(id),{method:'POST'}); var j=await r.json();
    if(j.ok){ m.className='ok'; m.innerHTML='✅ 已打开「'+esc(name)+'」登录页, 请在弹出的浏览器里用手机扫码。扫完即绑定本机。'; }
    else{ m.className='err'; m.textContent='出错了: '+(j.message||'未知'); btn.disabled=false; }
  }catch(e){ m.className='err'; m.textContent='请求失败, 请确认 BossMate 程序窗口还开着。'; btn.disabled=false; }
}
async function add(p,label,btn){
  var m=document.getElementById('msg'); btn.disabled=true; m.className=''; m.textContent='正在打开'+label+'登录页, 请稍候…';
  try{
    var r=await fetch('/add?platform='+p,{method:'POST'}); var j=await r.json();
    if(j.ok){ m.className='ok'; m.innerHTML='✅ 已打开'+label+'登录页, 请在弹出的浏览器里用手机扫码。<br>扫完这个号就加好了。'; setTimeout(refresh,3000); }
    else{ m.className='err'; m.textContent='出错了: '+(j.message||'未知'); }
  }catch(e){ m.className='err'; m.textContent='请求失败, 请确认 BossMate 程序窗口还开着。'; }
  finally{ setTimeout(function(){btn.disabled=false;},2500); }
}
refresh();
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
 * 启动本地控制台。返回 { server, port } 或 null(端口都被占用 → 不影响发布)。
 */
export async function startControlServer(
  handlers: ControlHandlers,
): Promise<{ server: Server; port: number } | null> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && u.pathname === "/accounts") {
      void handlers.listPending().then((list) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(list ?? []));
      }).catch(() => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end("[]");
      });
      return;
    }
    if (req.method === "POST" && u.pathname === "/login") {
      const accountId = u.searchParams.get("accountId");
      if (!accountId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "缺 accountId" }));
        return;
      }
      handlers.onLogin(accountId); // 后台弹登录, 立即回响应
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && u.pathname === "/add") {
      const platform = u.searchParams.get("platform");
      if (platform !== "douyin" && platform !== "wechat_video") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "平台无效" }));
        return;
      }
      handlers.onAdd(platform); // 后台执行(建号+弹登录), 立即回响应
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
      return (startControlServer as any)._ready as { server: Server; port: number };
    }
  }
  return null;
}
