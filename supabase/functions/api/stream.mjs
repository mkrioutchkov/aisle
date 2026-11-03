// Streams the AI's words as they arrive, leaving out the [[n]] product tag at the end. Returns the full text.
// In an outage (DeepSeek, 3 Nov 2026) the service sends its first word and then nothing for anything up to two minutes.
// So nothing is shown until a second piece proves the answer is moving, which also means a stalled try can be dropped
// and asked again without the shopper seeing it. Once words are on screen, a retry would start the sentence over, so
// giving up is left to the caller.
//   request(signal)   starts one try and returns the fetch Response
//   deadline          performance.now() value by which the first word has to arrive, across tries
//   tryMs             how long one try can take to send its first word
//   stallMs           how long it can go quiet after that (the service's keep-alive comments don't count as words)
//   totalMs           how long the words can take once they've started
export async function aiWords(request, onText, { deadline, tryMs, stallMs, totalMs, tries, onRetry = () => {} }) {
  let sent = 0;
  const show = raw => {
    const cut = raw.indexOf("[");
    const visible = cut < 0 ? raw : raw.slice(0, cut);
    if (visible.length > sent) {
      onText(visible.slice(sent));
      sent = visible.length;
    }
  };

  const oneTry = async () => {
    const ctrl = new AbortController();
    let quiet = setTimeout(() => ctrl.abort(), Math.min(tryMs, deadline - performance.now()));
    let whole = 0, raw = "", pieces = 0;
    try {
      const res = await request(ctrl.signal);
      if (!res.ok || !res.body) throw new Error(`AI ${res.status}`);
      const rd = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          const piece = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;
          if (!piece) continue;
          clearTimeout(quiet);
          quiet = setTimeout(() => ctrl.abort(), stallMs);
          if (!pieces) whole = setTimeout(() => ctrl.abort(), totalMs);
          pieces++;
          raw += piece;
          if (pieces > 1) show(raw);
        }
      }
      if (!raw.trim()) throw new Error("empty AI answer");
      show(raw);
      return raw;
    } finally {
      clearTimeout(quiet);
      clearTimeout(whole);
      ctrl.abort();
    }
  };

  for (let attempt = 1; ; attempt++) {
    try {
      return await oneTry();
    } catch (e) {
      // Too little time left for another try to get anywhere: the caller's plain answer is better than more waiting.
      if (sent || attempt >= tries || deadline - performance.now() < stallMs) throw e;
      onRetry(e);
    }
  }
}
