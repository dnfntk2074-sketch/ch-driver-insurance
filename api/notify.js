const crypto = require("crypto");

function authHeader(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function clean(v) {
  return String(v || "").trim().replace(/[\r\n]+/g, " ").slice(0, 120);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "POST 요청만 허용됩니다." });
  }

  try {
    const apiKey = process.env.SOLAPI_API_KEY;
    const apiSecret = process.env.SOLAPI_API_SECRET;
    const from = String(process.env.SOLAPI_FROM || "").replace(/\D/g, "");
    const to = String(process.env.SOLAPI_TO || "01040074477").replace(/\D/g, "");

    if (!apiKey || !apiSecret || !from || !to) {
      return res.status(500).json({ ok: false, error: "문자 발송 환경변수를 확인해주세요." });
    }

    const body = req.body || {};
    const answers = Array.isArray(body.answers) ? body.answers.map(clean).slice(0, 5) : [];
    if (answers.length !== 5 || answers.some(v => !v)) {
      return res.status(400).json({ ok: false, error: "설문 응답 5개를 확인해주세요." });
    }

    const text = [
      "[운전자보험 30초 점검 완료]",
      `1. 가입 여부: ${answers[0]}`,
      `2. 가입 시기: ${answers[1]}`,
      `3. 월 보험료: ${answers[2]}`,
      `4. 최근 점검: ${answers[3]}`,
      `5. 확인 희망: ${answers[4]}`,
      "※ 고객 개인정보를 수집하지 않는 익명 설문입니다."
    ].join("\n");

    const response = await fetch("https://api.solapi.com/messages/v4/send-many/detail", {
      method: "POST",
      headers: {
        Authorization: authHeader(apiKey, apiSecret),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ messages: [{ to, from, text }] })
    });

    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
    if (!response.ok) {
      const msg = data?.errorMessage || data?.message || data?.error || raw || `SOLAPI HTTP ${response.status}`;
      return res.status(502).json({ ok: false, error: msg });
    }

    const failed = (Array.isArray(data?.failedMessageList) && data.failedMessageList.length > 0) ||
      (typeof data?.errorCount === "number" && data.errorCount > 0);
    if (failed) {
      return res.status(502).json({ ok: false, error: "SOLAPI에서 일부 메시지 발송을 거절했습니다." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || "문자 발송 중 오류가 발생했습니다." });
  }
};
