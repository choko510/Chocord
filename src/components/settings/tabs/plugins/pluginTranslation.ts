/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const PLUGIN_TRANSLATE_API_KEY = "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA";
const translatedTextCache = new Map<string, string>();
const inflightTranslations = new Map<string, Promise<string>>();

interface GoogleTranslationData {
    translation: string;
}

function getTranslationCacheKey(text: string, targetLanguage: string) {
    return `${targetLanguage}:${text}`;
}

export function getCachedPluginTranslation(text: string, targetLanguage: string) {
    return translatedTextCache.get(getTranslationCacheKey(text, targetLanguage));
}

export async function translatePluginText(text: string, targetLanguage: string) {
    if (!text || !targetLanguage) return text;

    const cacheKey = getTranslationCacheKey(text, targetLanguage);
    const cachedValue = translatedTextCache.get(cacheKey);
    if (cachedValue) return cachedValue;

    const inflightTranslation = inflightTranslations.get(cacheKey);
    if (inflightTranslation) return inflightTranslation;

    const translationPromise = (async () => {
        const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
            "params.client": "gtx",
            "dataTypes": "TRANSLATION",
            "key": PLUGIN_TRANSLATE_API_KEY,
            "query.sourceLanguage": "auto",
            "query.targetLanguage": targetLanguage,
            "query.text": text,
        });

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to translate plugin text (${targetLanguage})`
                + `\n${response.status} ${response.statusText}`
            );
        }

        const { translation }: GoogleTranslationData = await response.json();
        translatedTextCache.set(cacheKey, translation);
        return translation;
    })();

    inflightTranslations.set(cacheKey, translationPromise);
    try {
        return await translationPromise;
    } finally {
        inflightTranslations.delete(cacheKey);
    }
}
