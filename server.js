const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const TWELVE_KEY = "62e0549bbdc04d76a224157e22da6bbd";
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

// ============ TECHNICAL INDICATORS ============

function calcSMA(data, period) {
  if (data.length < period) return null;
  return data.slice(0, period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period - 1; i >= 0; i--) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const diff = closes[i] - closes[i + 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcMACD(closes) {
  if (closes.length < 26) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = ema12 - ema26;
  // Signal line (9 period EMA of MACD) - simplified
  const macdValues = [];
  for (let i = 0; i < 9; i++) {
    const e12 = calcEMA(closes.slice(i), 12);
    const e26 = calcEMA(closes.slice(i), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  const signalLine = macdValues.length > 0 ? macdValues.reduce((a,b)=>a+b,0)/macdValues.length : 0;
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 0; i < period; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i + 1]),
      Math.abs(lows[i] - closes[i + 1])
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function calcADX(highs, lows, closes, period = 14) {
  if (closes.length < period * 2) return null;
  const trs = [], dmPlus = [], dmMinus = [];
  for (let i = 0; i < period; i++) {
    const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i+1]), Math.abs(lows[i]-closes[i+1]));
    const dpM = highs[i] - highs[i+1];
    const dmM = lows[i+1] - lows[i];
    trs.push(tr);
    dmPlus.push(dpM > dmM && dpM > 0 ? dpM : 0);
    dmMinus.push(dmM > dpM && dmM > 0 ? dmM : 0);
  }
  const atr = trs.reduce((a,b)=>a+b,0)/period;
  const diPlus = (dmPlus.reduce((a,b)=>a+b,0)/period)/atr*100;
  const diMinus = (dmMinus.reduce((a,b)=>a+b,0)/period)/atr*100;
  const dx = Math.abs(diPlus-diMinus)/(diPlus+diMinus)*100;
  return { adx: dx, diPlus, diMinus };
}

function calcVWAP(highs, lows, closes, volumes) {
  if (!volumes || volumes.every(v => !v || v === 0)) return null;
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const vol = parseFloat(volumes[i]) || 0;
    cumTPV += tp * vol;
    cumVol += vol;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function calcSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
  if (closes.length < period + 1) return null;
  const atr = calcATR(highs, lows, closes, period);
  if (!atr) return null;
  const hl2 = (highs[0] + lows[0]) / 2;
  const upperBand = hl2 + multiplier * atr;
  const lowerBand = hl2 - multiplier * atr;
  const prevClose = closes[1];
  const direction = prevClose > lowerBand ? 1 : -1;
  return { direction, upperBand, lowerBand, atr };
}

function detectCandlePattern(candles) {
  const c = candles;
  if (c.length < 3) return { name: "None", bias: 0 };

  const o0 = parseFloat(c[0].open), h0 = parseFloat(c[0].high);
  const l0 = parseFloat(c[0].low), cl0 = parseFloat(c[0].close);
  const o1 = parseFloat(c[1].open), h1 = parseFloat(c[1].high);
  const l1 = parseFloat(c[1].low), cl1 = parseFloat(c[1].close);
  const o2 = parseFloat(c[2].open), cl2 = parseFloat(c[2].close);

  const body0 = Math.abs(cl0 - o0);
  const range0 = h0 - l0;
  const upperWick0 = h0 - Math.max(cl0, o0);
  const lowerWick0 = Math.min(cl0, o0) - l0;
  const bullish0 = cl0 > o0;
  const bearish0 = cl0 < o0;

  // Doji
  if (body0 < range0 * 0.05) return { name: "Doji", bias: 0 };

  // Hammer (bullish reversal)
  if (lowerWick0 > body0 * 2 && upperWick0 < body0 * 0.3 && bearish0 === false)
    return { name: "Hammer", bias: 1 };

  // Shooting Star (bearish reversal)
  if (upperWick0 > body0 * 2 && lowerWick0 < body0 * 0.3)
    return { name: "Shooting Star", bias: -1 };

  // Inverted Hammer
  if (upperWick0 > body0 * 2 && lowerWick0 < body0 * 0.3 && bullish0)
    return { name: "Inverted Hammer", bias: 1 };

  // Bullish Engulfing
  if (bullish0 && bearish0 === false && cl1 < o1 && cl0 > o1 && o0 < cl1)
    return { name: "Bullish Engulfing", bias: 1 };

  // Bearish Engulfing
  if (bearish0 && cl1 > o1 && cl0 < o1 && o0 > cl1)
    return { name: "Bearish Engulfing", bias: -1 };

  // Morning Star
  if (cl2 < o2 && Math.abs(cl1-o1) < Math.abs(cl2-o2)*0.3 && bullish0 && cl0 > (o2+cl2)/2)
    return { name: "Morning Star", bias: 1 };

  // Evening Star
  if (cl2 > o2 && Math.abs(cl1-o1) < Math.abs(cl2-o2)*0.3 && bearish0 && cl0 < (o2+cl2)/2)
    return { name: "Evening Star", bias: -1 };

  // Pinbar Bullish
  if (lowerWick0 > range0 * 0.6 && body0 < range0 * 0.3)
    return { name: "Bullish Pinbar", bias: 1 };

  // Pinbar Bearish
  if (upperWick0 > range0 * 0.6 && body0 < range0 * 0.3)
    return { name: "Bearish Pinbar", bias: -1 };

  // Three White Soldiers
  if (cl0 > o0 && cl1 > o1 && cl2 > o2 && cl0 > cl1 && cl1 > cl2)
    return { name: "Three White Soldiers", bias: 1 };

  // Three Black Crows
  if (cl0 < o0 && cl1 < o1 && cl2 < o2 && cl0 < cl1 && cl1 < cl2)
    return { name: "Three Black Crows", bias: -1 };

  if (bullish0) return { name: "Bullish Candle", bias: 0.5 };
  if (bearish0) return { name: "Bearish Candle", bias: -0.5 };
  return { name: "None", bias: 0 };
}

// ============ SNIPER ANALYSIS ENGINE ============
function sniperAnalysis(symbol, interval, candles, entryType = "market") {
  try {
    const closes = candles.map(c => parseFloat(c.close));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    const volumes = candles.map(c => c.volume);
    const latest = closes[0];

    // ============ CALCULATE ALL INDICATORS ============
    const ema9  = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const sma20 = calcSMA(closes, 20);
    const rsi   = calcRSI(closes, 14);
    const macd  = calcMACD(closes);
    const atr   = calcATR(highs, lows, closes, 14);
    const adx   = calcADX(highs, lows, closes, 14);
    const vwap  = calcVWAP(highs, lows, closes, volumes);
    const st    = calcSupertrend(highs, lows, closes, 10, 3);
    const pattern = detectCandlePattern(candles);

    // ============ SCORING SYSTEM ============
    // Each indicator votes: +1 = BUY, -1 = SELL, 0 = NEUTRAL
    const votes = [];
    const details = {};

    // 1. EMA Cross (EMA9 vs EMA21)
    if (ema9 && ema21) {
      const vote = ema9 > ema21 ? 1 : -1;
      votes.push(vote);
      details.emaCross = { vote, value: `EMA9(${ema9.toFixed(5)}) ${vote>0?'>':'<'} EMA21(${ema21.toFixed(5)})`, label: vote>0?"BULL":"BEAR" };
    }

    // 2. Price vs EMA50
    if (ema50) {
      const vote = latest > ema50 ? 1 : -1;
      votes.push(vote);
      details.ema50 = { vote, value: `Price ${vote>0?'above':'below'} EMA50(${ema50.toFixed(5)})`, label: vote>0?"BULL":"BEAR" };
    }

    // 3. RSI
    if (rsi !== null) {
      let vote = 0;
      if (rsi < 30) vote = 1;       // Oversold = BUY
      else if (rsi > 70) vote = -1;  // Overbought = SELL
      else if (rsi < 45) vote = 0.5; // Leaning bullish
      else if (rsi > 55) vote = -0.5; // Leaning bearish
      votes.push(vote);
      details.rsi = { vote, value: rsi.toFixed(1), label: rsi<30?"OVERSOLD":rsi>70?"OVERBOUGHT":rsi<45?"NEUTRAL-BULL":"NEUTRAL-BEAR" };
    }

    // 4. MACD
    if (macd) {
      const vote = macd.histogram > 0 ? 1 : -1;
      votes.push(vote);
      details.macd = { vote, value: `MACD(${macd.macd.toFixed(5)}) Signal(${macd.signal.toFixed(5)})`, label: vote>0?"BULL":"BEAR" };
    }

    // 5. ADX Trend Strength
    if (adx) {
      const vote = adx.diPlus > adx.diMinus ? 1 : -1;
      const strength = adx.adx > 25 ? "STRONG" : adx.adx > 20 ? "MODERATE" : "WEAK";
      votes.push(adx.adx > 20 ? vote : 0); // Only count if ADX > 20
      details.adx = { vote: adx.adx>20?vote:0, value: `ADX(${adx.adx.toFixed(1)}) DI+(${adx.diPlus.toFixed(1)}) DI-(${adx.diMinus.toFixed(1)})`, label: strength };
    }

    // 6. VWAP
    if (vwap) {
      const vote = latest > vwap ? 1 : -1;
      votes.push(vote);
      details.vwap = { vote, value: vwap.toFixed(5), label: vote>0?"ABOVE":"BELOW" };
    }

    // 7. Supertrend
    if (st) {
      votes.push(st.direction);
      details.supertrend = { vote: st.direction, value: st.direction>0?`Bull(${st.lowerBand.toFixed(5)})`:`Bear(${st.upperBand.toFixed(5)})`, label: st.direction>0?"BULL":"BEAR" };
    }

    // 8. Candle Pattern
    if (pattern.bias !== 0) {
      const vote = pattern.bias > 0 ? 1 : -1;
      votes.push(vote);
      details.pattern = { vote, value: pattern.name, label: vote>0?"BULLISH":"BEARISH" };
    }

    // 9. Momentum (price change)
    const momentum = ((closes[0] - closes[4]) / closes[4]) * 100;
    const momVote = momentum > 0.1 ? 1 : momentum < -0.1 ? -1 : 0;
    votes.push(momVote);
    details.momentum = { vote: momVote, value: `${momentum.toFixed(3)}%`, label: momVote>0?"POSITIVE":momVote<0?"NEGATIVE":"FLAT" };

    // 10. SMA20 trend
    if (sma20) {
      const vote = latest > sma20 ? 1 : -1;
      votes.push(vote);
      details.sma20 = { vote, value: sma20.toFixed(5), label: vote>0?"BULL":"BEAR" };
    }

    // ============ CALCULATE SCORES ============
    const bullVotes = votes.filter(v => v > 0).length;
    const bearVotes = votes.filter(v => v < 0).length;
    const totalVotes = votes.length;
    const bullScore = Math.round((bullVotes / totalVotes) * 100);
    const bearScore = Math.round((bearVotes / totalVotes) * 100);

    // ============ SIGNAL DECISION ============
    // ALL indicators must agree = 100% agreement threshold
    // We use 80%+ as "all agree" since some may be neutral
    let signal = "WAIT";
    let confidence = 50;

    if (bullScore >= 80) {
      signal = "BUY";
      confidence = bullScore;
    } else if (bearScore >= 80) {
      signal = "SELL";
      confidence = bearScore;
    } else if (bullScore >= 60) {
      signal = "WAIT";
      confidence = bullScore;
    } else if (bearScore >= 60) {
      signal = "WAIT";
      confidence = bearScore;
    }

    // ============ ENTRY PRICE CALCULATION ============
    if (!atr) return null;

    let entryPrice, entryLabel, pendingType;

    if (entryType === "market") {
      entryPrice = latest;
      entryLabel = "Market Entry";
      pendingType = null;
    } else if (entryType === "next_candle") {
      // Estimate next candle open (current close ± small buffer)
      const buffer = atr * 0.1;
      entryPrice = signal === "BUY" ? latest + buffer : latest - buffer;
      entryLabel = "Next Candle Open";
      pendingType = null;
    } else if (entryType === "pending") {
      // Pending at key level (nearest S/R)
      const recentHighs = highs.slice(0, 10);
      const recentLows = lows.slice(0, 10);
      const nearestResistance = Math.max(...recentHighs.slice(1));
      const nearestSupport = Math.min(...recentLows.slice(1));

      if (signal === "BUY") {
        // Buy limit at support or buy stop above resistance breakout
        entryPrice = nearestSupport + atr * 0.3;
        pendingType = entryPrice < latest ? "BUY LIMIT" : "BUY STOP";
      } else if (signal === "SELL") {
        entryPrice = nearestResistance - atr * 0.3;
        pendingType = entryPrice > latest ? "SELL LIMIT" : "SELL STOP";
      } else {
        entryPrice = latest;
        pendingType = null;
      }
      entryLabel = pendingType || "Pending Order";
    } else {
      entryPrice = latest;
      entryLabel = "Market Entry";
    }

    // ============ SL/TP CALCULATION ============
    // SL based on ATR + recent swing
    const swingHigh = Math.max(...highs.slice(0, 5));
    const swingLow = Math.min(...lows.slice(0, 5));

    let sl, tp1, tp2, tp3;

    if (signal === "BUY") {
      sl = Math.min(swingLow, entryPrice - atr * 1.5);
      const risk = entryPrice - sl;
      tp1 = entryPrice + risk * 1.5;  // 1.5:1 RR
      tp2 = entryPrice + risk * 3;    // 3:1 RR
      tp3 = entryPrice + risk * 5;    // 5:1 RR
    } else if (signal === "SELL") {
      sl = Math.max(swingHigh, entryPrice + atr * 1.5);
      const risk = sl - entryPrice;
      tp1 = entryPrice - risk * 1.5;
      tp2 = entryPrice - risk * 3;
      tp3 = entryPrice - risk * 5;
    } else {
      sl = signal === "BUY" ? entryPrice - atr * 1.5 : entryPrice + atr * 1.5;
      tp1 = signal === "BUY" ? entryPrice + atr * 1.5 : entryPrice - atr * 1.5;
      tp2 = signal === "BUY" ? entryPrice + atr * 3 : entryPrice - atr * 3;
      tp3 = signal === "BUY" ? entryPrice + atr * 5 : entryPrice - atr * 5;
    }

    const risk = Math.abs(entryPrice - sl);
    const rr = risk > 0 ? (Math.abs(tp2 - entryPrice) / risk).toFixed(1) : "N/A";

    // ============ DURATION ============
    const durMap = { "1min":"5-15 min","2min":"10-20 min","5min":"15-45 min","15min":"1-3 hours","30min":"2-6 hours","1h":"4-12 hours","2h":"8-24 hours","4h":"1-3 days","1day":"1-2 weeks" };

    return {
      signal,
      confidence,
      bullScore,
      bearScore,
      totalVotes,
      bullVotes,
      bearVotes,
      pattern: pattern.name,
      trend: bullScore > bearScore ? "Bullish bias" : "Bearish bias",
      entryPrice: entryPrice.toFixed(5),
      entryLabel,
      pendingType,
      sl: sl.toFixed(5),
      tp1: tp1.toFixed(5),
      tp2: tp2.toFixed(5),
      tp3: tp3.toFixed(5),
      riskReward: rr,
      atr: atr.toFixed(5),
      duration: durMap[interval] || "Variable",
      indicators: details,
      reason: `Bull:${bullScore}% Bear:${bearScore}% | ${pattern.name} | RSI:${rsi?rsi.toFixed(0):"N/A"} | ${adx?`ADX:${adx.adx.toFixed(0)}`:""}`,
    };
  } catch(e) {
    log(`Sniper error ${symbol}: ${e.message}`);
    return null;
  }
}

// ============ FETCH CANDLES ============
async function fetchCandles(symbol, interval) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=60&apikey=${TWELVE_KEY}`;
    const res = await axios.get(url, { timeout: 15000 });
    if (res.data.status === "error") { log(`TD Error ${symbol}: ${res.data.message}`); return null; }
    return res.data.values || null;
  } catch(e) { log(`Fetch error ${symbol}: ${e.message}`); return null; }
}

// ============ NOTIFICATIONS ============
async function sendNotification(symbol, signal, confidence, entry, pendingType) {
  try {
    const emoji = signal === "BUY" ? "▲" : "▼";
    const orderType = pendingType ? `[${pendingType}] ` : "";
    await axios.post(
      "https://onesignal.com/api/v1/notifications",
      {
        app_id: ONESIGNAL_APP_ID,
        included_segments: ["All"],
        headings: { en: `⚡ APEX SNIPER — ${symbol}` },
        contents: { en: `${emoji} ${signal} ${confidence}% | ${orderType}Entry: ${entry} | Tap to view full plan` },
        url: "https://apex-trading-eta.vercel.app",
        priority: 10
      },
      { headers: { Authorization: `Bearer ${ONESIGNAL_API_KEY}`, "Content-Type": "application/json" }, timeout: 10000 }
    );
    log(`📱 Notified: ${symbol} ${signal} ${confidence}%`);
  } catch(e) { log(`Notify error: ${e.message}`); }
}

// ============ MAIN ANALYSIS ============
async function runAnalysis() {
  if (isAnalyzing) return;
  isAnalyzing = true;
  const tf = TIMEFRAMES[tfIndex % TIMEFRAMES.length];
  tfIndex++;
  log(`🎯 Sniper Analysis started — TF: ${tf}`);

  for (const pair of PAIRS) {
    try {
      await wait(10000);
      const candles = await fetchCandles(pair.symbol, tf);
      if (!candles || candles.length < 30) { log(`⚠ Insufficient data ${pair.symbol}`); continue; }

      const analysis = sniperAnalysis(pair.symbol, tf, candles, "market");
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

      log(`✅ ${pair.symbol} ${tf}: ${analysis.signal} Bull:${analysis.bullScore}% Bear:${analysis.bearScore}%`);

      if (analysis.signal !== "WAIT" && analysis.confidence >= 80 && analysis.signal !== prev) {
        await sendNotification(pair.symbol, analysis.signal, analysis.confidence, analysis.entryPrice, analysis.pendingType);
      }
    } catch(e) { log(`Error ${pair.symbol}: ${e.message}`); }
  }

  lastUpdated = new Date().toISOString();
  isAnalyzing = false;
  log(`✅ Done. Signals: ${Object.keys(signals).length}`);
}

// ============ ROUTES ============
app.get("/", (req, res) => res.json({ status:"APEX Sniper Server ✅", lastUpdated, signalCount:Object.keys(signals).length, isAnalyzing }));
app.get("/signals", (req, res) => res.json({ signals, lastUpdated, isAnalyzing }));
app.get("/logs", (req, res) => res.json({ logs }));
app.get("/health", (req, res) => res.json({ ok:true }));

app.get("/trigger", (req, res) => {
  runAnalysis();
  res.json({ message:"Sniper analysis triggered" });
});

app.post("/trigger", (req, res) => {
  runAnalysis();
  res.json({ message:"triggered" });
});

// Manual analyze with entry type choice
app.get("/analyze", async (req, res) => {
  const { symbol, interval, entry_type } = req.query;
  if (!symbol || !interval) return res.json({ error:"symbol and interval required" });
  try {
    log(`🎯 Manual: ${symbol} ${interval} entry:${entry_type||"market"}`);
    const candles = await fetchCandles(symbol, interval);
    if (!candles || candles.length < 30) return res.json({ error:`No data for ${symbol} ${interval}` });

    // Generate all 3 entry types
    const market = sniperAnalysis(symbol, interval, candles, "market");
    const nextCandle = sniperAnalysis(symbol, interval, candles, "next_candle");
    const pending = sniperAnalysis(symbol, interval, candles, "pending");

    if (!market) return res.json({ error:"Analysis failed" });

    res.json({
      symbol, timeframe: interval,
      price: candles[0]?.close,
      timestamp: new Date().toISOString(),
      market, nextCandle, pending
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

cron.schedule("*/5 * * * *", () => { log("⏰ Scheduled"); runAnalysis(); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 APEX Sniper Server port ${PORT}`);
  setTimeout(runAnalysis, 3000);
});
