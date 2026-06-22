const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,x-admin-passkey,Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// ============ CONFIG ============
const SUPABASE_URL = process.env.SUPABASE_URL || "https://xglwvuwxrlvyczhlhijp.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ADMIN_PASSKEY = process.env.ADMIN_PASSKEY || "PrinceX IQFX_ADMIN_2026_PRINCEX";
const TWELVE_KEY = process.env.TWELVE_KEY || "62e0549bbdc04d76a224157e22da6bbd";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://princex-iq.vercel.app";
const ONESIGNAL_APP_ID = "9b174534-5638-46d0-9efb-071db011b02c";
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || "os_v2_app_tmlukncwhbdnbhx3a4o3aenqft7oc4a2664uo5nv3expvl2rh7arc4u3iwg5een2ybhtoxqvdslrb5zncgrhu4fzjrdt7lljm2ojtcq";

// ============ DARAJA CONFIG ============
const IS_SANDBOX = process.env.DARAJA_SANDBOX !== "false"; // default sandbox
const DARAJA_BASE = IS_SANDBOX
  ? "https://sandbox.safaricom.co.ke"
  : "https://api.safaricom.co.ke";

const DARAJA_CONSUMER_KEY    = process.env.DARAJA_CONSUMER_KEY    || "6D8ASAUllnUXgEcFKxtKRtL8TaHgZLtZq0k5Aih013uecVW0";
const DARAJA_CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET || "JYCGuVblUvlLXaF0U55Lg0A9yYAhNBbpGlG051Y2xaR4ejL4QveBteXGO79wVlnM";
const DARAJA_PASSKEY         = process.env.DARAJA_PASSKEY         || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const DARAJA_CALLBACK_URL    = "https://apex-server-09p7.onrender.com/mpesa/callback";

// Till: sandbox uses 174379, production uses your real till
const DARAJA_TILL = IS_SANDBOX
  ? (process.env.DARAJA_SANDBOX_TILL || "174379")
  : (process.env.DARAJA_TILL || "9352134");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const PLANS = {
  weekly:   { name:"Weekly",   price:299,   days:7    },
  monthly:  { name:"Monthly",  price:799,   days:30   },
  annual:   { name:"Annual",   price:6999,  days:365  },
  lifetime: { name:"Lifetime", price:14999, days:null },
};

let logs = [];
function log(msg) {
  const e = `${new Date().toISOString()} ${msg}`;
  console.log(e);
  logs.unshift(e);
  if (logs.length > 200) logs.pop();
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-passkey"] !== ADMIN_PASSKEY) return res.status(401).json({ error:"Unauthorized" });
  next();
}

// ============ DARAJA TOKEN ============
let darajaToken = null;
let darajaExpiry = null;

async function getDarajaToken() {
  if (darajaToken && darajaExpiry && Date.now() < darajaExpiry) return darajaToken;

  const creds = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString("base64");
  log(`Getting Daraja token from ${DARAJA_BASE}...`);

  const res = await axios.get(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  if (!res.data.access_token) throw new Error("No access_token in response: " + JSON.stringify(res.data));

  darajaToken  = res.data.access_token;
  darajaExpiry = Date.now() + ((parseInt(res.data.expires_in) || 3600) - 120) * 1000;
  log(`✅ Daraja token OK (${IS_SANDBOX?"SANDBOX":"PRODUCTION"})`);
  return darajaToken;
}

// ============ FORMAT PHONE ============
function formatPhone(phone) {
  let p = phone.replace(/\D/g, "");
  if (p.startsWith("0"))   p = "254" + p.slice(1);
  if (p.startsWith("+"))   p = p.slice(1);
  if (!p.startsWith("254")) p = "254" + p;
  if (p.length !== 12) throw new Error(`Invalid phone number: ${phone} → ${p}`);
  return p;
}

// ============ STK PUSH ============
async function stkPush(phone, amount, orderId, planName) {
  const token = await getDarajaToken();
  const ts    = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
  const pwd   = Buffer.from(`${DARAJA_TILL}${DARAJA_PASSKEY}${ts}`).toString("base64");
  const p     = formatPhone(phone);

  const payload = {
    BusinessShortCode: DARAJA_TILL,
    Password:          pwd,
    Timestamp:         ts,
    TransactionType:   "CustomerBuyGoodsOnline",
    Amount:            Math.ceil(amount),
    PartyA:            p,
    PartyB:            DARAJA_TILL,
    PhoneNumber:       p,
    CallBackURL:       DARAJA_CALLBACK_URL,
    AccountReference:  orderId.slice(0, 12),
    TransactionDesc:   `PrinceX IQ ${planName}`,
  };

  log(`STK payload: ${JSON.stringify({ ...payload, Password:"***" })}`);

  const res = await axios.post(
    `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  log(`STK response: ${JSON.stringify(res.data)}`);
  return res.data;
}

// ============ STK QUERY ============
async function stkQuery(checkoutRequestId) {
  const token = await getDarajaToken();
  const ts    = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
  const pwd   = Buffer.from(`${DARAJA_TILL}${DARAJA_PASSKEY}${ts}`).toString("base64");

  const res = await axios.post(
    `${DARAJA_BASE}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: DARAJA_TILL,
      Password:          pwd,
      Timestamp:         ts,
      CheckoutRequestID: checkoutRequestId,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
  log(`Query response: ${JSON.stringify(res.data)}`);
  return res.data;
}

// ============ ACTIVATE SUBSCRIPTION ============
async function activateSub(userId, plan) {
  const p = PLANS[plan];
  if (!p) return;
  const now    = new Date();
  const expiry = p.days ? new Date(now.getTime() + p.days * 86400000) : null;
  await supabase.from("subscriptions").upsert({
    user_id: userId, plan, status: "active",
    price_kes: p.price, purchase_date: now.toISOString(),
    expiry_date: expiry?.toISOString() || null,
  }, { onConflict: "user_id" });
  log(`✅ Sub activated: ${userId} ${plan}`);
}

// ============ MPESA ROUTES ============
app.post("/mpesa/stk", async (req, res) => {
  const { user_id, phone, plan } = req.body;
  log(`STK request → user:${user_id} phone:${phone} plan:${plan} mode:${IS_SANDBOX?"SANDBOX":"PROD"}`);

  if (!user_id || !phone || !plan || !PLANS[plan]) {
    return res.json({ error:"Missing fields: user_id, phone, plan required" });
  }

  try {
    const planData = PLANS[plan];
    const orderId  = `APX${Date.now()}`;

    // In sandbox use small amount for testing
    const amount = IS_SANDBOX ? 1 : planData.price;

    const stkData = await stkPush(phone, amount, orderId, planData.name);

    if (stkData.ResponseCode !== "0") {
      return res.json({ error: stkData.ResponseDescription || stkData.errorMessage || "STK Push failed" });
    }

    await supabase.from("payments").insert({
      user_id, plan,
      amount: planData.price,
      pesapal_order_id: orderId,
      pesapal_tracking_id: stkData.CheckoutRequestID,
      status: "pending",
    });

    res.json({
      success: true,
      message: IS_SANDBOX
        ? "SANDBOX: M-Pesa test prompt sent (use PIN 1234)"
        : "M-Pesa prompt sent! Enter your PIN.",
      checkout_request_id: stkData.CheckoutRequestID,
      merchant_request_id: stkData.MerchantRequestID,
      order_id: orderId,
      sandbox: IS_SANDBOX,
    });
  } catch(e) {
    const errMsg = e.response?.data
      ? JSON.stringify(e.response.data)
      : e.message;
    log(`❌ STK error: ${errMsg}`);
    res.json({ error:`M-Pesa error: ${e.response?.data?.errorMessage || e.response?.data?.ResultDesc || e.message}` });
  }
});

app.get("/mpesa/status/:checkoutRequestId", async (req, res) => {
  try {
    const data = await stkQuery(req.params.checkoutRequestId);
    const rc   = String(data.ResultCode ?? "");

    if (rc === "0") {
      const { data: payment } = await supabase.from("payments")
        .select("*").eq("pesapal_tracking_id", req.params.checkoutRequestId).single();
      if (payment && payment.status !== "completed") {
        await supabase.from("payments").update({ status:"completed" })
          .eq("pesapal_tracking_id", req.params.checkoutRequestId);
        await activateSub(payment.user_id, payment.plan);
      }
      return res.json({ state:"COMPLETE", message:"Payment successful!" });
    }
    if (rc === "1032") return res.json({ state:"CANCELLED", message:"Cancelled by user" });
    if (rc === "1037") return res.json({ state:"TIMEOUT",   message:"Request timed out" });
    if (rc !== "")     return res.json({ state:"FAILED",    message:data.ResultDesc || "Payment failed" });

    res.json({ state:"PENDING", message:"Waiting for payment..." });
  } catch(e) {
    // 500.001.1001 = transaction in progress (still pending)
    const code = e.response?.data?.errorCode || "";
    if (code === "500.001.1001" || code.includes("500")) {
      return res.json({ state:"PENDING", message:"Processing — enter PIN on phone" });
    }
    log(`Query error: ${e.message}`);
    res.json({ state:"PENDING", message:"Checking..." });
  }
});

app.post("/mpesa/callback", async (req, res) => {
  log(`📲 Callback: ${JSON.stringify(req.body)}`);
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return res.json({ ResultCode:0, ResultDesc:"OK" });

    const { ResultCode, CheckoutRequestID } = cb;
    if (ResultCode === 0) {
      const { data: payment } = await supabase.from("payments")
        .select("*").eq("pesapal_tracking_id", CheckoutRequestID).single();
      if (payment && payment.status !== "completed") {
        await supabase.from("payments").update({ status:"completed" })
          .eq("pesapal_tracking_id", CheckoutRequestID);
        await activateSub(payment.user_id, payment.plan);
        log(`✅ Callback activated: ${payment.user_id} ${payment.plan}`);
      }
    } else {
      await supabase.from("payments").update({ status:"failed" })
        .eq("pesapal_tracking_id", CheckoutRequestID);
      log(`❌ Callback failed: ${cb.ResultDesc}`);
    }
  } catch(e) { log(`Callback error: ${e.message}`); }
  res.json({ ResultCode:0, ResultDesc:"OK" });
});

// ============ SUBSCRIPTION CHECK ============
app.get("/subscription/:userId", async (req, res) => {
  try {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", req.params.userId).single();
    if (profile?.role === "admin") return res.json({ active:true, plan:"admin", role:"admin", expires:null });
    const { data: sub } = await supabase.from("subscriptions").select("*").eq("user_id", req.params.userId).single();
    if (!sub) return res.json({ active:false, plan:null, role:profile?.role||"user" });
    const expired = sub.expiry_date && new Date(sub.expiry_date) < new Date();
    if (expired && sub.status === "active") {
      await supabase.from("subscriptions").update({ status:"expired" }).eq("user_id", req.params.userId);
      return res.json({ active:false, plan:sub.plan, status:"expired", expires:sub.expiry_date });
    }
    res.json({ active:sub.status==="active", plan:sub.plan, status:sub.status, expires:sub.expiry_date, role:profile?.role||"user" });
  } catch(e) { res.json({ error:e.message }); }
});

// ============ ADMIN ROUTES ============
app.post("/admin/verify", (req, res) => res.json({ valid: req.body.passkey === ADMIN_PASSKEY }));

app.get("/admin/users", requireAdmin, async (req, res) => {
  const { data: profiles } = await supabase.from("profiles").select("*").order("created_at", { ascending:false });
  const { data: subs } = await supabase.from("subscriptions").select("*");
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

// ============ SIGNALS ENGINE ============
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
    if(ema9&&ema21)votes.push(ema9>ema21?1:-1);
    if(ema50)votes.push(latest>ema50?1:-1);
    if(rsi!==null)votes.push(rsi<30?1:rsi>70?-1:rsi<45?0.5:-0.5);
    if(macd)votes.push(macd.histogram>0?1:-1);
    if(sma20)votes.push(latest>sma20?1:-1);
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


// Global rate limiter - max 6 calls per minute
let lastApiCall = 0;
async function rateLimitedFetch(url) {
  const now = Date.now();
  const elapsed = now - lastApiCall;
  const minGap = 12000; // 12 seconds between calls = max 5/min
  if (elapsed < minGap) {
    await wait(minGap - elapsed);
  }
  lastApiCall = Date.now();
  return axios.get(url, { timeout: 15000 });
}

async function fetchCandles(symbol,interval){
  try{
    const res=await rateLimitedFetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=60&apikey=${TWELVE_KEY}`);
    if(res.data.status==="error"){log(`TD Error ${symbol}: ${res.data.message}`);return null;}
    return res.data.values||null;
  }catch(e){log(`Fetch error: ${e.message}`);return null;}
}

async function runAnalysis(){
  if(isAnalyzing)return;isAnalyzing=true;
  const tf=TIMEFRAMES[tfIndex%TIMEFRAMES.length];tfIndex++;
  for(const pair of PAIRS){
    try{
      await wait(20000);
      const candles=await fetchCandles(pair.symbol,tf);
      if(!candles||candles.length<30)continue;
      const a=sniperAnalysis(pair.symbol,tf,candles);
      if(!a)continue;
      const key=`${pair.symbol}_${tf}`,prev=signals[key]?.signal;
      signals[key]={...a,symbol:pair.symbol,timeframe:tf,type:pair.type,timestamp:new Date().toISOString(),price:candles[0]?.close};
      if(a.signal!=="WAIT"&&a.confidence>=80&&a.signal!==prev){
        try{await axios.post("https://onesignal.com/api/v1/notifications",{app_id:ONESIGNAL_APP_ID,included_segments:["All"],headings:{en:`⚡ PrinceX IQ — ${pair.symbol}`},contents:{en:`${a.signal==="BUY"?"▲":"▼"} ${a.signal} ${a.confidence}%`},url:"https://princex-iq.vercel.app",priority:10},{headers:{Authorization:`Bearer ${ONESIGNAL_API_KEY}`,"Content-Type":"application/json"},timeout:10000});}catch(e){}
      }
    }catch(e){log(`Error ${pair.symbol}: ${e.message}`);}
  }
  lastUpdated=new Date().toISOString();isAnalyzing=false;
}

app.get("/signals/analyze",async(req,res)=>{const{symbol,interval}=req.query;if(!symbol||!interval)return res.json({error:"required"});try{const c=await fetchCandles(symbol,interval);if(!c||c.length<30)return res.json({error:`No data`});const m=sniperAnalysis(symbol,interval,c);if(!m)return res.json({error:"failed"});res.json({symbol,timeframe:interval,price:c[0]?.close,timestamp:new Date().toISOString(),market:m});}catch(e){res.json({error:e.message});}});
app.get("/",(req,res)=>res.json({status:"PrinceX IQ ✅",mode:IS_SANDBOX?"SANDBOX":"PRODUCTION",till:DARAJA_TILL,lastUpdated,signals:Object.keys(signals).length}));
app.get("/signals",(req,res)=>res.json({signals,lastUpdated,isAnalyzing}));
app.get("/logs",(req,res)=>res.json({logs}));
app.get("/health",(req,res)=>res.json({ok:true,time:new Date().toISOString(),daraja:IS_SANDBOX?"sandbox":"production"}));
app.get("/trigger",(req,res)=>{runAnalysis();res.json({message:"triggered"});});
app.post("/trigger",(req,res)=>{runAnalysis();res.json({message:"triggered"});});

cron.schedule("*/5 * * * *",()=>{runAnalysis();});

setInterval(async()=>{
  try{await axios.get(`http://localhost:${process.env.PORT||3000}/health`,{timeout:5000});}catch(e){}
},14*60*1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log(`🚀 PrinceX IQ Server port ${PORT}`);
  log(`📱 Daraja mode: ${IS_SANDBOX?"SANDBOX (sandbox.safaricom.co.ke)":"PRODUCTION (api.safaricom.co.ke)"}`);
  log(`📱 Till: ${DARAJA_TILL}`);
  try { await getDarajaToken(); log("✅ Daraja ready"); }
  catch(e) { log(`⚠ Daraja token failed: ${e.message}`); }
  setTimeout(runAnalysis, 15000);
});



// ============ POCKET OPTION AUTO ============
const PO_PAIRS = [
  { symbol:"EUR/USD",  type:"forex",     flag:"🇪🇺🇺🇸" },
  { symbol:"CAD/JPY",  type:"forex",     flag:"🇨🇦🇯🇵" },
  { symbol:"GBP/AUD",  type:"forex",     flag:"🇬🇧🇦🇺" },
  { symbol:"EUR/GBP",  type:"forex",     flag:"🇪🇺🇬🇧" },
  { symbol:"EUR/CAD",  type:"forex",     flag:"🇪🇺🇨🇦" },
  { symbol:"GBP/CAD",  type:"forex",     flag:"🇬🇧🇨🇦" },
  { symbol:"GBP/JPY",  type:"forex",     flag:"🇬🇧🇯🇵" },
  { symbol:"AUD/USD",  type:"forex",     flag:"🇦🇺🇺🇸" },
  { symbol:"CHF/JPY",  type:"forex",     flag:"🇨🇭🇯🇵" },
  { symbol:"AUD/CHF",  type:"forex",     flag:"🇦🇺🇨🇭" },
  { symbol:"GBP/CHF",  type:"forex",     flag:"🇬🇧🇨🇭" },
  { symbol:"AUD/CAD",  type:"forex",     flag:"🇦🇺🇨🇦" },
  { symbol:"GBP/USD",  type:"forex",     flag:"🇬🇧🇺🇸" },
  { symbol:"USD/JPY",  type:"forex",     flag:"🇺🇸🇯🇵" },
  { symbol:"USD/CHF",  type:"forex",     flag:"🇺🇸🇨🇭" },
  { symbol:"USD/CAD",  type:"forex",     flag:"🇺🇸🇨🇦" },
  { symbol:"EUR/JPY",  type:"forex",     flag:"🇪🇺🇯🇵" },
  { symbol:"EUR/AUD",  type:"forex",     flag:"🇪🇺🇦🇺" },
  { symbol:"EUR/NZD",  type:"forex",     flag:"🇪🇺🇳🇿" },
  { symbol:"EUR/CHF",  type:"forex",     flag:"🇪🇺🇨🇭" },
  { symbol:"AUD/JPY",  type:"forex",     flag:"🇦🇺🇯🇵" },
  { symbol:"AUD/NZD",  type:"forex",     flag:"🇦🇺🇳🇿" },
  { symbol:"CAD/CHF",  type:"forex",     flag:"🇨🇦🇨🇭" },
  { symbol:"NZD/USD",  type:"forex",     flag:"🇳🇿🇺🇸" },
  { symbol:"NZD/JPY",  type:"forex",     flag:"🇳🇿🇯🇵" },
  { symbol:"NZD/CAD",  type:"forex",     flag:"🇳🇿🇨🇦" },
  { symbol:"NZD/CHF",  type:"forex",     flag:"🇳🇿🇨🇭" },
  { symbol:"XAU/USD",  type:"commodity", flag:"🥇"     },
  { symbol:"BTC/USD",  type:"crypto",    flag:"₿"      },
  { symbol:"ETH/USD",  type:"crypto",    flag:"Ξ"      },
];

let poSignals = {};
let poLastUpdated = null;
let poAnalyzing = false;

function getBuyersSellers(closes, rsi, macd, ema9, ema21) {
  const arr = [];
  if (rsi !== null && rsi !== undefined) {
    arr.push({ b: rsi, s: 100 - rsi });
  }
  if (ema9 && ema21) {
    const str = Math.min(Math.abs(ema9 - ema21) / (ema21 || 1) * 5000, 30);
    if (ema9 > ema21) arr.push({ b: 60 + str, s: 40 - str });
    else arr.push({ b: 40 - str, s: 60 + str });
  }
  if (macd && macd.histogram !== undefined) {
    const str = Math.min(Math.abs(macd.histogram) * 10000, 25);
    if (macd.histogram > 0) arr.push({ b: 55 + str, s: 45 - str });
    else arr.push({ b: 45 - str, s: 55 + str });
  }
  let bc = 0, sc2 = 0;
  for (let i = 0; i < Math.min(5, closes.length - 1); i++) {
    if (closes[i] > closes[i+1]) bc++; else sc2++;
  }
  const tot = bc + sc2;
  if (tot > 0) arr.push({ b: (bc/tot)*100, s: (sc2/tot)*100 });
  if (arr.length === 0) return { buyers: 50, sellers: 50 };
  const ab = arr.reduce((a,x) => a + x.b, 0) / arr.length;
  const as2 = arr.reduce((a,x) => a + x.s, 0) / arr.length;
  const sum = ab + as2;
  return { buyers: Math.round((ab/sum)*100), sellers: Math.round((as2/sum)*100) };
}

function calcBollinger(closes, period=20, mult=2) {
  if (closes.length < period) return null;
  const slice = closes.slice(0, period);
  const mean = slice.reduce((a,b)=>a+b,0)/period;
  const variance = slice.reduce((a,b)=>a+Math.pow(b-mean,2),0)/period;
  const std = Math.sqrt(variance);
  return { upper: mean+mult*std, middle: mean, lower: mean-mult*std, std, bandwidth: (2*mult*std)/mean };
}

function calcStochastic(closes, highs, lows, period=14) {
  if (closes.length < period) return null;
  const hh = Math.max(...highs.slice(0, period));
  const ll = Math.min(...lows.slice(0, period));
  const k = ((closes[0]-ll)/(hh-ll+0.00001))*100;
  const prevK = closes.length > period+2 ? ((closes[1]-Math.min(...lows.slice(1,period+1)))/(Math.max(...highs.slice(1,period+1))-Math.min(...lows.slice(1,period+1))+0.00001))*100 : k;
  return { k: Math.round(k), d: Math.round((k+prevK)/2) };
}

function calcWilliamsR(closes, highs, lows, period=14) {
  if (closes.length < period) return null;
  const hh = Math.max(...highs.slice(0, period));
  const ll = Math.min(...lows.slice(0, period));
  return ((hh-closes[0])/(hh-ll+0.00001))*-100;
}

function calcCCI(closes, highs, lows, period=14) {
  if (closes.length < period) return null;
  const tps = closes.slice(0,period).map((_,i)=>(highs[i]+lows[i]+closes[i])/3);
  const mean = tps.reduce((a,b)=>a+b,0)/period;
  const mad = tps.reduce((a,b)=>a+Math.abs(b-mean),0)/period;
  return (tps[0]-mean)/(0.015*(mad||0.00001));
}

function getNext3(signal, confidence, candles, indicators) {
  // Predict next 3 candles based on multiple real technical factors
  const closes = candles.map(c=>parseFloat(c.close));
  const highs = candles.map(c=>parseFloat(c.high));
  const lows = candles.map(c=>parseFloat(c.low));
  const latest = closes[0];
  const atr = calcATR(highs,lows,closes,14) || 0.0001;
  
  // Trend strength from ADX-like calculation
  const mom5 = ((closes[0]-closes[5])/closes[5])*100;
  const mom3 = ((closes[0]-closes[3])/closes[3])*100;
  const mom1 = ((closes[0]-closes[1])/closes[1])*100;
  
  // Bollinger band position
  const bb = calcBollinger(closes, 20, 2);
  const bbPos = bb ? (latest - bb.lower)/(bb.upper - bb.lower + 0.00001) : 0.5; // 0=lower, 1=upper
  
  // RSI from indicators
  const rsi = calcRSI(closes, 14) || 50;
  
  // Stochastic
  const stoch = calcStochastic(closes, highs, lows, 14);
  const stochK = stoch ? stoch.k : 50;
  
  // Momentum direction confidence per candle
  const isBull = signal === "BUY";
  const isBear = signal === "SELL";
  
  const result = [];
  for (let i = 1; i <= 3; i++) {
    // Base from overall signal confidence
    let baseConf = confidence;
    
    // Candle 1: strongest signal - momentum just started
    // Candle 2: continuation - depends on how extended we are
    // Candle 3: weakest - exhaustion risk
    
    let extensionPenalty = 0;
    let reasons = [];
    
    if (isBull) {
      // Overbought reduces confidence of continuation
      if (rsi > 75) { extensionPenalty += 12; reasons.push("RSI overbought"); }
      else if (rsi > 65) { extensionPenalty += 5; reasons.push("RSI elevated"); }
      if (stochK > 85) { extensionPenalty += 8; reasons.push("Stoch overbought"); }
      if (bb && latest > bb.upper * 0.998) { extensionPenalty += 10; reasons.push("Near BB upper"); }
      if (bbPos > 0.85) { extensionPenalty += 8; }
      // Strong momentum boosts confidence
      if (mom1 > 0 && mom3 > 0 && mom5 > 0) { extensionPenalty -= 5; reasons.push("All momentum aligned"); }
    } else if (isBear) {
      if (rsi < 25) { extensionPenalty += 12; reasons.push("RSI oversold"); }
      else if (rsi < 35) { extensionPenalty += 5; reasons.push("RSI low"); }
      if (stochK < 15) { extensionPenalty += 8; reasons.push("Stoch oversold"); }
      if (bb && latest < bb.lower * 1.002) { extensionPenalty += 10; reasons.push("Near BB lower"); }
      if (bbPos < 0.15) { extensionPenalty += 8; }
      if (mom1 < 0 && mom3 < 0 && mom5 < 0) { extensionPenalty -= 5; reasons.push("All momentum aligned"); }
    }
    
    // Each candle further out has more uncertainty
    const candlePenalty = (i-1) * 7;
    
    let candleConf = Math.max(45, Math.min(95, baseConf - extensionPenalty - candlePenalty));
    
    const dir = signal === "BUY" ? "UP" : signal === "SELL" ? "DOWN" : i%2===0?"DOWN":"UP";
    const str = candleConf >= 82 ? "STRONG" : candleConf >= 68 ? "MEDIUM" : "WEAK";
    
    let reason = "";
    if (i === 1) {
      reason = reasons.length > 0 
        ? (isBull?"Bullish momentum — watch ":"Bearish momentum — watch ") + reasons[0]
        : (isBull?"Strong bullish momentum continuation":"Strong bearish momentum continuation");
    } else if (i === 2) {
      reason = extensionPenalty > 10 
        ? "Momentum may slow — " + (isBull?"overbought risk":"oversold risk")
        : "Trend continuation expected";
    } else {
      reason = "Reversal risk increases — exit before this candle if profit secured";
    }
    
    result.push({ number:i, direction:dir, strength:str, confidence:Math.round(candleConf), reason });
  }
  return result;
}

function getPattern(candles) {
  try {
    const o0=parseFloat(candles[0].open), h0=parseFloat(candles[0].high);
    const l0=parseFloat(candles[0].low), c0=parseFloat(candles[0].close);
    const o1=parseFloat(candles[1].open), c1=parseFloat(candles[1].close);
    const body0=Math.abs(c0-o0), range0=h0-l0;
    const upper0=h0-Math.max(c0,o0), lower0=Math.min(c0,o0)-l0;
    if (range0 < 0.00001) return { name:"Doji", bias:0 };
    if (body0 < range0*0.05) return { name:"Doji", bias:0 };
    if (lower0>body0*2 && upper0<body0*0.3 && c0>o0) return { name:"Hammer", bias:1 };
    if (upper0>body0*2 && lower0<body0*0.3) return { name:"Shooting Star", bias:-1 };
    if (c0>o0 && c1<o1 && c0>o1 && o0<c1) return { name:"Bullish Engulfing", bias:1 };
    if (c0<o0 && c1>o1 && c0<o1 && o0>c1) return { name:"Bearish Engulfing", bias:-1 };
    if (lower0>range0*0.6 && body0<range0*0.3) return { name:"Bullish Pinbar", bias:1 };
    if (upper0>range0*0.6 && body0<range0*0.3) return { name:"Bearish Pinbar", bias:-1 };
    const c2=parseFloat(candles[2].close), o2=parseFloat(candles[2].open);
    if (c0>o0 && c1>o1 && c2>o2) return { name:"Three White Soldiers", bias:1 };
    if (c0<o0 && c1<o1 && c2<o2) return { name:"Three Black Crows", bias:-1 };
    return { name: c0>o0 ? "Bullish Candle" : "Bearish Candle", bias: c0>o0 ? 0.5 : -0.5 };
  } catch(e) { return { name:"Unknown", bias:0 }; }
}

async function analyzePO(pair) {
  try {
    log("Fetching candles for " + pair.symbol);
    const candles = await fetchCandles(pair.symbol, "1min");
    if (!candles || candles.length < 30) {
      log("No candles for " + pair.symbol + ": got " + (candles ? candles.length : 0));
      return null;
    }
    log("Got " + candles.length + " candles for " + pair.symbol);

    const closes  = candles.map(c => parseFloat(c.close));
    const highs   = candles.map(c => parseFloat(c.high));
    const lows    = candles.map(c => parseFloat(c.low));
    const volumes = candles.map(c => parseFloat(c.volume) || 1);
    const latest  = closes[0];

    const ema9  = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const sma20 = calcSMA(closes, 20);
    const rsi   = calcRSI(closes, 14);
    const macd  = calcMACD(closes);
    const atr   = calcATR(highs, lows, closes, 14);

    if (!atr || atr === 0) { log("ATR is 0 for " + pair.symbol); return null; }

    // VWAP
    let cumTPV = 0, cumVol = 0;
    for (let i = 0; i < closes.length; i++) {
      const tp = (highs[i]+lows[i]+closes[i])/3;
      cumTPV += tp * (volumes[i]||1);
      cumVol += (volumes[i]||1);
    }
    const vwap = cumVol > 0 ? cumTPV / cumVol : null;

    // Supertrend
    const stLower = ((highs[0]+lows[0])/2) - 3*atr;
    const supertrend = closes[1] > stLower ? 1 : -1;

    // Pattern
    const pat = getPattern(candles);

    // Votes
    const votes = [];
    const inds = {};

    if (ema9 && ema21) {
      const v = ema9 > ema21 ? 1 : -1;
      votes.push(v);
      inds.emaCross = { vote:v, label:v>0?"BULL":"BEAR", value:"EMA9 "+(v>0?"above":"below")+" EMA21" };
    }
    if (ema50) {
      const v = latest > ema50 ? 1 : -1;
      votes.push(v);
      inds.ema50 = { vote:v, label:v>0?"BULL":"BEAR", value:"Price "+(v>0?"above":"below")+" EMA50" };
    }
    if (rsi !== null && rsi !== undefined) {
      const v = rsi < 30 ? 1 : rsi > 70 ? -1 : rsi < 45 ? 0.5 : -0.5;
      votes.push(v);
      inds.rsi = { vote:v, label:rsi<30?"OVERSOLD":rsi>70?"OVERBOUGHT":"NEUTRAL", value:"RSI: "+rsi.toFixed(1) };
    }
    if (macd && macd.histogram !== undefined) {
      const v = macd.histogram > 0 ? 1 : -1;
      votes.push(v);
      inds.macd = { vote:v, label:v>0?"BULL":"BEAR", value:"MACD histogram "+(v>0?"positive":"negative") };
    }
    if (vwap) {
      const v = latest > vwap ? 1 : -1;
      votes.push(v);
      inds.vwap = { vote:v, label:v>0?"ABOVE":"BELOW", value:"VWAP: "+vwap.toFixed(5) };
    }
    if (sma20) {
      const v = latest > sma20 ? 1 : -1;
      votes.push(v);
      inds.sma20 = { vote:v, label:v>0?"BULL":"BEAR", value:"SMA20: "+sma20.toFixed(5) };
    }

    votes.push(supertrend);
    inds.supertrend = { vote:supertrend, label:supertrend>0?"BULL":"BEAR", value:"Supertrend "+(supertrend>0?"support":"resistance") };

    if (pat.bias !== 0) {
      const v = pat.bias > 0 ? 1 : -1;
      votes.push(v);
      inds.pattern = { vote:v, label:v>0?"BULLISH":"BEARISH", value:pat.name };
    }

    const mom = closes.length > 4 ? ((closes[0]-closes[4])/closes[4])*100 : 0;
    const mv = mom > 0.05 ? 1 : mom < -0.05 ? -1 : 0;
    votes.push(mv);
    inds.momentum = { vote:mv, label:mv>0?"POS":mv<0?"NEG":"FLAT", value:"Momentum: "+mom.toFixed(3)+"%" };

    const bullV = votes.filter(v => v > 0).length;
    const bearV = votes.filter(v => v < 0).length;
    const totalV = votes.length;
    const bullScore = Math.round((bullV/totalV)*100);
    const bearScore = Math.round((bearV/totalV)*100);

    let signal = "WAIT";
    let confidence = 50;
    if (bullScore >= 75) { signal = "BUY";  confidence = bullScore; }
    else if (bearScore >= 75) { signal = "SELL"; confidence = bearScore; }

    const { buyers, sellers } = getBuyersSellers(closes, rsi, macd, ema9, ema21);
    const next3 = getNext3(signal, confidence, atr);

    const swingH = Math.max(...highs.slice(0,5));
    const swingL = Math.min(...lows.slice(0,5));
    let sl, tp1, tp2, tp3;

    if (signal === "BUY") {
      sl  = Math.min(swingL, latest - atr*1.5);
      const r = latest - sl;
      tp1 = latest + r*1.5; tp2 = latest + r*3; tp3 = latest + r*5;
    } else if (signal === "SELL") {
      sl  = Math.max(swingH, latest + atr*1.5);
      const r = sl - latest;
      tp1 = latest - r*1.5; tp2 = latest - r*3; tp3 = latest - r*5;
    } else {
      sl  = latest - atr*1.5;
      tp1 = latest + atr*1.5; tp2 = latest + atr*3; tp3 = latest + atr*5;
    }

    const sigLabel = signal === "BUY" ? "bullish" : signal === "SELL" ? "bearish" : "neutral";

    return {
      symbol:      pair.symbol,
      flag:        pair.flag,
      type:        pair.type,
      timeframe:   "1min",
      signal,
      confidence,
      bullScore,
      bearScore,
      bullVotes:   bullV,
      bearVotes:   bearV,
      totalVotes:  totalV,
      buyers,
      sellers,
      pattern:     pat.name,
      price:       latest.toFixed(5),
      entry:       latest.toFixed(5),
      sl:          sl.toFixed(5),
      tp1:         tp1.toFixed(5),
      tp2:         tp2.toFixed(5),
      tp3:         tp3.toFixed(5),
      expiry:      "3 minutes",
      candles_to_hold: 3,
      next3candles: next3,
      indicators:  inds,
      trend:       bullScore > bearScore ? "Bullish" : "Bearish",
      reason:      bullV + "/" + totalV + " indicators " + sigLabel + ". " + pat.name,
      timestamp:   new Date().toISOString(),
    };
  } catch(e) {
    log("analyzePO error " + pair.symbol + ": " + e.message);
    return null;
  }
}

async function runPOAnalysis() {
  if (poAnalyzing) return;
  poAnalyzing = true;
  log("🟢 PO Analysis started");
  for (const pair of PO_PAIRS) {
    try {
      await wait(20000);
      const result = await analyzePO(pair);
      if (result) {
        poSignals[pair.symbol] = result;
        log("✅ PO " + pair.symbol + ": " + result.signal + " " + result.confidence + "%");
      }
    } catch(e) { log("PO loop error " + pair.symbol + ": " + e.message); }
  }
  poLastUpdated = new Date().toISOString();
  poAnalyzing = false;
  log("✅ PO done. " + Object.keys(poSignals).length + " signals");
}

// PO Routes
app.get("/po/signals", (req, res) => {
  res.json({ signals: poSignals, lastUpdated: poLastUpdated, isAnalyzing: poAnalyzing });
});

app.get("/po/trigger", (req, res) => {
  runPOAnalysis();
  res.json({ message: "PO triggered" });
});

app.get("/po/get/:symbol", async (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol);
  log("⚡ PO GET: " + symbol);
  const pair = PO_PAIRS.find(p => p.symbol === symbol) || { symbol, flag:"📊", type:"forex" };
  try {
    const result = await analyzePO(pair);
    if (!result) {
      return res.json({ error: "No data for " + symbol + ". Market may be closed or pair unavailable on free tier." });
    }
    res.json(result);
  } catch(e) {
    log("PO GET error: " + e.message);
    res.json({ error: e.message });
  }
});

// Run PO every 1 min
cron.schedule("*/30 * * * *", () => { runPOAnalysis(); });
setTimeout(runPOAnalysis, 30000);
