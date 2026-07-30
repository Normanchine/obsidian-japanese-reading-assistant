import { requestUrl, type RequestUrlResponse } from "obsidian";
import {
  buildSystemPrompt,
  parseModelResponse,
  SENTENCE_SCHEMA,
  WORD_SCHEMA,
} from "./core";
import type {
  AnalysisMode,
  AnalysisResult,
  JapaneseReadingSettings,
} from "./types";

interface DeepSeekChatResponse {
  error?: { message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
    };
  }>;
}

interface OllamaChatResponse {
  error?: string;
  done_reason?: string;
  message?: {
    content?: string;
  };
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

function trimTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}

export function deepSeekChatEndpoint(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl);
  return /\/chat\/completions$/u.test(base) ? base : `${base}/chat/completions`;
}

export function deepSeekModelsEndpoint(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl).replace(/\/chat\/completions$/u, "");
  return /\/models$/u.test(base) ? base : `${base}/models`;
}

export function ollamaChatEndpoint(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl);
  if (/\/api\/chat$/u.test(base)) {
    return base;
  }
  return /\/api$/u.test(base) ? `${base}/chat` : `${base}/api/chat`;
}

export function ollamaTagsEndpoint(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl).replace(/\/api\/chat$/u, "");
  return /\/api$/u.test(base) ? `${base}/tags` : `${base}/api/tags`;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutSeconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Request timeout after ${timeoutSeconds}s`)),
      timeoutSeconds * 1000,
    );
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function ensureSuccessfulResponse(response: RequestUrlResponse): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  let detail = response.text?.trim();
  if (!detail && response.json && typeof response.json === "object") {
    detail = JSON.stringify(response.json);
  }
  throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

async function callDeepSeek(
  settings: JapaneseReadingSettings,
  text: string,
  mode: AnalysisMode,
): Promise<string> {
  if (!settings.deepseekApiKey.trim()) {
    throw new Error("API Key 未配置");
  }

  const model = settings.deepseekModel.trim();
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(mode) },
      {
        role: "user",
        content: JSON.stringify({ mode, selection: text }),
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: mode === "word" ? 240 : 1600,
    stream: false,
  };

  if (model.startsWith("deepseek-v4")) {
    body.thinking = { type: "disabled" };
  }

  const response = await withTimeout(
    requestUrl({
      url: deepSeekChatEndpoint(settings.deepseekBaseUrl),
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.deepseekApiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    }),
    settings.requestTimeoutSeconds,
  );
  ensureSuccessfulResponse(response);

  const data = response.json as DeepSeekChatResponse;
  if (data.error) {
    throw new Error(data.error.message ?? JSON.stringify(data.error));
  }
  if (data.choices?.[0]?.finish_reason === "length") {
    throw new Error("模型输出被截断，请重试");
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content?.trim()) {
    throw new Error("模型返回了空内容");
  }
  return content;
}

async function callOllama(
  settings: JapaneseReadingSettings,
  text: string,
  mode: AnalysisMode,
): Promise<string> {
  const model = settings.ollamaModel.trim();
  if (!model) {
    throw new Error("Ollama 模型未配置");
  }

  const schema = mode === "word" ? WORD_SCHEMA : SENTENCE_SCHEMA;
  const response = await withTimeout(
    requestUrl({
      url: ollamaChatEndpoint(settings.ollamaBaseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildSystemPrompt(mode) },
          {
            role: "user",
            content: JSON.stringify({ mode, selection: text }),
          },
        ],
        stream: false,
        think: false,
        format: schema,
        keep_alive: "5m",
        options: {
          temperature: 0,
          num_predict: mode === "word" ? 240 : 1600,
        },
      }),
      throw: false,
    }),
    settings.requestTimeoutSeconds,
  );
  ensureSuccessfulResponse(response);

  const data = response.json as OllamaChatResponse;
  if (data.error) {
    throw new Error(data.error);
  }
  if (data.done_reason === "length") {
    throw new Error("模型输出被截断，请重试");
  }
  const content = data.message?.content;
  if (!content?.trim()) {
    throw new Error("模型返回了空内容");
  }
  return content;
}

export async function analyzeJapanese(
  settings: JapaneseReadingSettings,
  text: string,
  mode: AnalysisMode,
): Promise<AnalysisResult> {
  const raw =
    settings.provider === "ollama"
      ? await callOllama(settings, text, mode)
      : await callDeepSeek(settings, text, mode);
  return parseModelResponse(raw, mode);
}

export async function listDeepSeekModels(
  settings: JapaneseReadingSettings,
): Promise<string[]> {
  if (!settings.deepseekApiKey.trim()) {
    throw new Error("API Key 未配置");
  }

  const response = await withTimeout(
    requestUrl({
      url: deepSeekModelsEndpoint(settings.deepseekBaseUrl),
      method: "GET",
      headers: {
        Authorization: `Bearer ${settings.deepseekApiKey.trim()}`,
      },
      throw: false,
    }),
    Math.min(settings.requestTimeoutSeconds, 15),
  );
  ensureSuccessfulResponse(response);

  const data = response.json as {
    data?: Array<{ id?: string }>;
  };
  return (data.data ?? [])
    .map((item) => item.id?.trim() ?? "")
    .filter(Boolean);
}

export async function listOllamaModels(
  settings: JapaneseReadingSettings,
): Promise<string[]> {
  const response = await withTimeout(
    requestUrl({
      url: ollamaTagsEndpoint(settings.ollamaBaseUrl),
      method: "GET",
      throw: false,
    }),
    Math.min(settings.requestTimeoutSeconds, 10),
  );
  ensureSuccessfulResponse(response);

  const data = response.json as OllamaTagsResponse;
  return (data.models ?? [])
    .map((item) => (item.name ?? item.model ?? "").trim())
    .filter(Boolean);
}
