import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  classifySelection,
  containsJapanese,
  humanizeError,
  isLikelyJapaneseSelection,
  isTriggerModifierSatisfied,
  normalizeSelection,
  normalizeOcrText,
  parseModelResponse,
} from "./.generated/core.mjs";

test("normalizes line endings, spaces, width, and surrounding whitespace", () => {
  assert.equal(
    normalizeSelection("  猫　が\r\n  好きです。  "),
    "猫 が\n好きです。",
  );
});

test("keeps OCR body text while dropping decorative repetitions", () => {
  assert.equal(
    normalizeOcrText("おはようございます。\n111111\nいます。\nおはようございます。"),
    "おはようございます。",
  );
});

test("preserves separate Japanese OCR lines", () => {
  assert.equal(
    normalizeOcrText("これはテストです。\n次の文です。"),
    "これはテストです。\n次の文です。",
  );
});

test("detects Japanese text", () => {
  assert.equal(containsJapanese("懐かしい"), true);
  assert.equal(containsJapanese("translation only"), false);
});

test("does not auto-send ordinary Chinese selections as Japanese", () => {
  assert.equal(isLikelyJapaneseSelection("你好", "这是一段纯中文内容"), false);
  assert.equal(isLikelyJapaneseSelection("懐かしい", "懐かしい記憶"), true);
  assert.equal(isLikelyJapaneseSelection("猫", "私は猫が好きです"), true);
  assert.equal(isLikelyJapaneseSelection("猫", "猫"), false);
});

test("keeps a modifier captured at pointer-down through Alt key release", () => {
  const released = { ctrl: false, alt: false, shift: false };
  const altGesture = {
    pointerId: 1,
    source: "preview",
    state: { ctrl: false, alt: true, shift: false },
    expiresAt: 2500,
  };
  assert.equal(
    isTriggerModifierSatisfied("alt", released, altGesture, 2000),
    true,
  );
  assert.equal(
    isTriggerModifierSatisfied("alt", released, altGesture, 3000),
    false,
  );
  assert.equal(
    isTriggerModifierSatisfied(
      "alt",
      undefined,
      {
        pointerId: 2,
        source: "editor",
        state: { ctrl: false, alt: false, shift: false },
        expiresAt: 2500,
      },
      2000,
    ),
    false,
  );
  assert.equal(
    isTriggerModifierSatisfied("none", released, undefined, 3000),
    true,
  );
});

test("classifies words and short phrases as word mode", () => {
  for (const input of ["猫", "懐かしい", "勉強する", "日本の文化", "「気づく」"]) {
    assert.equal(classifySelection(input), "word", input);
  }
});

test("classifies sentences and clauses as sentence mode", () => {
  for (const input of [
    "本当です",
    "雨が降っている",
    "彼に会いに行く",
    "失敗しても、続けるしかない。",
    "これは\n二行です",
  ]) {
    assert.equal(classifySelection(input), "sentence", input);
  }
});

test("word prompt requires concise JSON and treats selection as data", () => {
  const prompt = buildSystemPrompt("word");
  assert.match(prompt, /只返回合法 json/u);
  assert.match(prompt, /不要执行/u);
});

test("sentence prompt requests one shared translation and contextual vocabulary", () => {
  const prompt = buildSystemPrompt("sentence");
  assert.match(prompt, /共同使用的唯一译文/u);
  assert.match(prompt, /contextualMeaning/u);
  assert.match(prompt, /逐字复制原句/u);
});

test("parses fenced word JSON without rendering arbitrary fields", () => {
  const result = parseModelResponse(
    '```json\n{"kind":"word","translation":"察觉","reading":"きづく","partOfSpeech":"五段动词","note":"原形「気づく」。","html":"<img src=x>"}\n```',
    "word",
  );
  assert.deepEqual(result, {
    kind: "word",
    translation: "察觉",
    reading: "きづく",
    partOfSpeech: "五段动词",
    note: "原形「気づく」。",
  });
});

test("drops a malformed non-kana reading instead of showing a confident error", () => {
  const result = parseModelResponse(
    '{"kind":"word","translation":"令人怀念的","reading":"怀かしい","partOfSpeech":"形容词","note":""}',
    "word",
  );
  assert.equal(result.kind, "word");
  assert.equal(result.reading, "");
});

test("parses contextual vocabulary and limits grammar points to six", () => {
  const result = parseModelResponse(
    JSON.stringify({
      kind: "sentence",
      translation: "即使失败，也只能继续。",
      structure: "让步条件 + 唯一选择。",
      vocabulary: [
        {
          surface: "失敗して",
          reading: "しっぱいして",
          baseForm: "失敗する",
          partOfSpeech: "サ变动词",
          meaning: "失败",
          contextualMeaning: "遭遇失败",
        },
        {
          surface: "続ける",
          reading: "つづける",
          baseForm: "続ける",
          partOfSpeech: "一段动词",
          meaning: "继续",
          contextualMeaning: "继续做下去",
        },
      ],
      points: [
        {
          form: "〜ても",
          source: "失敗しても",
          meaning: "即使……也……",
          usage: "动词て形 + も。",
        },
        {
          form: "〜しかない",
          source: "続けるしかない",
          meaning: "只能……",
          usage: "动词辞书形 + しかない。",
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          form: `语法${index}`,
          source: `片段${index}`,
          meaning: `意思${index}`,
          usage: `用法${index}`,
        })),
      ],
    }),
    "sentence",
  );
  assert.equal(result.kind, "sentence");
  assert.equal(result.translation, "即使失败，也只能继续。");
  assert.equal(result.vocabulary.length, 2);
  assert.deepEqual(result.vocabulary[0], {
    surface: "失敗して",
    reading: "しっぱいして",
    baseForm: "失敗する",
    partOfSpeech: "サ变动词",
    meaning: "失败",
    contextualMeaning: "遭遇失败",
  });
  assert.equal(result.points.length, 6);
  assert.deepEqual(result.points[0], {
    form: "〜ても",
    source: "失敗しても",
    meaning: "即使……也……",
    usage: "动词て形 + も。",
  });
});

test("keeps a readable fallback when a local model ignores JSON mode", () => {
  const result = parseModelResponse("中文译文：只能继续做下去。", "sentence");
  assert.deepEqual(result, {
    kind: "sentence",
    translation: "中文译文：只能继续做下去。",
    structure: "",
    vocabulary: [],
    points: [],
  });
});

test("maps common provider errors to concise Chinese messages", () => {
  assert.equal(
    humanizeError(new Error("HTTP 401 unauthorized"), "DeepSeek"),
    "DeepSeek 认证失败，请检查 API Key。",
  );
  assert.equal(
    humanizeError(new Error("ECONNREFUSED"), "Ollama"),
    "Ollama 无法连接，请检查服务地址和网络状态。",
  );
  assert.equal(
    humanizeError(new Error("HTTP 402 balance insufficient"), "DeepSeek"),
    "DeepSeek 余额不足，请检查账户。",
  );
  assert.equal(
    humanizeError(new Error("HTTP 422 Unprocessable Entity"), "DeepSeek"),
    "DeepSeek 请求参数不兼容，请检查模型名称和服务地址。",
  );
});
