const crypto = require("crypto");
const https = require("https");

function clean(v) {
  return String(v || "").trim().replace(/[\r\n]+/g, " ").slice(0, 120);
}

function makeAuth(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(date + salt)
    .digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function sendSolapi(apiKey, apiSecret, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.solapi.com",
      path: "/messages/v4/send-many/detail",
      method: "POST",
      headers: {
        Authorization: makeAuth(apiKey, apiSecret),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 15000
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => resolve({ status: response.statusCode || 500, raw }));
    });
    req.on("timeout", () => req.destroy(new Error("SOLAPI 요청 시간 초과")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "POST 요청만 허용됩니다." });
  }

  try {
    const apiKey = clean(process.env.SOLAPI_API_KEY);
    const apiSecret = clean(process.env.SOLAPI_API_SECRET);
    const from = String(process.env.SOLAPI_FROM || "").replace(/\D/g, "");
    const to = String(process.env.SOLAPI_TO || "01040074477").replace(/\D/g, "");

    const missing = [];
    if (!apiKey) missing.push("SOLAPI_API_KEY");
    if (!apiSecret) missing.push("SOLAPI_API_SECRET");
    if (!from) missing.push("SOLAPI_FROM");
    if (!to) missing.push("SOLAPI_TO");

    if (missing.length) {
      console.error("SOLAPI env missing:", missing.join(", "));
      return res.status(500).json({
        ok: false,
        error: `문자 발송 설정 누락: ${missing.join(", ")}`
      });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const answers = Array.isArray(body.answers) ? body.answers.map(clean).slice(0, 5) : [];

    if (answers.length !== 5 || answers.some(v => !v)) {
      console.error("Invalid survey answers", { count: answers.length });
      return res.status(400).json({ ok: false, error: "설문 응답 5개를 확인해주세요." });
    }

    const text = [
      "[운전자보험 30초 점검 완료]",
      `1. 가입 여부: ${answers[0]}`,
      `2. 가입 시기: ${answers[1]}`,
      `3. 월 보험료: ${answers[2]}`,
      `4. 최근 점검: ${answers[3]}`,
      `5. 확인 희망: ${answers[4]}`,
      "※ 개인정보를 입력받지 않은 익명 설문입니다."
    ].join("\n");

    console.log("SOLAPI request start", { fromLast4: from.slice(-4), toLast4: to.slice(-4) });
    const response = await sendSolapi(apiKey, apiSecret, {
      messages: [{ to, from, text }]
    });

    let data = {};
    try { data = response.raw ? JSON.parse(response.raw) : {}; }
    catch (_) { data = { raw: response.raw }; }

    if (response.status < 200 || response.status >= 300) {
      const msg = data.errorMessage || data.message || data.error || response.raw || `SOLAPI HTTP ${response.status}`;
      console.error("SOLAPI rejected request", { status: response.status, message: msg });
      return res.status(502).json({ ok: false, error: String(msg).slice(0, 300) });
    }

    const failed =
      (Array.isArray(data.failedMessageList) && data.failedMessageList.length > 0) ||
      (typeof data.errorCount === "number" && data.errorCount > 0);

    if (failed) {
      console.error("SOLAPI message failed", data);
      return res.status(502).json({ ok: false, error: "SOLAPI에서 문자 발송을 거절했습니다." });
    }

    console.log("SOLAPI notification sent");
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("notify handler error", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : "문자 발송 중 오류가 발생했습니다." });
  }
};
