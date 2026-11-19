// One function for every model call: JSON in, JSON out. Gemini direct first, OpenRouter as fallback.
// If neither key is set the caller gets null and uses its rules-only path.

// "gemini-flash-latest" is Google's alias for the current Flash model, so a retired version
// never breaks the app. If even that is refused, the first Flash model the key can use is picked.
let discovered: string | null = null;

export function aiModel(): string {
  return discovered || process.env.AI_MODEL?.trim() || "gemini-flash-latest";
}

async function discoverFlashModel(key: string): Promise<string | null> {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const models: { name: string; supportedGenerationMethods?: string[] }[] = (await res.json())?.models ?? [];
    const usable = models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /flash/.test(m.name))
      .filter((m) => !/image|tts|audio|live|thinking|exp/.test(m.name))
      .map((m) => m.name.replace(/^models\//, ""));
    return usable.find((n) => /latest/.test(n)) ?? usable.sort().reverse()[0] ?? null;
  } catch {
    return null;
  }
}

export function aiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY);
}

function parseJson<T>(raw: string): T | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

async function viaGemini(system: string, user: string, retried = false): Promise<string> {
  const key = process.env.GEMINI_API_KEY!;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${aiModel()}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(25000),
    },
  );
  if (res.status === 404 && !retried) {
    const found = await discoverFlashModel(key);
    if (found && found !== aiModel()) {
      discovered = found;
      return viaGemini(system, user, true);
    }
  }
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${aiModel()}): ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
}

async function viaOpenRouter(system: string, user: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY!;
  // OpenRouter uses its own slugs; set AI_MODEL to one (e.g. google/gemini-2.5-flash) to override.
  const model = aiModel().includes("/") ? aiModel() : "google/gemini-2.5-flash";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

export async function callJson<T>(system: string, user: string): Promise<{ data: T | null; error: string | null }> {
  const errors: string[] = [];
  if (process.env.GEMINI_API_KEY) {
    try {
      const data = parseJson<T>(await viaGemini(system, user));
      if (data) return { data, error: null };
      errors.push("Gemini returned text that was not JSON");
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const data = parseJson<T>(await viaOpenRouter(system, user));
      if (data) return { data, error: null };
      errors.push("OpenRouter returned text that was not JSON");
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { data: null, error: errors.join("; ") || "no AI key configured" };
}
