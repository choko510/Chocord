/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { onlyOnce } from "@utils/onlyOnce";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { showToast, Toasts } from "@webpack/common";

const TRANSLATED_SUFFIX = " *(Translated)*";
const translationCache = new Map<string, string>();
const pendingTranslations = new Map<string, Promise<string>>();
const logger = new Logger("MessageTranslate");

type TranslationProvider = "google" | "deepl";
type TranslationMode = TranslationProvider | "auto";

interface GoogleTranslationResponse {
    src: string;
    confidence?: number;
    sentences?: {
        trans?: string;
    }[];
}

interface DeeplTranslationResponse {
    translations: {
        detected_source_language: string;
        text: string;
    }[];
}

interface TranslationResult {
    confidence?: number;
    provider: TranslationProvider;
    sourceLanguage: string;
    text: string;
}

type JsSlangLanguage = "en" | "ja";

const deeplSupportedTargets = new Set([
    "BG", "CS", "DA", "DE", "EL", "EN", "EN-GB", "EN-US", "ES", "ET", "FI", "FR", "HU", "ID",
    "IT", "JA", "KO", "LT", "LV", "NB", "NL", "PL", "PT-BR", "PT-PT", "RO", "RU", "SK", "SL",
    "SV", "TR", "UK", "ZH"
]);

const deeplTargetOverrides: Record<string, string> = {
    "en": "EN",
    "en-us": "EN-US",
    "en-gb": "EN-GB",
    "pt": "PT-PT",
    "pt-br": "PT-BR",
    "pt-pt": "PT-PT",
    "zh-cn": "ZH",
    "zh-tw": "ZH"
};

const jsSlangTranslations: Record<string, Record<JsSlangLanguage, string>> = {
    "lol": { en: "laughing out loud", ja: "笑" },
    "lmao": { en: "laughing my ass off", ja: "爆笑" },
    "rofl": { en: "rolling on the floor laughing", ja: "大爆笑" },
    "brb": { en: "be right back", ja: "すぐ戻る" },
    "idk": { en: "I do not know", ja: "わからない" },
    "omg": { en: "oh my god", ja: "やばい" },
    "btw": { en: "by the way", ja: "ところで" },
    "thx": { en: "thanks", ja: "ありがとう" },
    "ty": { en: "thank you", ja: "ありがとう" },
    "np": { en: "no problem", ja: "気にしないで" },
    "gg": { en: "good game", ja: "いい試合" }
};

const showDeepLFallbackToast = onlyOnce(() => showToast("DeepL is unavailable. Falling back to Google Translate.", Toasts.Type.FAILURE));
const showTranslationFailureToast = onlyOnce(() => showToast("Failed to translate message. Check MessageTranslate settings.", Toasts.Type.FAILURE));

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable automatic message translation.",
        default: true
    },
    targetLanguage: {
        type: OptionType.STRING,
        description: "Language code to translate messages to.",
        default: "en"
    },
    confidenceRequirement: {
        type: OptionType.NUMBER,
        description: "Minimum confidence required for Google Translate results.",
        default: 0.8
    },
    translationMode: {
        type: OptionType.SELECT,
        description: "Translation backend mode.",
        options: [
            { label: "Auto (short Google, long DeepL)", value: "auto", default: true },
            { label: "Google only", value: "google" },
            { label: "DeepL only", value: "deepl" }
        ] as const
    },
    shortMessageThreshold: {
        type: OptionType.NUMBER,
        description: "Maximum characters considered a short message in Auto mode.",
        default: 80
    },
    deeplApiKey: {
        type: OptionType.STRING,
        description: "DeepL API key for long-message translation.",
        default: "",
        placeholder: "Get your API key from https://deepl.com/your-account"
    },
    enableJsSlangTranslations: {
        type: OptionType.BOOLEAN,
        description: "Translate common short slang like lol directly in JavaScript.",
        default: true
    }
});

function normalizeLanguageCode(languageCode: string) {
    return languageCode.trim().toLowerCase().split("-")[0];
}

function getShortMessageThreshold() {
    return Math.max(1, Math.floor(Number(settings.store.shortMessageThreshold) || 80));
}

function getConfidenceRequirement() {
    const confidence = Number(settings.store.confidenceRequirement);
    if (!Number.isFinite(confidence)) return 0.8;

    return Math.min(1, Math.max(0, confidence));
}

function getTranslationMode(): TranslationMode {
    switch (settings.store.translationMode) {
        case "google":
            return "google";
        case "deepl":
            return "deepl";
        default:
            return "auto";
    }
}

function getCacheKey(message: Message) {
    return [
        message.id,
        message.content,
        settings.store.enabled,
        settings.store.targetLanguage,
        settings.store.translationMode,
        settings.store.shortMessageThreshold,
        settings.store.deeplApiKey,
        settings.store.enableJsSlangTranslations,
        settings.store.confidenceRequirement
    ].join(":");
}

function toDeepLTargetLanguage() {
    const targetLanguage = settings.store.targetLanguage.trim().toLowerCase();
    const deeplTarget = deeplTargetOverrides[targetLanguage] ?? targetLanguage.toUpperCase();
    if (!deeplSupportedTargets.has(deeplTarget)) return null;

    return deeplTarget;
}

function translateSlangToken(token: string, targetLanguage: JsSlangLanguage) {
    const tokenMatch = token.match(/^([^a-z0-9]*)([a-z0-9]+)([^a-z0-9]*)$/i);
    if (!tokenMatch) return null;

    const [, prefix, coreToken, suffix] = tokenMatch;
    const translation = jsSlangTranslations[coreToken.toLowerCase()]?.[targetLanguage];
    if (!translation) return null;

    return `${prefix}${translation}${suffix}`;
}

function translateWithJsDictionary(text: string) {
    if (!settings.store.enableJsSlangTranslations) return null;

    const targetLanguage = normalizeLanguageCode(settings.store.targetLanguage);
    if (targetLanguage !== "en" && targetLanguage !== "ja") return null;

    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;

    const translatedTokens: string[] = [];
    for (const token of tokens) {
        const translatedToken = translateSlangToken(token, targetLanguage);
        if (!translatedToken) return null;
        translatedTokens.push(translatedToken);
    }

    return translatedTokens.join(" ");
}

async function translateWithGoogle(text: string): Promise<TranslationResult> {
    const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
        client: "gtx",
        sl: "auto",
        tl: settings.store.targetLanguage,
        dt: "t",
        dj: "1",
        q: text
    });

    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`Google Translate request failed: ${response.status} ${response.statusText}`);

    const data: GoogleTranslationResponse = await response.json();

    const translatedText = data.sentences?.map(s => s.trans).filter(Boolean).join("") ?? "";

    return {
        confidence: data.confidence,
        provider: "google",
        sourceLanguage: data.src,
        text: translatedText
    };
}

async function translateWithDeepL(text: string): Promise<TranslationResult> {
    const deeplApiKey = settings.store.deeplApiKey.trim();
    if (!deeplApiKey) {
        showDeepLFallbackToast();
        return translateWithGoogle(text);
    }

    const targetLanguage = toDeepLTargetLanguage();
    if (!targetLanguage) {
        showDeepLFallbackToast();
        return translateWithGoogle(text);
    }

    const response = await fetch("https://api-free.deepl.com/v2/translate", {
        method: "POST",
        headers: {
            "Authorization": `DeepL-Auth-Key ${deeplApiKey}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            text,
            target_lang: targetLanguage
        }).toString()
    });

    if (response.status === 403 || response.status === 456) {
        showDeepLFallbackToast();
        return translateWithGoogle(text);
    }

    if (!response.ok)
        throw new Error(`DeepL request failed: ${response.status} ${response.statusText}`);

    const data: DeeplTranslationResponse = await response.json();
    const translation = data.translations[0];
    if (!translation?.text)
        throw new Error("DeepL returned no translated text.");

    return {
        provider: "deepl",
        sourceLanguage: translation.detected_source_language,
        text: translation.text
    };
}

function getProviderForText(text: string): TranslationProvider {
    const translationMode = getTranslationMode();
    if (translationMode === "google" || translationMode === "deepl") return translationMode;

    return text.length <= getShortMessageThreshold()
        ? "google"
        : "deepl";
}

async function translateText(text: string) {
    const dictionaryTranslation = translateWithJsDictionary(text);
    if (dictionaryTranslation)
        return `${dictionaryTranslation}${TRANSLATED_SUFFIX}`;

    const provider = getProviderForText(text);
    const translation = provider === "deepl"
        ? await translateWithDeepL(text)
        : await translateWithGoogle(text);

    if (!translation.text) return text;

    if (normalizeLanguageCode(translation.sourceLanguage) === normalizeLanguageCode(settings.store.targetLanguage))
        return text;

    if (translation.provider === "google" && (translation.confidence ?? 1) < getConfidenceRequirement())
        return text;

    if (translation.text.trim() === text.trim())
        return text;

    return `${translation.text}${TRANSLATED_SUFFIX}`;
}

async function translateMessage(message: Message) {
    const content = message.content ?? "";
    if (!settings.store.enabled || !content || content.includes(TRANSLATED_SUFFIX))
        return content;

    const cacheKey = getCacheKey(message);

    const cachedTranslation = translationCache.get(cacheKey);
    if (cachedTranslation !== undefined) return cachedTranslation;

    const pendingTranslation = pendingTranslations.get(cacheKey);
    if (pendingTranslation) return pendingTranslation;

    const translationPromise = translateText(content)
        .then(translatedText => {
            translationCache.set(cacheKey, translatedText);
            return translatedText;
        })
        .finally(() => pendingTranslations.delete(cacheKey));

    pendingTranslations.set(cacheKey, translationPromise);

    return translationPromise;
}

function handleTranslateError(error: unknown, message: Message) {
    logger.error(`Failed to translate message ${message.id}.`, error);
    showTranslationFailureToast();
}

export default definePlugin({
    name: "MessageTranslate",
    description: "Auto translate messages with provider routing and slang shortcuts.",
    authors: [Devs.Samwich],
    settings,
    TranslateMessage: translateMessage,
    handleTranslateError,
    stop() {
        translationCache.clear();
        pendingTranslations.clear();
    },
    patches: [
        {
            find: '.CUSTOM_GIFT?""',
            replacement: {
                match: /renderContentOnly:\i}=\i;/,
                replace: "$&$self.TranslateMessage(arguments[0].message).then(response => arguments[0].message.content = response,error => $self.handleTranslateError(error,arguments[0].message));"
            }
        },
    ]
});
