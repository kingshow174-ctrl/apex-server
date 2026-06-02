const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Full CORS - allow all origins
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,x-admin-passkey,Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xglwvuwxrlvyczhlhijp.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ADMIN_PASSKEY = process.env.ADMIN_PASSKEY || "APEXFX_ADMIN_2026_PRINCEX";
const PESAPAL_KEY = process.env.PESAPAL_CONSUMER_KEY || "";
const PESAPAL_SECRET = process.env.PESAPAL_CONSUMER_SECRET || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://apex-trading-eta.vercel.app";
const TWELVE_KEY = process.env.TWELVE_KEY || "62e0549bbdc04d76a224157e22da6bbd";
const ONESIGNAL_APP_ID = "9b174534-5638-46d0-9efb-071db011b02c";
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || "os_v2_app_tmlukncwhbdnbhx3a4o3aenqft7oc4a2664uo5nv3expvl2rh7arc4u3iwg5een2ybhtoxqvdslrb5zncgrhu4fzjrdt7lljm2ojtcq";
const PESAPAL_BASE = "https://pay.pesapal.com/v3";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const PLANS = {
  weekly:   { name:"Weekly",   price:299,   days:7 },
  monthly:  { name:"Monthly",  price:799,   days:30 },
  annual:   { name:"Annual",   price:6999,  days:365 },
  lifetime: { name:"Lifetime", price:14999, days:null },
};

let logs = [];
function log(msg) {
  const e = `${new Date().toISOString()} ${msg}`;
  console.log(e); logs.unshift(e);
  if (logs.length > 200) logs.pop();
}

const wait = ms => new Promise(r => setTimeout(r, ms));

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-passkey"] !== ADMIN_PASSKEY) return res.status(401).json({ error:"Unauthorized" });
  next();
}

// PesaPal token cache
let ppToken = null, ppExpiry = null;
async function getPPToken() {
  if (ppToken && ppExpiry && Date.now() < ppExpiry) return ppToken;
  log("Getting PesaPal token...");
  const res = await axios.post(`${PESAPAL_BASE}/api/Auth/RequestToken`,
    { consumer_key: PESAPAL_KEY, consumer_secret: PESAPAL_SECRET },
    { headers:{ "Content-Type":"application/json", Accept:"application/json" }, timeout:20000 }
  );
  ppToken = res.data.token;
  ppExpiry = Date.now() + 4*60*60*1000;
  log("✅ PesaPal token obtained");
  return ppToken;
}

// IPN registration
let ipnId = null;
async function registerIPN() {
  try {
    const token = await getPPToken();
    const res = await axios.post(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`,
      { url:`${FRONTEND_URL.replace("vercel.app","onrender.com")}/pesapal/ipn`, ipn_notification_type:"GET" },
      { headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, timeout:10000 }
    );
    ipnId = res.data.ipn_id;
    log(`✅ IPN registered: ${ipnId}`);
  } catch(e) { log(`IPN error: ${e.message}`); }
}

// ===== PAYMENT ROUTES =====
app.post("/pesapal/initiate", async (req, res) => {
  log(`Payment initiate request: ${JSON.stringify(req.body)}`);
  const { user_id, email, name, plan } = req.body;
  if (!user_id || !email || !plan || !PLANS[plan]) {
    return res.json({ error:"Invalid request — missing fields" });
  }
  try {
    const token = await getPPToken();
    if (!ipnId) await registerIPN();
    const planData = PLANS[plan];
    const orderId = `APEXFX-${Date.now()}-${user_id.slice(0,8)}`;

    await supabase.from("payments").insert({
      user_id, plan, amount:planData.price,
      pesapal_order_id:orderId, status:"pending"
    });

    const orderRes = await axios.post(`${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`, {
      id: orderId,
      currency: "KES",
      amount: planData.price,
      description: `APEX FX ${planData.name} Plan`,
      callback_url: `${FRONTEND_URL}/payment/callback`,
      notification_id: ipnId || "",
      billing_address: {
        email_address: email,
        first_name: (name||"User").split(" ")[0],
        last_name: (name||"").split(" ")[1] || "",
      }
    }, { headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, timeout:20000 });

    log(`💳 Payment created: ${orderId}`);
    res.json({ redirect_url:orderRes.data.redirect_url, order_tracking_id:orderRes.data.order_tracking_id, order_id:orderId });
  } catch(e) {
    log(`❌ Payment error: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    res.json({ error:`Payment failed: ${e.message}` });
  }
});

app.get("/pesapal/ipn", async (req, res) => {
  const { orderTrackingId, orderMerchantReference } = req.query;
  log(`IPN: ${orderTrackingId} ${orderMerchantReference}`);
  try {
    const token = await getPPToken();
    const statusRes = await axios.get(`${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      { headers:{ Authorization:`Bearer ${token}` }, timeout:10000 }
    );
    if (statusRes.data.payment_status_description === "Completed") {
      const { data:payment } = await supabase.from("payments").select("*").eq("pesapal_order_id", orderMerchantReference).single();
      if (payment && payment.status !== "completed") {
        await supabase.from("payments").update({ status:"completed", pesapal_tracking_id:orderTrackingId }).eq("pesapal_order_id", orderMerchantReference);
        await activateSub(payment.user_id, payment.plan);
      }
    }
  } catch(e) { log(`IPN error: ${e.message}`); }
  res.send("OK");
});

app.post("/pesapal/verify", async (req, res) => {
  const { order_tracking_id, order_id, user_id } = req.body;
  try {
    const token = await getPPToken();
    const statusRes = await axios.get(`${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${order_tracking_id}`,
      { headers:{ Authorization:`Bearer ${token}` }, timeout:10000 }
    );
    if (statusRes.data.payment_status_description === "Completed") {
      const { data:payment } = await supabase.from("payments").select("*").eq("pesapal_order_id", order_id).single();
      if (payment && payment.status !== "completed") {
        await supabase.from("payments").update({ status:"completed", pesapal_tracking_id:order_tracking_id }).eq("pesapal_order_id", order_id);
        await activateSub(payment.user_id, payment.plan);
      }
      return res.json({ success:true, status:"completed" });
    }
    res.json({ success:false, status:statusRes.data.payment_status_description });
  } catch(e) { res.json({ error:e.message }); }
});

async function activateSub(userId, plan) {
  const p = PLANS[plan];
  const now = new Date();
  const expiry = p.days ? new Date(now.getTime() + p.days*86400000) : null;
  await supabase.from("subscriptions").upsert({
    user_id:userId, plan, status:"active",
    price_kes:p.price, purchase_date:now.toISOString(),
    expiry_date:expiry?.toISOString()||null
  }, { onConflict:"user_id" });
  log(`✅ Sub activated: ${userId} ${plan}`);
}

app.get("/subscription/:userId", async (req, res) => {
  try {
    const { data:profile } = await supabase.from("profiles").select("role").eq("id", req.params.userId).single();
    if (profile?.role === "admin") return res.json({ active:true, plan:"admin", role:"admin", expires:null });
    const { data:sub } = await supabase.from("subscriptions").select("*").eq("user_id", req.params.userId).single();
    if (!sub) return res.json({ active:false, plan:null, role:profile?.role||"user" });
    const expired = sub.expiry_date && new Date(sub.expiry_date) < new Date();
    if (expired && sub.status==="active") {
      await supabase.from("subscriptions").update({ status:"expired" }).eq("user_id", req.params.userId);
      return res.json({ active:false, plan:sub.plan, status:"expired", expires:sub.expiry_date });
    }
    res.json({ active:sub.status==="active", plan:sub.plan, status:sub.status, expires:sub.expiry_date, role:profile?.role||"user" });
  } catch(e) { res.json({ error:e.message }); }
});

// ===== ADMIN ROUTES =====
app.post("/admin/verify", (req, res) => {
  res.json({ valid: req.body.passkey === ADMIN_PASSKEY });
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  const { data:profiles } = await supabase.from("profiles").select("*").order("created_at", { ascending:false });
  const { data:subs } = await supabase.from("subscriptions").select("*");
  res.json({ users:(profiles||[]).map(p=>({ ...p, subscription:(subs||[]).find(s=>s.user_id===p.id)||null })) });
});

app.get("/admin/payments", requireAdmin, async (req, res) => {
  const { data } = await supabase.from("payments").select("*, profiles(email,full_name)").order("created_at", { ascending:false });
  res.json({ payments:data||[] });
});

app.post("/admin/grant", requireAdmin, async (req, res) => {
  const { user_id, plan } = req.body;
  if (!user_id||!plan||!PLANS[plan]) return res.json({ error:"Invalid" });
  await activateSub(user_id, plan);
  await supabase.from("payments").insert({ user_id, plan, amount:0, status:"admin_granted" });
  res.json({ success:true });
});

app.post("/admin/revoke", requireAdmin, async (req, res) => {
  await supabase.from("subscriptions").update({ status:"revoked" }).eq("user_id", req.body.user_id);
  res.json({ success:true });
});

app.post("/admin/promote", requireAdmin, async (req, res) => {
  await supabase.from("profiles").update({ role:"admin" }).eq("id", req.body.user_id);
  res.json({ success:true });
});

app.post("/admin/demote", requireAdmin, async (req, res) => {
  await supabase.from("profiles").update({ role:"user" }).eq("id", req.body.user_id);
  res.json({ success:true });
});

app.get("/admin/stats", requireAdmin, async (req, res) => {
  const { count:users } = await supabase.from("profiles").select("*", { count:"exact", head:true });
  const { count:active } = await supabase.from("subscriptions").select("*", { count:"exact", head:true }).eq("status","active");
  const { data:payments } = await supabase.from("payments").select("amount").eq("status","completed");
  res.json({ users, active_subs:active, total_revenue:(payments||[]).reduce((a,p)=>a+(p.amount||0),0) });
});

// ===== SIGNALS ENGINE =====
const PAIRS = [
  { symbol:"EUR/USD", type:"forex" },{ symbol:"GBP/USD", type:"forex" },
  { symbol:"XAU/USD", type:"forex" },{ symbol:"BTC/USD", type:"crypto" },
  { symbol:"ETH/USD", type:"crypto" },
];
const TIMEFRAMES = ["5min","15min","1h"];
let tfIndex=0, signals={}, lastUpdated=null, isAnalyzing=false;

function calcEMA(d,p){if(d.length<p)return null;const k=2/(p+1);let e=d.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p-1;i>=0;i--)e=d[i]*k+e*(1-k);return e;}
function calcSMA(d,p){if(d.length<p)return null;return d.slice(0,p).reduce((a,b)=>a+b,0)/p;}
function calcRSI(c,p=14){if(c.length<p+1)return null;let g=0,l=0;for(let i=0;i<p;i++){const d=c[i]-c[i+1];if(d>0)g+=d;else l+=Math.abs(d);}const rs=(g/p)/((l/p)||0.001);return 100-(100/(1+rs));}
function calcATR(h,l,c,p=14){if(c.length<p+1)return null;const t=[];for(let i=0;i<p;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i+1]),Math.abs(l[i]-c[i+1])));return t.reduce((a,b)=>a+b,0)/p;}
function calcMACD(c){if(c.length<26)return null;const e12=calcEMA(c,12),e26=calcEMA(c,26);if(!e12||!e26)return null;return{histogram:e12-e26};}

function sniperAnalysis(symbol,interval,candles){
  try{
    const closes=candles.map(c=>parseFloat(c.close));
    const highs=candles.map(c=>parseFloat(c.high));
    const lows=candles.map(c=>parseFloat(c.low));
    const latest=closes[0];
    const ema9=calcEMA(closes,9),ema21=calcEMA(closes,21),ema50=calcEMA(closes,50);
    const sma20=calcSMA(closes,20),rsi=calcRSI(closes),macd=calcMACD(closes);
    const atr=calcATR(highs,lows,closes);
    const votes=[];
    if(ema9&&ema21){votes.push(ema9>ema21?1:-1);}
    if(ema50){votes.push(latest>ema50?1:-1);}
    if(rsi!==null){votes.push(rsi<30?1:rsi>70?-1:rsi<45?0.5:-0.5);}
    if(macd){votes.push(macd.histogram>0?1:-1);}
    if(sma20){votes.push(latest>sma20?1:-1);}
    const mom=((closes[0]-closes[4])/closes[4])*100;
    votes.push(mom>0.1?1:mom<-0.1?-1:0);
    const bull=votes.filter(v=>v>0).length,bear=votes.filter(v=>v<0).length,total=votes.length;
    const bullScore=Math.round(bull/total*100),bearScore=Math.round(bear/total*100);
    let signal="WAIT",confidence=50;
    if(bullScore>=80){signal="BUY";confidence=bullScore;}
    else if(bearScore>=80){signal="SELL";confidence=bearScore;}
    if(!atr)return null;
    const swingH=Math.max(...highs.slice(0,5)),swingL=Math.min(...lows.slice(0,5));
    let sl,tp1,tp2,tp3;
    if(signal==="BUY"){sl=Math.min(swingL,latest-atr*1.5);const r=latest-sl;tp1=latest+r*1.5;tp2=latest+r*3;tp3=latest+r*5;}
    else if(signal==="SELL"){sl=Math.max(swingH,latest+atr*1.5);const r=sl-latest;tp1=latest-r*1.5;tp2=latest-r*3;tp3=latest-r*5;}
    else{sl=latest-atr*1.5;tp1=latest+atr*1.5;tp2=latest+atr*3;tp3=latest+atr*5;}
    const dur={"1min":"5-15m","5min":"15-45m","15min":"1-3h","30min":"2-6h","1h":"4-12h","4h":"1-3d","1day":"1-2w"};
    return{signal,confidence,bullScore,bearScore,entryPrice:latest.toFixed(5),sl:sl.toFixed(5),tp1:tp1.toFixed(5),tp2:tp2.toFixed(5),tp3:tp3.toFixed(5),duration:dur[interval]||"Variable",reason:`Bull:${bullScore}% Bear:${bearScore}% RSI:${rsi?rsi.toFixed(0):"N/A"}`};
  }catch(e){log(`Analysis error: ${e.message}`);return null;}
}

async function fetchCandles(symbol,interval){
  try{
    const res=await axios.get(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=60&apikey=${TWELVE_KEY}`,{timeout:15000});
    if(res.data.status==="error"){log(`TD Error ${symbol}: ${res.data.message}`);return null;}
    return res.data.values||null;
  }catch(e){log(`Fetch error ${symbol}: ${e.message}`);return null;}
}

async function runAnalysis(){
  if(isAnalyzing)return;
  isAnalyzing=true;
  const tf=TIMEFRAMES[tfIndex%TIMEFRAMES.length];tfIndex++;
  log(`🎯 Analysis TF:${tf}`);
  for(const pair of PAIRS){
    try{
      await wait(10000);
      const candles=await fetchCandles(pair.symbol,tf);
      if(!candles||candles.length<30)continue;
      const a=sniperAnalysis(pair.symbol,tf,candles);
      if(!a)continue;
      const key=`${pair.symbol}_${tf}`,prev=signals[key]?.signal;
      signals[key]={...a,symbol:pair.symbol,timeframe:tf,type:pair.type,timestamp:new Date().toISOString(),price:candles[0]?.close};
      log(`✅ ${pair.symbol} ${tf}: ${a.signal} ${a.confidence}%`);
      if(a.signal!=="WAIT"&&a.confidence>=80&&a.signal!==prev){
        try{await axios.post("https://onesignal.com/api/v1/notifications",{app_id:ONESIGNAL_APP_ID,included_segments:["All"],headings:{en:`⚡ APEX FX — ${pair.symbol}`},contents:{en:`${a.signal==="BUY"?"▲":"▼"} ${a.signal} ${a.confidence}%`},url:"https://apex-trading-eta.vercel.app",priority:10},{headers:{Authorization:`Bearer ${ONESIGNAL_API_KEY}`,"Content-Type":"application/json"},timeout:10000});}catch(e){}
      }
    }catch(e){log(`Error ${pair.symbol}: ${e.message}`);}
  }
  lastUpdated=new Date().toISOString();isAnalyzing=false;
  log(`✅ Done. Signals: ${Object.keys(signals).length}`);
}

app.get("/signals/analyze", async (req,res) => {
  const {symbol,interval}=req.query;
  if(!symbol||!interval)return res.json({error:"symbol and interval required"});
  try{
    const candles=await fetchCandles(symbol,interval);
    if(!candles||candles.length<30)return res.json({error:`No data for ${symbol}`});
    const market=sniperAnalysis(symbol,interval,candles);
    if(!market)return res.json({error:"Analysis failed"});
    const entry=parseFloat(market.entryPrice),atr=parseFloat(market.sl?Math.abs(entry-parseFloat(market.sl)):0.001);
    const pending={...market,entryPrice:(signal==="BUY"?entry-atr*0.3:entry+atr*0.3).toFixed(5),pendingType:market.signal==="BUY"?"BUY LIMIT":"SELL LIMIT"};
    res.json({symbol,timeframe:interval,price:candles[0]?.close,timestamp:new Date().toISOString(),market,pending});
  }catch(e){res.json({error:e.message});}
});

app.get("/", (req,res) => res.json({status:"APEX FX Server ✅",lastUpdated,signals:Object.keys(signals).length,isAnalyzing,pesapal:!!ppToken}));
app.get("/signals", (req,res) => res.json({signals,lastUpdated,isAnalyzing}));
app.get("/logs", (req,res) => res.json({logs}));
app.get("/health", (req,res) => res.json({ok:true,time:new Date().toISOString()}));
app.get("/trigger", (req,res) => {runAnalysis();res.json({message:"triggered"});});
app.post("/trigger", (req,res) => {runAnalysis();res.json({message:"triggered"});});

cron.schedule("*/5 * * * *", () => {log("⏰ Scheduled");runAnalysis();});

// Keep-alive ping every 14 minutes to prevent Render sleep
setInterval(async () => {
  try {
    await axios.get(`http://localhost:${process.env.PORT||3000}/health`, {timeout:5000});
    log("🏓 Keep-alive ping");
  } catch(e) {}
}, 14*60*1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log(`🚀 APEX FX Server port ${PORT}`);
  try { await registerIPN(); } catch(e) { log(`Startup IPN error: ${e.message}`); }
  setTimeout(runAnalysis, 5000);
});
