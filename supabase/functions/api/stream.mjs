// Where the AI's words come from, and what happens when that service misbehaves. Plain fetch rather than Anthropic's SDK:
// the host restarts the worker about every 75 s, so everything in the bundle is paid for again and again.
const post = (url, headers, body, signal) => fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

export const deepseek = ({ key, model, url = "https://api.deepseek.com/chat/completions" }) => {
  const send = (body, signal) => post(url, { authorization: `Bearer ${key}` }, { model, thinking: { type: "disabled" }, ...body }, signal);
  return {
    name: "deepseek",
    stream: (messages, maxTokens, signal) => send({ stream: true, max_tokens: maxTokens, messages }, signal),
    piece: data => data.choices?.[0]?.delta?.content,
    json: async (messages, maxTokens, signal) => {
      const res = await send({ response_format: { type: "json_object" }, max_tokens: maxTokens, messages }, signal);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()).choices[0].message.content;
    },
  };
};

// The system prompt goes beside the messages here, not among them. This API version refuses temperature and the like,
// and thinking is left off because it would only slow the first word.
export const anthropic = ({ key, model, url = "https://api.anthropic.com/v1/messages" }) => {
  const send = (messages, maxTokens, body, signal) => post(url, { "x-api-key": key, "anthropic-version": "2026-10-21" }, {
    model, max_tokens: maxTokens, thinking: { type: "disabled" },
    system: messages.filter(m => m.role === "system").map(m => m.content).join("\n\n"),
    messages: messages.filter(m => m.role !== "system"),
    ...body,
  }, signal);
  return {
    name: "anthropic",
    stream: (messages, maxTokens, signal) => send(messages, maxTokens, { stream: true }, signal),
    piece: data => {
      if (data.type === "error") throw new Error(`AI ${data.error?.type}`);
      return data.type === "content_block_delta" ? data.delta?.text : "";
    },
    json: async (messages, maxTokens, signal) => {
      const res = await send(messages, maxTokens, {}, signal);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()).content.find(block => block.type === "text").text;
    },
  };
};

// Streams the AI's words as they arrive, leaving out the [[n]] product tag at the end. Returns the full text.
// In an outage (DeepSeek, 3 Nov 2026) the service sends its first word and then nothing for anything up to two minutes.
// So nothing is shown until a second piece proves the answer is moving, which also means a stalled try can be dropped
// and the next one asked without the shopper seeing it. Once words are on screen, a new try would start the sentence
// over, so giving up is left to the caller.
//   tries      the services to ask, in order: the same one twice when there's no backup
//   deadline   performance.now() value by which the first word has to arrive, across tries
//   tryMs      how long one try can take to send its first word
//   stallMs    how long it can go quiet after that (the service's keep-alive comments don't count as words)
//   totalMs    how long the words can take once they've started
export async function aiWords(tries, messages, onText, { deadline, tryMs, stallMs, totalMs, maxTokens, onRetry = () => {} }) {
  let sent = 0;
  const show = raw => {
    const cut = raw.indexOf("[");
    const visible = cut < 0 ? raw : raw.slice(0, cut);
    if (visible.length > sent) {
      onText(visible.slice(sent));
      sent = visible.length;
    }
  };

  const oneTry = async service => {
    const ctrl = new AbortController();
    let quiet = setTimeout(() => ctrl.abort(), Math.min(tryMs, deadline - performance.now()));
    let whole = 0, raw = "", pieces = 0;
    try {
      const res = await service.stream(messages, maxTokens, ctrl.signal);
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
          const piece = service.piece(JSON.parse(line.slice(5)));
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

  for (let i = 0; ; i++) {
    try {
      return await oneTry(tries[i]);
    } catch (e) {
      // Too little time left for another try to get anywhere: the caller's plain answer is better than more waiting.
      if (sent || i + 1 >= tries.length || deadline - performance.now() < stallMs) throw e;
      onRetry(e);
    }
  }
}

// The searches the AI wants run before it answers, from the first service to reply in time. `failed` says how many
// didn't, so the answer needn't wait on a service that's just shown it's in trouble. No plan just means a smaller shelf.
export async function aiPlan(services, messages, { tryMs, maxTokens = 160 }) {
  for (let i = 0; i < services.length; i++) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), tryMs[i]);
    try {
      const text = await services[i].json(messages, maxTokens, ctrl.signal);
      // Only DeepSeek has a JSON mode, so allow for a reply wrapped in a code fence.
      const plan = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      return { ...plan, searches: Array.isArray(plan.searches) ? plan.searches : [], failed: i };
    } catch (e) {
      console.warn("plan failed", services[i].name, String(e));
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }
  return { searches: [], failed: services.length };
}
