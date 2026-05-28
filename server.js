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

const TIMEFRAMES = ["5min", "15min", "1h"];
let tfIndex = 0;
let signals = {};
let lastUpdated = null;
let isAnalyzing = false;
let logs = [];

function log(msg) {
  const entry = `${new Date().toISOString()} ${msg}`;
  console.log(entry);
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Simple technical analysis without Gemini
function analyzeCandles(symbol, interval, candles) {
  try {
    const closes = candles.map(c => parseFloat(c.close));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    const latest = closes[0];
    const prev1 = closes[1];
    const prev2 = closes[2];
    const prev3 = closes[3];

    // Simple Moving Averages
    const sma3 = (closes[0]+closes[1]+closes[2])/3;
    const sma6 = closes.slice(0,6).reduce((a,b)=>a+b,0)/6;

    // Trend detection
    const uptrend = closes[0] > closes[1] && closes[1] > closes[2] && closes[2] > closes[3];
    const downtrend = closes[0] < closes[1] && closes[1] < closes[2] && closes[2] < closes[3];

    // Momentum
    const momentum = ((closes[0] - closes[4]) / closes[4]) * 100;

    // Candle patterns
    const body0 = Math.abs(closes[0] - parseFloat(candles[0].open));
    const range0 = highs[0] - lows[0];
    const upperWick = highs[0] - Math.max(closes[0], parseFloat(candles[0].open));
    const lowerWick = Math.min(closes[0], parseFloat(candles[0].open)) - lows[0];

    const isBullishCandle = closes[0] > parseFloat(candles[0].open);
    const isBearishCandle = closes[0] < parseFloat(candles[0].open);
    const isHammer = lowerWick > body0 * 2 && upperWick < body0 * 0.5;
    const isShootingStar = upperWick > body0 * 2 && lowerWick < body0 * 0.5;
    const isDoji = body0 < range0 * 0.1;

    // Bullish engulfing
    const bullEngulf = isBullishCandle && closes[1] < parseFloat(candles[1].open) &&
      closes[0] > parseFloat(candles[1].open) && parseFloat(candles[0].open) < closes[1];

    // Bearish engulfing
    const bearEngulf = isBearishCandle && closes[1] > parseFloat(candles[1].open) &&
      closes[0] < parseFloat(candles[1].open) && parseFloat(candles[0].open) > closes[1];

    // Signal calculation
    let signal = "WAIT";
    let confidence = 50;
    let pattern = "No clear pattern";
    let trend = "Sideways";

    if (uptrend && sma3 > sma6) {
      trend = "Strong uptrend";
      signal = "BUY";
      confidence = 72;
    } else if (downtrend && sma3 < sma6) {
      trend = "Strong downtrend";
      signal = "SELL";
      confidence = 72;
    }

    if (bullEngulf) { pattern = "Bullish Engulfing"; signal = "BUY"; confidence = Math.max(confidence, 78); }
    if (bearEngulf) { pattern = "Bearish Engulfing"; signal = "SELL"; confidence = Math.max(confidence, 78); }
    if (isHammer && downtrend) { pattern = "Hammer"; signal = "BUY"; confidence = Math.max(confidence, 75); }
    if (isShootingStar && uptrend) { pattern = "Shooting Star"; signal = "SELL"; confidence = Math.max(confidence, 75); }
    if (isDoji) { pattern = "Doji"; signal = "WAIT"; confidence = 50; }

    if (momentum > 0.5 && signal === "BUY") confidence = Math.min(confidence + 5, 90);
    if (momentum < -0.5 && signal === "SELL") confidence = Math.min(confidence + 5, 90);

    // TP/SL calculation
    const atr = closes.slice(0,5).reduce((sum, c, i) => sum + Math.abs(c - (closes[i+1]||c)), 0) / 5;
    const sl = signal === "BUY" ? (latest - atr * 1.5).toFixed(5) : (latest + atr * 1.5).toFixed(5);
    const tp1 = signal === "BUY" ? (latest + atr * 1.5).toFixed(5) : (latest - atr * 1.5).toFixed(5);
    const tp2 = signal === "BUY" ? (latest + atr * 3).toFixed(5) : (latest - atr * 3).toFixed(5);
    const tp3 = signal === "BUY" ? (latest + atr * 4.5).toFixed(5) : (latest - atr * 4.5).toFixed(5);

    return {
      signal,
      confidence,
      pattern,
      trend,
      entry: latest.toFixed(5),
      sl, tp1, tp2, tp3,
      duration: interval === "5min" ? "15-30 minutes" : interval === "15min" ? "1-2 hours" : "4-8 hours",
      reason: `${trend}. ${pattern}. Momentum: ${momentum.toFixed(2)}%`
    };
  } catch(e) {
    log(`Analysis error ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchCandles(symbol, interval) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=10&apikey=${TWELVE_KEY}`;
    const res = await axios.get(url, { timeout: 15000 });
    if (res.data.status === "error") { log(`TD Error ${symbol}: ${res.data.message}`); return null; }
    return res.data.values || null;
  } catch(e) { log(`Fetch error ${symbol}: ${e.message}`); return null; }
}

async function sendNotification(symbol, signal, confidence) {
  try {
    const emoji = signal === "BUY" ? "▲" : "▼";
    await axios.post(
      "https://onesignal.com/api/v1/notifications",
      { app_id:ONESIGNAL_APP_ID, included_segments:["All"], headings:{en:`⚡ APEX — ${symbol}`}, contents:{en:`${emoji} ${signal} ${confidence}% confidence. Tap to view.`}, url:"https://apex-trading-eta.vercel.app", priority:10 },
      { headers:{ Authorization:`Bearer ${ONESIGNAL_API_KEY}`, "Content-Type":"application/json" }, timeout:10000 }
    );
    log(`📱 Notified: ${symbol} ${signal} ${confidence}%`);
  } catch(e) { log(`Notify error: ${e.message}`); }
}

async function runAnalysis() {
  if (isAnalyzing) return;
  isAnalyzing = true;
  const tf = TIMEFRAMES[tfIndex % TIMEFRAMES.length];
  tfIndex++;
  log(`🔍 Analysis started — TF: ${tf}`);

  for (const pair of PAIRS) {
    try {
      await wait(10000); // 10 second delay between pairs
      const candles = await fetchCandles(pair.symbol, tf);
      if (!candles || candles.length < 5) { log(`⚠ No data ${pair.symbol}`); continue; }

      // Use built-in technical analysis (no Gemini = no rate limit)
      const analysis = analyzeCandles(pair.symbol, tf, candles);
      if (!analysis) continue;

      const key = `${pair.symbol}_${tf}`;
      const prev = signals[key]?.signal;

      signals[key] = {
        ...analysis,
        symbol: pair.symbol,
        timeframe: tf,
        type: pair.type,
        timestamp: new Date().toISOString(),
        price: candles[0]?.close
      };

      log(`✅ ${pair.symbol} ${tf}: ${analysis.signal} ${analysis.confidence}%`);

      if (analysis.signal !== "WAIT" && analysis.confidence >= 75 && analysis.signal !== prev) {
        await sendNotification(pair.symbol, analysis.signal, analysis.confidence);
      }
    } catch(e) { log(`Error ${pair.symbol}: ${e.message}`); }
  }

  lastUpdated = new Date().toISOString();
  isAnalyzing = false;
  log(`✅ Done. Signals: ${Object.keys(signals).length}`);
}

app.get("/", (req, res) => res.json({ status:"APEX Signal Server ✅", lastUpdated, signalCount:Object.keys(signals).length, isAnalyzing }));
app.get("/signals", (req, res) => res.json({ signals, lastUpdated, isAnalyzing }));
app.get("/logs", (req, res) => res.json({ logs }));
app.get("/trigger", (req, res) => { runAnalysis(); res.json({ message:"triggered", tf:TIMEFRAMES[tfIndex%TIMEFRAMES.length] }); });
app.post("/trigger", (req, res) => { runAnalysis(); res.json({ message:"triggered" }); });
app.get("/health", (req, res) => res.json({ ok:true }));

cron.schedule("*/5 * * * *", () => { log("⏰ Scheduled"); runAnalysis(); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 APEX Server port ${PORT}`);
  setTimeout(runAnalysis, 3000);
});

// Manual analyze endpoint
app.get("/analyze", async (req, res) => {
  const { symbol, interval, duration } = req.query;
  if (!symbol || !interval) return res.json({ error: "symbol and interval required" });
  try {
    const candles = await fetchCandles(symbol, interval);
    if (!candles || candles.length < 5) return res.json({ error: "No market data available for this pair/timeframe" });
    const analysis = analyzeCandles(symbol, interval, candles);
    if (!analysis) return res.json({ error: "Analysis failed" });
    if (duration) analysis.duration = duration;
    res.json({ ...analysis, symbol, timeframe: interval, price: candles[0]?.close, timestamp: new Date().toISOString() });
  } catch(e) {
    res.json({ error: e.message });
  }
});
