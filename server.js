const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const TWELVE_KEY = "62e0549bbdc04d76a224157e22da6bbd";
const GEMINI_KEY = "AIzaSyDLXA3uOQuQmJQanhcSQmCnPqaAJL2l4xU";
const ONESIGNAL_APP_ID = "9b174534-5638-46d0-9efb-071db011b02c";
const ONESIGNAL_API_KEY = "os_v2_app_tmlukncwhbdnbhx3a4o3aenqft7oc4a2664uo5nv3expvl2rh7arc4u3iwg5een2ybhtoxqvdslrb5zncgrhu4fzjrdt7lljm2ojtcq";

const PAIRS = [
  { symbol: "EUR/USD", type: "forex" },
  { symbol: "GBP/USD", type: "forex" },
  { symbol: "XAU/USD", type: "forex" },
  { symbol: "BTC/USD", type: "crypto" },
  { symbol: "ETH/USD", type: "crypto" },
];
const TIMEFRAMES = ["1min", "5min", "15min"];
let signals = {};
let lastUpdated = null;
let isAnalyzing = false;

async function fetchCandles(symbol, interval) {
  try {
    const res = await axios.get(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=10&apikey=${TWELVE_KEY}`,
      { timeout: 10000 }
    );
    if (res.data.status === "error") { console.log(`TD error ${symbol}: ${res.data.message}`); return null; }
    return res.data.values || null;
  } catch(e) { console.log(`Fetch error ${symbol}: ${e.message}`); return null; }
}

async function analyzeWithGemini(symbol, interval, candles) {
  try {
    const ct = candles.slice(0,6).map((c,i) => `C${i+1}: O=${c.open} H=${c.high} L=${c.low} Close=${c.close}`).join(" | ");
    const prompt = `Analyze ${symbol} on ${interval}. Candles (newest first): ${ct}. Give trading signal. Return ONLY JSON: {"signal":"BUY or SELL or WAIT","confidence":85,"pattern":"pattern","trend":"trend","entry":"${candles[0]?.close}","sl":"stop loss","tp1":"tp1","tp2":"tp2","tp3":"tp3","duration":"duration","reason":"reason"}`;
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.1,maxOutputTokens:300,responseMimeType:"application/json",thinkingConfig:{thinkingBudget:0}} },
      { timeout: 30000 }
    );
    const raw = res.data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("") || "";
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch(e) { console.log(`Gemini error ${symbol}: ${e.message}`); return null; }
}

async function sendNotification(symbol, signal, confidence) {
  try {
    const emoji = signal === "BUY" ? "▲" : "▼";
    await axios.post(
      "https://onesignal.com/api/v1/notifications",
      { app_id: ONESIGNAL_APP_ID, included_segments:["All"], headings:{en:`⚡ APEX — ${symbol}`}, contents:{en:`${emoji} ${signal} ${confidence}% confidence. Tap to view.`}, url:"https://apex-trading-eta.vercel.app", priority:10 },
      { headers:{ Authorization:`Bearer ${ONESIGNAL_API_KEY}`, "Content-Type":"application/json" }, timeout:10000 }
    );
    console.log(`📱 Notified: ${symbol} ${signal}`);
  } catch(e) { console.log(`Notify error: ${e.message}`); }
}

async function runAnalysis() {
  if (isAnalyzing) return;
  isAnalyzing = true;
  console.log(`\n🔍 Analysis started ${new Date().toISOString()}`);
  for (const pair of PAIRS) {
    for (const tf of TIMEFRAMES) {
      try {
        const candles = await fetchCandles(pair.symbol, tf);
        if (!candles || candles.length < 3) continue;
        const analysis = await analyzeWithGemini(pair.symbol, tf, candles);
        if (!analysis) continue;
        const key = `${pair.symbol}_${tf}`;
        const prev = signals[key]?.signal;
        signals[key] = { ...analysis, symbol:pair.symbol, timeframe:tf, type:pair.type, timestamp:new Date().toISOString(), price:candles[0]?.close };
        console.log(`✅ ${pair.symbol} ${tf}: ${analysis.signal} ${analysis.confidence}%`);
        if (analysis.signal !== "WAIT" && analysis.confidence >= 80 && analysis.signal !== prev) {
          await sendNotification(pair.symbol, analysis.signal, analysis.confidence);
        }
        await new Promise(r => setTimeout(r, 2000));
      } catch(e) { console.log(`Error ${pair.symbol} ${tf}: ${e.message}`); }
    }
  }
  lastUpdated = new Date().toISOString();
  isAnalyzing = false;
  console.log(`✅ Done ${lastUpdated}`);
}

app.get("/", (req, res) => res.json({ status:"APEX Signal Server ✅", lastUpdated, signals:Object.keys(signals).length }));
app.get("/signals", (req, res) => res.json({ signals, lastUpdated, isAnalyzing }));
app.get("/health", (req, res) => res.json({ ok:true }));
app.post("/trigger", (req, res) => { runAnalysis(); res.json({ message:"triggered" }); });

cron.schedule("*/15 * * * *", runAnalysis);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 APEX Server on port ${PORT}`);
  setTimeout(runAnalysis, 5000);
});
