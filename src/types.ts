export type ProviderKind = "deepseek" | "ollama";
export type OcrProviderKind = "paddle" | "ollama";
export type AnalysisMode = "word" | "sentence";
export type TriggerModifier = "none" | "ctrl" | "alt" | "shift";

export interface ModifierSnapshot {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface ModifierGesture {
  pointerId: number;
  source: "editor" | "preview";
  state: ModifierSnapshot;
  expiresAt: number;
}

export interface JapaneseReadingSettings {
  schemaVersion: 6;
  provider: ProviderKind;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ocrProvider: OcrProviderKind;
  paddleOcrBaseUrl: string;
  ocrOllamaModel: string;
  pdfOcrDefaultMode: AnalysisMode;
  pdfOcrReviewBeforeAnalyze: boolean;
  autoTrigger: boolean;
  triggerModifier: TriggerModifier;
  triggerDelayMs: number;
  maxSelectionCharacters: number;
  requestTimeoutSeconds: number;
  cacheSize: number;
}

export interface WordAnalysisResult {
  kind: "word";
  translation: string;
  reading: string;
  partOfSpeech: string;
  note: string;
}

export interface GrammarPoint {
  form: string;
  source: string;
  meaning: string;
  usage: string;
}

export interface SentenceVocabularyItem {
  surface: string;
  reading: string;
  baseForm: string;
  partOfSpeech: string;
  meaning: string;
  contextualMeaning: string;
}

export interface SentenceAnalysisResult {
  kind: "sentence";
  translation: string;
  structure: string;
  vocabulary: SentenceVocabularyItem[];
  points: GrammarPoint[];
}

export type AnalysisResult = WordAnalysisResult | SentenceAnalysisResult;

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SelectionContext {
  text: string;
  anchor: RectLike;
  document: Document;
  surroundingText?: string;
}
