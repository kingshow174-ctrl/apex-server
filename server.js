const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ============ CONFIG ============
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

// ============ PLANS ============
const PLANS = {
  weekly:   { name: "Weekly",   price: 299,   days: 7 },
  monthly:  { name: "Monthly",  price: 799,   days: 30 },
  annual:   { name: "Annual",   price: 6999,  days: 365 },
  lifetime: { name: "Lifetime", price: 14999, days: null },
};

// ============ LOGGING ============
let logs = [];
function log(msg) {
  const entry = `${new Date().toISOString()} ${msg}`;
  console.log(entry);
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ============ ADMIN MIDDLEWARE ============
function requireAdmin(req, res, next) {
  const passkey = req.headers["x-admin-passkey"];
  if (passkey !== ADMIN_PASSKEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ============ PESAPAL AUTH ============
let pesapalToken = null;
let pesapalTokenExpiry = null;

async function getPesapalToken() {
  if (pesapalToken && pesapalTokenExpiry && Date.now() < pesapalTokenExpiry) return pesapalToken;
  try {
    const res = await axios.post(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
      consumer_key: PESAPAL_KEY,
      consumer_secret: PESAPAL_SECRET,
    }, { headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 15000 });
    pesapalToken = res.data.token;
    pesapalTokenExpiry = Date.now() + (4 * 60 * 60 * 1000); // 4 hours
    log("✅ PesaPal token obtained");
    return pesapalToken;
  } catch(e) {
    log(`❌ PesaPal token error: ${e.message}`);
    return null;
  }
}

// ============ REGISTER IPN ============
async function registerIPN() {
  try {
    const token = await getPesapalToken();
    if (!token) return null;
    const res = await axios.post(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
      url: `${FRONTEND_URL.replace("vercel.app","onrender.com")}/pesapal/ipn`,
      ipn_notification_type: "GET",
    }, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 10000 });
    log(`✅ IPN registered: ${res.data.ipn_id}`);
    return res.data.ipn_id;
  } catch(e) {
    log(`IPN error: ${e.message}`);
    return null;
  }
}

let ipnId = null;

// ============ PESAPAL PAYMENT INITIATION ============
app.post("/pesapal/initiate", async (req, res) => {
  const { user_id, email, name, plan } = req.body;
  if (!user_id || !email || !plan || !PLANS[plan]) return res.json({ error: "Invalid request" });

  try {
    const token = await getPesapalToken();
    if (!token) return res.json({ error: "Payment service unavailable" });
    if (!ipnId) ipnId = await registerIPN();

    const planData = PLANS[plan];
    const orderId = `APEXFX-${Date.now()}-${user_id.slice(0,8)}`;

    // Save pending payment
    await supabase.from("payments").insert({
      user_id, plan, amount: planData.price,
      pesapal_order_id: orderId, status: "pending"
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
        first_name: name?.split(" ")[0] || "User",
        last_name: name?.split(" ")[1] || "",
      }
    }, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15000 });

    log(`💳 Payment initiated: ${orderId} ${plan} KES${planData.price}`);
    res.json({ redirect_url: orderRes.data.redirect_url, order_tracking_id: orderRes.data.order_tracking_id, order_id: orderId });
  } catch(e) {
    log(`Payment error: ${e.message}`);
    res.json({ error: "Payment initiation failed: " + e.message });
  }
});

// ============ PESAPAL IPN CALLBACK ============
app.get("/pesapal/ipn", async (req, res) => {
  const { orderTrackingId, orderMerchantReference, orderNotificationType } = req.query;
  log(`IPN received: ${orderTrackingId} ${orderMerchantReference}`);
  try {
    const token = await getPesapalToken();
    if (!token) return res.send("OK");

    const statusRes = await axios.get(`${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000
    });

    const status = statusRes.data;
    const orderId = orderMerchantReference;

    if (status.payment_status_description === "Completed") {
      const { data: payment } = await supabase.from("payments").select("*").eq("pesapal_order_id", orderId).single();
      if (payment && payment.status !== "completed") {
        await supabase.from("payments").update({ status: "completed", pesapal_tracking_id: orderTrackingId }).eq("pesapal_order_id", orderId);
        await activateSubscription(payment.user_id, payment.plan);
        log(`✅ Payment completed: ${orderId} plan:${payment.plan}`);
      }
    }
    res.send("OK");
  } catch(e) {
    log(`IPN error: ${e.message}`);
    res.send("OK");
  }
});

// ============ VERIFY PAYMENT ============
app.post("/pesapal/verify", async (req, res) => {
  const { order_tracking_id, order_id, user_id } = req.body;
  try {
    const token = await getPesapalToken();
    if (!token) return res.json({ error: "Service unavailable" });

    const statusRes = await axios.get(`${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${order_tracking_id}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000
    });

    const status = statusRes.data;
    if (status.payment_status_description === "Completed") {
      const { data: payment } = await supabase.from("payments").select("*").eq("pesapal_order_id", order_id).single();
      if (payment && payment.status !== "completed") {
        await supabase.from("payments").update({ status: "completed", pesapal_tracking_id: order_tracking_id }).eq("pesapal_order_id", order_id);
        await activateSubscription(payment.user_id, payment.plan);
      }
      res.json({ success: true, status: "completed" });
    } else {
      res.json({ success: false, status: status.payment_status_description });
    }
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ============ ACTIVATE SUBSCRIPTION ============
async function activateSubscription(userId, plan) {
  const planData = PLANS[plan];
  const now = new Date();
  const expiry = planData.days ? new Date(now.getTime() + planData.days * 86400000) : null;

  await supabase.from("subscriptions").upsert({
    user_id: userId, plan,
    status: "active",
    price_kes: planData.price,
    purchase_date: now.toISOString(),
    expiry_date: expiry ? expiry.toISOString() : null,
  }, { onConflict: "user_id" });

  log(`✅ Subscription activated: ${userId} plan:${plan} expires:${expiry?.toISOString() || "never"}`);
}

// ============ CHECK SUBSCRIPTION ============
app.get("/subscription/:userId", async (req, res) => {
  try {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", req.params.userId).single();
    if (profile?.role === "admin") return res.json({ active: true, plan: "admin", role: "admin", expires: null });

    const { data: sub } = await supabase.from("subscriptions").select("*").eq("user_id", req.params.userId).single();
    if (!sub) return res.json({ active: false, plan: null });

    const now = new Date();
    const expired = sub.expiry_date && new Date(sub.expiry_date) < now;
    if (expired && sub.status === "active") {
      await supabase.from("subscriptions").update({ status: "expired" }).eq("user_id", req.params.userId);
      return res.json({ active: false, plan: sub.plan, status: "expired", expires: sub.expiry_date });
    }

    res.json({ active: sub.status === "active", plan: sub.plan, status: sub.status, expires: sub.expiry_date, role: profile?.role || "user" });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ============ ADMIN ROUTES ============
app.post("/admin/verify", (req, res) => {
  const { passkey } = req.body;
  if (passkey === ADMIN_PASSKEY) res.json({ valid: true });
  else res.status(401).json({ valid: false });
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const { data: profiles } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
    const { data: subs } = await supabase.from("subscriptions").select("*");
    const users = (profiles || []).map(p => ({
      ...p,
      subscription: subs?.find(s => s.user_id === p.id) || null
    }));
    res.json({ users });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/admin/payments", requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase.from("payments").select("*, profiles(email, full_name)").order("created_at", { ascending: false });
    res.json({ payments: data || [] });
  } catch(e) { res.json({ error: e.message }); }
});

app.post("/admin/grant", requireAdmin, async (req, res) => {
  const { user_id, plan } = req.body;
  if (!user_id || !plan || !PLANS[plan]) return res.json({ error: "Invalid" });
  try {
    await activateSubscription(user_id, plan);
    await supabase.from("payments").insert({ user_id, plan, amount: 0, status: "admin_granted" });
    res.json({ success: true });
  } catch(e) { res.json({ error: e.message }); }
});

app.post("/admin/revoke", requireAdmin, async (req, res) => {
  const { user_id } = req.body;
  try {
    await supabase.from("subscriptions").update({ status: "revoked" }).eq("user_id", user_id);
    res.json({ success: true });
  } catch(e) { res.json({ error: e.message }); }
});

app.post("/admin/promote", requireAdmin, async (req, res) => {
  const { user_id } = req.body;
  try {
    await supabase.from("profiles").update({ role: "admin" }).eq("id", user_id);
    res.json({ success: true });
  } catch(e) { res.json({ error: e.message }); }
});

app.post("/admin/demote", requireAdmin, async (req, res) => {
  const { user_id } = req.body;
  try {
    await supabase.from("profiles").update({ role: "user" }).eq("id", user_id);
    res.json({ success: true });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const { count: users } = await supabase.from("profiles").select("*", { count: "exact", head: true });
    const { count: active } = await supabase.from("subscriptions").select("*", { count: "exact", head: true }).eq("status", "active");
    const { data: payments } = await supabase.from("payments").select("amount").eq("status", "completed");
    const revenue = (payments || []).reduce((a, p) => a + (p.amount || 0), 0);
    res.json({ users, active_subs: active, total_revenue: revenue });
  } catch(e) { res.json({ error: e.message }); }
});

// ============ SIGNALS ENGINE ============
const PAIRS = [
  { symbol: "EUR/USD", type: "forex" },
  { symbol: "GBP/USD", type: "forex" },
  { symbol: "XAU/USD", type: "forex" },
  { symbol: "BTC/USD", type: "crypto" },
  { symbol: "ETH/USD", type: "crypto" },
];
const TIMEFRAMES = ["5min", "15min", "1h"];
let tfIndex = 0;
let signals = {};
let lastUpdated = null;
let isAnalyzing = false;

function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period - 1; i >= 0; i--) ema = data[i] * k + ema * (1 - k);
  return ema;
}
function calcSMA(data, period) {
  if (data.length < period) return null;
  return data.slice(0, period).reduce((a, b) => a + b, 0) / period;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const d = closes[i] - closes[i + 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return 100 - (100 / (1 + rs));
}
function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 0; i < period; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i+1]), Math.abs(lows[i] - closes[i+1])));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}
function calcMACD(closes) {
  if (closes.length < 26) return null;
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return { histogram: ema12 - ema26 };
}
function calcADX(highs, lows, closes, period = 14) {
  if (closes.length < period * 2) return null;
  const trs = [], dmP = [], dmM = [];
  for (let i = 0; i < period; i++) {
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i+1]), Math.abs(lows[i]-closes[i+1])));
    const dp = highs[i]-highs[i+1], dm = lows[i+1]-lows[i];
    dmP.push(dp > dm && dp > 0 ? dp : 0);
    dmM.push(dm > dp && dm > 0 ? dm : 0);
  }
  const atr = trs.reduce((a,b)=>a+b,0)/period;
  const diP = (dmP.reduce((a,b)=>a+b,0)/period)/atr*100;
  const diM = (dmM.reduce((a,b)=>a+b,0)/period)/atr*100;
  return { adx: Math.abs(diP-diM)/(diP+diM+0.001)*100, diPlus: diP, diMinus: diM };
}
function detectPattern(candles) {
  if (candles.length < 3) return { name: "None", bias: 0 };
  const [c0, c1] = candles;
  const o0 = parseFloat(c0.open), h0 = parseFloat(c0.high), l0 = parseFloat(c0.low), cl0 = parseFloat(c0.close);
  const o1 = parseFloat(c1.open), cl1 = parseFloat(c1.close);
  const body0 = Math.abs(cl0-o0), range0 = h0-l0;
  const upper = h0-Math.max(cl0,o0), lower = Math.min(cl0,o0)-l0;
  if (body0 < range0*0.05) return { name:"Doji", bias:0 };
  if (lower > body0*2 && upper < body0*0.3 && cl0>o0) return { name:"Hammer", bias:1 };
  if (upper > body0*2 && lower < body0*0.3) return { name:"Shooting Star", bias:-1 };
  if (cl0>o0 && cl1<o1 && cl0>o1 && o0<cl1) return { name:"Bullish Engulfing", bias:1 };
  if (cl0<o0 && cl1>o1 && cl0<o1 && o0>cl1) return { name:"Bearish Engulfing", bias:-1 };
  if (lower > range0*0.6 && body0 < range0*0.3) return { name:"Bullish Pinbar", bias:1 };
  if (upper > range0*0.6 && body0 < range0*0.3) return { name:"Bearish Pinbar", bias:-1 };
  return { name: cl0>o0?"Bullish Candle":"Bearish Candle", bias: cl0>o0?0.5:-0.5 };
}

function sniperAnalysis(symbol, interval, candles) {
  try {
    const closes = candles.map(c => parseFloat(c.close));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    const volumes = candles.map(c => c.volume);
    const latest = closes[0];
    const ema9 = calcEMA(closes,9), ema21 = calcEMA(closes,21), ema50 = calcEMA(closes,50);
    const sma20 = calcSMA(closes,20), rsi = calcRSI(closes,14), macd = calcMACD(closes);
    const atr = calcATR(highs,lows,closes,14), adx = calcADX(highs,lows,closes,14);
    const pattern = detectPattern(candles);
    let cumTPV = 0, cumVol = 0;
    for (let i = 0; i < closes.length; i++) {
      const tp = (highs[i]+lows[i]+closes[i])/3, vol = parseFloat(volumes[i])||0;
      cumTPV += tp*vol; cumVol += vol;
    }
    const vwap = cumVol > 0 ? cumTPV/cumVol : null;
    const st = atr ? { direction: closes[0] > (lows[0]+highs[0])/2 - 3*atr ? 1 : -1 } : null;
    const votes = [];
    const details = {};
    if (ema9&&ema21) { const v=ema9>ema21?1:-1; votes.push(v); details.emaCross={vote:v,value:`EMA9 ${v>0?">":"<"} EMA21`,label:v>0?"BULL":"BEAR"}; }
    if (ema50) { const v=latest>ema50?1:-1; votes.push(v); details.ema50={vote:v,value:`${v>0?"Above":"Below"} EMA50`,label:v>0?"BULL":"BEAR"}; }
    if (rsi!==null) { const v=rsi<30?1:rsi>70?-1:rsi<45?0.5:-0.5; votes.push(v); details.rsi={vote:v,value:rsi.toFixed(1),label:rsi<30?"OVERSOLD":rsi>70?"OVERBOUGHT":"NEUTRAL"}; }
    if (macd) { const v=macd.histogram>0?1:-1; votes.push(v); details.macd={vote:v,value:`Hist:${macd.histogram.toFixed(5)}`,label:v>0?"BULL":"BEAR"}; }
    if (adx) { const v=adx.diPlus>adx.diMinus?1:-1; votes.push(adx.adx>20?v:0); details.adx={vote:adx.adx>20?v:0,value:`ADX:${adx.adx.toFixed(1)}`,label:adx.adx>25?"STRONG":adx.adx>20?"MODERATE":"WEAK"}; }
    if (vwap) { const v=latest>vwap?1:-1; votes.push(v); details.vwap={vote:v,value:vwap.toFixed(5),label:v>0?"ABOVE":"BELOW"}; }
    if (st) { votes.push(st.direction); details.supertrend={vote:st.direction,value:st.direction>0?"Bull":"Bear",label:st.direction>0?"BULL":"BEAR"}; }
    if (pattern.bias!==0) { const v=pattern.bias>0?1:-1; votes.push(v); details.pattern={vote:v,value:pattern.name,label:v>0?"BULLISH":"BEARISH"}; }
    const mom = ((closes[0]-closes[4])/closes[4])*100;
    const mv = mom>0.1?1:mom<-0.1?-1:0; votes.push(mv); details.momentum={vote:mv,value:`${mom.toFixed(3)}%`,label:mv>0?"POS":mv<0?"NEG":"FLAT"};
    if (sma20) { const v=latest>sma20?1:-1; votes.push(v); details.sma20={vote:v,value:sma20.toFixed(5),label:v>0?"BULL":"BEAR"}; }
    const bullV = votes.filter(v=>v>0).length, bearV = votes.filter(v=>v<0).length, total = votes.length;
    const bullScore = Math.round(bullV/total*100), bearScore = Math.round(bearV/total*100);
    let signal = "WAIT", confidence = 50;
    if (bullScore>=80) { signal="BUY"; confidence=bullScore; }
    else if (bearScore>=80) { signal="SELL"; confidence=bearScore; }
    if (!atr) return null;
    const swingHigh = Math.max(...highs.slice(0,5)), swingLow = Math.min(...lows.slice(0,5));
    let sl, tp1, tp2, tp3;
    if (signal==="BUY") { sl=Math.min(swingLow,latest-atr*1.5); const r=latest-sl; tp1=latest+r*1.5; tp2=latest+r*3; tp3=latest+r*5; }
    else if (signal==="SELL") { sl=Math.max(swingHigh,latest+atr*1.5); const r=sl-latest; tp1=latest-r*1.5; tp2=latest-r*3; tp3=latest-r*5; }
    else { sl=latest-atr*1.5; tp1=latest+atr*1.5; tp2=latest+atr*3; tp3=latest+atr*5; }
    const durMap={"1min":"5-15 min","2min":"10-20 min","5min":"15-45 min","15min":"1-3 hours","30min":"2-6 hours","1h":"4-12 hours","4h":"1-3 days","1day":"1-2 weeks"};
    return { signal, confidence, bullScore, bearScore, totalVotes:total, bullVotes:bullV, bearVotes:bearV, pattern:pattern.name,
      trend:bullScore>bearScore?"Bullish":"Bearish", entryPrice:latest.toFixed(5),
      sl:sl.toFixed(5), tp1:tp1.toFixed(5), tp2:tp2.toFixed(5), tp3:tp3.toFixed(5),
      riskReward:Math.abs((tp2-latest)/(latest-sl+0.00001)).toFixed(1),
      duration:durMap[interval]||"Variable", indicators:details,
      reason:`Bull:${bullScore}% Bear:${bearScore}% | ${pattern.name} | RSI:${rsi?rsi.toFixed(0):"N/A"}` };
  } catch(e) { log(`Sniper error ${symbol}: ${e.message}`); return null; }
}

async function fetchCandles(symbol, interval) {
  try {
    const res = await axios.get(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=60&apikey=${TWELVE_KEY}`, { timeout:15000 });
    if (res.data.status==="error") { log(`TD Error ${symbol}: ${res.data.message}`); return null; }
    return res.data.values||null;
  } catch(e) { log(`Fetch error ${symbol}: ${e.message}`); return null; }
}

async function sendNotification(symbol, signal, confidence, entry) {
  try {
    const emoji = signal==="BUY"?"▲":"▼";
    await axios.post("https://onesignal.com/api/v1/notifications",
      { app_id:ONESIGNAL_APP_ID, included_segments:["All"], headings:{en:`⚡ APEX FX — ${symbol}`}, contents:{en:`${emoji} ${signal} ${confidence}% | Entry:${entry} | Tap to view`}, url:"https://apex-trading-eta.vercel.app", priority:10 },
      { headers:{ Authorization:`Bearer ${ONESIGNAL_API_KEY}`, "Content-Type":"application/json" }, timeout:10000 }
    );
  } catch(e) { log(`Notify error: ${e.message}`); }
}

async function runAnalysis() {
  if (isAnalyzing) return;
  isAnalyzing = true;
  const tf = TIMEFRAMES[tfIndex%TIMEFRAMES.length]; tfIndex++;
  log(`🎯 Analysis TF:${tf}`);
  for (const pair of PAIRS) {
    try {
      await wait(10000);
      const candles = await fetchCandles(pair.symbol, tf);
      if (!candles||candles.length<30) continue;
      const analysis = sniperAnalysis(pair.symbol, tf, candles);
      if (!analysis) continue;
      const key = `${pair.symbol}_${tf}`;
      const prev = signals[key]?.signal;
      signals[key] = { ...analysis, symbol:pair.symbol, timeframe:tf, type:pair.type, timestamp:new Date().toISOString(), price:candles[0]?.close };
      log(`✅ ${pair.symbol} ${tf}: ${analysis.signal} ${analysis.confidence}%`);
      if (analysis.signal!=="WAIT"&&analysis.confidence>=80&&analysis.signal!==prev) {
        await sendNotification(pair.symbol, analysis.signal, analysis.confidence, analysis.entryPrice);
      }
    } catch(e) { log(`Error ${pair.symbol}: ${e.message}`); }
  }
  lastUpdated = new Date().toISOString();
  isAnalyzing = false;
  log(`✅ Done. Signals: ${Object.keys(signals).length}`);
}

app.get("/signals/analyze", async (req, res) => {
  const { symbol, interval } = req.query;
  if (!symbol||!interval) return res.json({ error:"symbol and interval required" });
  try {
    const candles = await fetchCandles(symbol, interval);
    if (!candles||candles.length<30) return res.json({ error:`No data for ${symbol}` });
    const market = sniperAnalysis(symbol, interval, candles);
    if (!market) return res.json({ error:"Analysis failed" });
    const atr = parseFloat(market.atr||0)||0.001;
    const entry = parseFloat(market.entryPrice);
    const pending = { ...market, entryPrice:(entry-atr*0.5).toFixed(5), pendingType:market.signal==="BUY"?"BUY LIMIT":"SELL LIMIT" };
    const nextCandle = { ...market, entryPrice:(entry+atr*0.1).toFixed(5), entryLabel:"Next Candle" };
    res.json({ symbol, timeframe:interval, price:candles[0]?.close, timestamp:new Date().toISOString(), market, nextCandle, pending });
  } catch(e) { res.json({ error:e.message }); }
});

app.get("/", (req, res) => res.json({ status:"APEX FX Server ✅", lastUpdated, signals:Object.keys(signals).length, isAnalyzing }));
app.get("/signals", (req, res) => res.json({ signals, lastUpdated, isAnalyzing }));
app.get("/logs", (req, res) => res.json({ logs }));
app.get("/health", (req, res) => res.json({ ok:true }));
app.get("/trigger", (req, res) => { runAnalysis(); res.json({ message:"triggered" }); });
app.post("/trigger", (req, res) => { runAnalysis(); res.json({ message:"triggered" }); });

cron.schedule("*/5 * * * *", () => { log("⏰ Scheduled"); runAnalysis(); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  log(`🚀 APEX FX Server port ${PORT}`);
  ipnId = await registerIPN();
  setTimeout(runAnalysis, 5000);
});
