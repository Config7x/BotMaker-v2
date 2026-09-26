# -*- coding: utf-8 -*-
"""
پنل وب گرافیکی Auto-Scraper — بدون وابستگی خارجی (فقط stdlib)
اجرا:  python3 web.py  →  http://SERVER_IP:8080/?token=XXXX
دسترسی: فقط با token صحیح
تب‌ها: نمای کلی / کانفیگ‌های داغ / آنالیز پروتکل
"""
import json
import secrets
import socket
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db
import geo

PORT = 8080


def ensure_token() -> str:
    tok = db.get_setting("web_token")
    if not tok:
        tok = secrets.token_hex(8)
        db.set_setting("web_token", tok)
    return tok


def local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _svc(name: str) -> str:
    try:
        r = subprocess.run(["systemctl", "is-active", name],
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip()
    except Exception:
        return "unknown"


def api_payload() -> dict:
    s = db.stats()
    sources = db.list_sources()
    pend = db.list_pending()
    tc_raw = db.get_setting("test_channel")
    target = None
    if tc_raw:
        try:
            target = json.loads(tc_raw)
        except Exception:
            target = None
    pending_list = []
    for p in pend[:25]:
        pending_list.append({
            "id": p["id"], "source": p["source_title"],
            "n": len(json.loads(p["configs"])), "created": int(p["created"] or 0)})

    dist = db.protocol_distribution()
    total_dist = sum(d["count"] for d in dist) or 1
    for d in dist:
        d["pct"] = round(d["count"] * 100 / total_dist, 1)

    recent = []
    now = int(__import__("time").time())
    for r in db.list_recent(12):
        recent.append({
            "name": r["name"], "protocol": r["protocol"],
            "country": r["country"], "city": r["city"],
            "flag": geo.flag_emoji(r["country_code"]),
            "is_new": (now - int(r["posted_date"] or 0)) < 3600,
        })

    return {
        "stats": s,
        "sources": [{"id": r["id"], "identifier": r["identifier"],
                     "enabled": r["enabled"]} for r in sources],
        "pending": pending_list,
        "services": {"bot": _svc("autoscraper-bot"),
                      "scraper": _svc("autoscraper-scraper"),
                      "web": _svc("autoscraper-web")},
        "test_mode": db.get_setting("test_mode", "0"),
        "target": target,
        "auto": db.get_setting("auto", "off"),
        "last_activity": db.get_setting("last_activity"),
        "distribution": dist,
        "recent": recent,
        "admins": [{"user_id": a["user_id"], "name": a["name"]} for a in db.list_admins()],
    }


HTML_PAGE = """<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auto-Scraper | پنل مدیریت</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:Tahoma,'Segoe UI',sans-serif}
body{background:linear-gradient(135deg,#0f1226 0%,#1a1033 55%,#071a2e 100%);min-height:100vh;color:#e8eaf6;padding:20px}
.wrap{max-width:980px;margin:0 auto}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px}
h1{font-size:22px;background:linear-gradient(90deg,#8ab4ff,#c792ea,#64f5c8);-webkit-background-clip:text;background-clip:text;color:transparent}
.live{display:inline-flex;align-items:center;gap:6px;background:rgba(61,220,132,.15);color:#3ddc84;border:1px solid rgba(61,220,132,.4);border-radius:20px;padding:4px 12px;font-size:12px}
.live .p{width:8px;height:8px;border-radius:50%;background:#3ddc84;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.refresh{background:linear-gradient(90deg,#7c5cff,#a06bff);border:none;color:#fff;border-radius:20px;padding:8px 16px;font-size:12px;cursor:pointer}
.tabs{display:flex;gap:8px;margin-bottom:18px;background:rgba(255,255,255,.05);border-radius:14px;padding:6px}
.tab{flex:1;text-align:center;padding:9px 6px;border-radius:10px;font-size:13px;cursor:pointer;color:#9aa4c7;transition:.2s}
.tab.active{background:linear-gradient(90deg,#7c5cff,#a06bff);color:#fff}
.view{display:none}.view.active{display:block}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:18px;text-align:center;backdrop-filter:blur(8px)}
.card .v{font-size:30px;font-weight:bold;margin:6px 0}
.card .l{color:#9aa4c7;font-size:12px}
.c-blue .v{color:#8ab4ff}.c-green .v{color:#64f5c8}.c-purple .v{color:#c792ea}.c-orange .v{color:#ffcc80}
.panel{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:18px;margin-bottom:18px;backdrop-filter:blur(8px)}
.panel h2{font-size:15px;color:#c5cdea;margin-bottom:12px;border-right:3px solid #8ab4ff;padding-right:8px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:6px}
.on{background:#3ddc84;box-shadow:0 0 8px #3ddc84}.off{background:#ff5252;box-shadow:0 0 8px #ff5252}
.svc{display:flex;flex-wrap:wrap;gap:10px}
.svc div{background:rgba(0,0,0,.25);border-radius:10px;padding:8px 14px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#9aa4c7;text-align:right;padding:8px;font-weight:normal;border-bottom:1px solid rgba(255,255,255,.1)}
td{padding:9px 8px;border-bottom:1px solid rgba(255,255,255,.05)}
.tag{background:rgba(138,180,255,.15);color:#8ab4ff;border-radius:6px;padding:2px 8px;font-size:11px}
.badge{background:rgba(255,133,162,.15);color:#ff85a2;border-radius:6px;padding:2px 8px;font-size:11px}
.empty{color:#79809e;text-align:center;padding:16px;font-size:13px}
footer{text-align:center;color:#5c6382;font-size:11px;margin-top:8px}
#err{display:none;text-align:center;color:#ff85a2;padding:20px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.cfgcard{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:14px;position:relative;overflow:hidden}
.cfgcard .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.newtag{background:linear-gradient(90deg,#ff8a5c,#ff5c8a);color:#fff;font-size:10px;border-radius:8px;padding:2px 8px}
.flagbig{font-size:26px}
.proto{display:inline-block;margin-top:6px;font-size:11px;border-radius:6px;padding:3px 10px}
.p-vless{background:rgba(100,245,200,.15);color:#64f5c8}
.p-trojan{background:rgba(199,146,234,.15);color:#c792ea}
.p-vmess{background:rgba(255,204,128,.15);color:#ffcc80}
.p-hysteria2,.p-hy2{background:rgba(255,133,162,.15);color:#ff85a2}
.p-ss,.p-ssr,.p-tuic{background:rgba(138,180,255,.15);color:#8ab4ff}
.loc{font-size:12px;color:#c5cdea;margin-top:6px}
.name{font-size:12px;color:#9aa4c7;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.donutwrap{display:flex;align-items:center;gap:26px;flex-wrap:wrap;justify-content:center}
.donut{width:170px;height:170px;border-radius:50%;position:relative;display:flex;align-items:center;justify-content:center}
.donut .hole{width:100px;height:100px;background:#161832;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;color:#9aa4c7;text-align:center}
.legend{display:flex;flex-direction:column;gap:8px;font-size:13px}
.legend .dotc{display:inline-block;width:10px;height:10px;border-radius:3px;margin-left:8px}
</style>
</head>
<body>
<div class="wrap">
<div class="topbar">
<h1>🤖 ربات مانیتورینگ Auto-Scraper</h1>
<div style="display:flex;align-items:center;gap:8px">
<span class="live"><span class="p"></span> LIVE</span>
<button class="refresh" onclick="load()">🔄 بروزرسانی</button>
</div>
</div>

<div class="tabs">
<div class="tab active" data-tab="overview" onclick="showTab('overview')">📊 نمای کلی</div>
<div class="tab" data-tab="configs" onclick="showTab('configs')">🔥 کانفیگ‌های داغ</div>
<div class="tab" data-tab="analytics" onclick="showTab('analytics')">🧭 آنالیز</div>
</div>

<div id="err">⛔️ خطا در دریافت داده‌ها</div>
<div id="content" style="display:none">

<div class="view active" id="view-overview">
<div class="cards">
<div class="card c-blue"><div class="l">📊 کانفیگ منتشرشده</div><div class="v" id="st-total">—</div></div>
<div class="card c-green"><div class="l">⏱ ۲۴ ساعت اخیر</div><div class="v" id="st-today">—</div></div>
<div class="card c-purple"><div class="l">📡 منابع</div><div class="v" id="st-src">—</div></div>
<div class="card c-orange"><div class="l">🕐 در صف تایید</div><div class="v" id="st-pend">—</div></div>
</div>
<div class="panel">
<h2>⚙️ وضعیت سیستم</h2>
<div class="svc" id="services"></div>
<div style="margin-top:12px;font-size:13px" id="modes"></div>
</div>
<div class="panel">
<h2>📡 منابع رصد</h2>
<table id="tbl-src"><thead><tr><th>#</th><th>شناسه</th><th>وضعیت</th></tr></thead><tbody></tbody></table>
<div class="empty" id="empty-src" style="display:none">📭 منبعی ثبت نشده</div>
</div>
<div class="panel">
<h2>🕐 صف تایید</h2>
<table id="tbl-pend"><thead><tr><th>#</th><th>منبع</th><th>کانفیگ</th><th>زمان</th></tr></thead><tbody></tbody></table>
<div class="empty" id="empty-pend" style="display:none">📭 صف خالی است</div>
</div>
</div>

<div class="view" id="view-configs">
<div class="panel">
<h2>🔥 کانفیگ‌های داغ (آخرین‌های منتشرشده)</h2>
<div class="grid2" id="hotgrid"></div>
<div class="empty" id="empty-hot" style="display:none">📭 هنوز کانفیگی منتشر نشده</div>
</div>
</div>

<div class="view" id="view-analytics">
<div class="panel">
<h2>🧭 توزیع پروتکل</h2>
<div class="donutwrap">
<div class="donut" id="donut"><div class="hole" id="donut-total">—</div></div>
<div class="legend" id="legend"></div>
</div>
</div>
</div>

<footer>رفرش خودکار هر ۵ ثانیه — Config7x Auto-Scraper</footer>
</div>
</div>
<script>
const TOKEN = new URLSearchParams(location.search).get('token');
const COLORS = ['#64f5c8','#8ab4ff','#c792ea','#ff85a2','#ffcc80','#ff8a5c'];
function showTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.id==='view-'+name));
}
function protoClass(p){
  p=(p||'').toLowerCase();
  return 'p-'+(['vless','trojan','vmess','hysteria2','hy2','ss','ssr','tuic'].includes(p)?p:'ss');
}
async function load(){
 try{
  const r = await fetch('/api/stats?token='+TOKEN+'&_='+Date.now());
  if(!r.ok) throw 0;
  const d = await r.json();
  document.getElementById('err').style.display='none';
  document.getElementById('content').style.display='block';

  document.getElementById('st-total').textContent=d.stats.total;
  document.getElementById('st-today').textContent=d.stats.today;
  document.getElementById('st-src').textContent=d.stats.sources;
  document.getElementById('st-pend').textContent=d.stats.pending;

  const svc=document.getElementById('services');
  svc.innerHTML=Object.entries(d.services).map(([k,v])=>
   '<div><span class="dot '+(v==='active'?'on':'off')+'"></span>'+
   ({bot:'🤖 ربات مدیریت',scraper:'👀 یوزربات رصد',web:'🌐 پنل وب'}[k]||k)+
   ' — '+(v==='active'?'فعال':'غیرفعال')+'</div>').join('');

  let m='🎯 کانال هدف: <b>'+(d.test_mode==='1'?(d.target?d.target.username:'تست'):'@Config7x (اصلی)')+'</b>';
  m+=(d.test_mode==='1'?' <span class="badge">حالت تست</span>':'');
  m+=' &nbsp;|&nbsp; ⚙️ انتشار خودکار: <b>'+(d.auto==='on'?'روشن':'خاموش')+'</b>';
  m+=' &nbsp;|&nbsp; 👥 ادمین‌ها: <b>'+d.admins.length+'</b>';
  if(d.last_activity){
    const la=Date.now()/1000-parseInt(d.last_activity);
    let t;
    if(la<60)t='همین الان';
    else if(la<3600)t=Math.floor(la/60)+' دقیقه پیش';
    else if(la<86400)t=Math.floor(la/3600)+' ساعت پیش';
    else t=Math.floor(la/86400)+' روز پیش';
    m+=' &nbsp;|&nbsp; 👁 آخرین رصد: <b>'+t+'</b>';
  }
  document.getElementById('modes').innerHTML=m;

  const tb=document.querySelector('#tbl-src tbody');
  tb.innerHTML=d.sources.map(s=>'<tr><td>'+s.id+'</td><td>'+s.identifier+
   '</td><td>'+(s.enabled?'<span class="tag">فعال</span>':'<span class="badge">غیرفعال</span>')+'</td></tr>').join('');
  document.getElementById('empty-src').style.display=d.sources.length?'none':'block';

  const tp=document.querySelector('#tbl-pend tbody');
  tp.innerHTML=d.pending.map(p=>'<tr><td>'+p.id+'</td><td>'+p.source+'</td><td>'+p.n+
   '</td><td>'+new Date(p.created*1000).toLocaleTimeString('fa-IR')+'</td></tr>').join('');
  document.getElementById('empty-pend').style.display=d.pending.length?'none':'block';

  const hg=document.getElementById('hotgrid');
  hg.innerHTML=d.recent.map(c=>
   '<div class="cfgcard">'+
   (c.is_new?'<div class="top"><span class="flagbig">'+c.flag+'</span><span class="newtag">🆕 جدید</span></div>':
     '<div class="top"><span class="flagbig">'+c.flag+'</span></div>')+
   '<div class="loc">'+(c.city?c.city+' / ':'')+c.country+'</div>'+
   '<div class="name">'+(c.name||'')+'</div>'+
   '<span class="proto '+protoClass(c.protocol)+'">'+(c.protocol||'').toUpperCase()+'</span>'+
   '</div>').join('');
  document.getElementById('empty-hot').style.display=d.recent.length?'none':'block';

  const dist=d.distribution||[];
  const total=dist.reduce((a,x)=>a+x.count,0);
  document.getElementById('donut-total').innerHTML=total+'<br><span style="font-size:10px">کل</span>';
  let acc=0, stops=[];
  dist.forEach((x,i)=>{
    const start=acc, end=acc+x.pct;
    stops.push(COLORS[i%COLORS.length]+' '+start+'% '+end+'%');
    acc=end;
  });
  document.getElementById('donut').style.background = stops.length
    ? 'conic-gradient('+stops.join(',')+')' : '#2a2d4a';
  document.getElementById('legend').innerHTML = dist.map((x,i)=>
   '<div><span class="dotc" style="background:'+COLORS[i%COLORS.length]+'"></span>'+
   '<b>'+x.protocol.toUpperCase()+'</b> — '+x.count+' ('+x.pct+'%)</div>').join('')
   || '<div class="empty">📭 هنوز داده‌ای نیست</div>';

 }catch(e){document.getElementById('err').style.display='block';}
}
load(); setInterval(load,5000);
</script>
</body>
</html>"""


TOKEN = None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        tok = (parse_qs(u.query).get("token") or [""])[0]
        if tok != TOKEN:
            self._send(403, "⛔️ Forbidden".encode(), "text/plain; charset=utf-8")
            return
        if u.path in ("/", "/index.html"):
            self._send(200, HTML_PAGE.encode(), "text/html; charset=utf-8")
        elif u.path == "/api/stats":
            self._send(200, json.dumps(api_payload(), ensure_ascii=False).encode(),
                       "application/json; charset=utf-8")
        else:
            self._send(404, "Not Found".encode(), "text/plain")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    TOKEN = ensure_token()
    db.set_setting("web_url", f"http://{local_ip()}:{PORT}/?token={TOKEN}")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"🌐 Web panel: http://{local_ip()}:{PORT}/?token={TOKEN}")
    print("   (token در پیام ربات مدیریت هم موجوده — /panel)")
    server.serve_forever()
