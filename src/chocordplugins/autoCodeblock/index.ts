/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { MessageObject } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

type LanguageTag = "" | "javascript" | "python" | "typescript" | "java" | "c" | "cpp" | "csharp" | "go" | "rust" | "ruby" | "php" | "swift" | "kotlin" | "sh" | "sql" | "html" | "css";

const settings = definePluginSettings({
    detectLanguage: {
        type: OptionType.BOOLEAN,
        description: "Try to detect the language before wrapping",
        default: true,
    },
    fallbackLanguage: {
        type: OptionType.SELECT,
        description: "Language tag to use when detection fails",
        options:[
            { label: "None", value: "" },
            { label: "JavaScript", value: "javascript" },
            { label: "Python", value: "python" },
            { label: "TypeScript", value: "typescript" },
            { label: "Java", value: "java" },
            { label: "C", value: "c" },
            { label: "C++", value: "cpp" },
            { label: "C#", value: "csharp" },
            { label: "Go", value: "go" },
            { label: "Rust", value: "rust" },
            { label: "Ruby", value: "ruby" },
            { label: "PHP", value: "php" },
            { label: "Swift", value: "swift" },
            { label: "Kotlin", value: "kotlin" },
            { label: "Shell", value: "sh" },
            { label: "SQL", value: "sql" },
            { label: "HTML", value: "html" },
            { label: "CSS", value: "css" },
        ],
        default: "",
    },
    applyToEdits: {
        type: OptionType.BOOLEAN,
        description: "Also auto-wrap when editing messages",
        default: true,
    }
});

const CODE_SIGNAL_PATTERNS =[
    /^\s*(def|class|interface|enum|struct|type|namespace|trait|impl)\s+\w+/m,
    /^\s*(from\s+\S+\s+import|import\s+\S+|require\s*\(|use\s+\S+)/m,
    /^\s*(#include|using\s+namespace|package\s+\w+)/m,
    /^\s*(const|let|var|val|mut)\s+\w+\s*(:|=)/m,
    /^\s*(function|func|fn|fun|void|int|char|double|float)\s+\w+\s*\(/m,
    /^\s*(if|for|while|switch|catch)\s*\(/m,
    /^\s*(if|for|while|try|except|with)\b.*:\s*$/m,
    /=>|->/,
    /\b(return|yield|break|continue)\b/,
    /[{}()[\];]/,
    /^\s*[A-Za-z_$][\w$]*\s*([+\-*/%]?=|\+\+|--)\s*.+$/m,
    /<\?php|<!DOCTYPE|<[a-z]+>|<\/[a-z]+>/i,
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE)\s+/i,
    /^#!\/bin\//,
];

const LANGUAGE_PATTERNS: Record<Exclude<LanguageTag, "">, RegExp[]> = {
    python:[
        /^\s*(def|class)\s+\w+/m,
        /^\s*(from\s+\S+\s+import|import\s+\S+)/m,
        /^\s*(if|for|while|try|except|with)\b.*:\s*$/m,
        /\b(self|None|True|False|elif|except|pass)\b/,
        /\bprint\s*\(/,
    ],
    javascript:[
        /^\s*(const|let|var)\s+\w+/m,
        /^\s*function\s+\w+\s*\(/m,
        /=>/,
        /\b(console\.(log|error|warn)|require\s*\(|module\.exports|exports\.)/,
        /\b(import|export)\s+(?:\{|\*|\w+)/,
    ],
    typescript:[
        /^\s*(interface|type|enum)\s+\w+/m,
        /\bimplements\s+\w+/,
        /:\s*(string|number|boolean|unknown|any|never|void)\b/,
        /\breadonly\b/,
        /\bas\s+(const|unknown|any|never|\w+)/,
    ],
    java:[
        /^\s*public\s+(class|interface|enum)\s+\w+/m,
        /^\s*(import|package)\s+[a-z0-9_.]+\s*;/m,
        /\bSystem\.out\.print/,
        /^\s*@Override/m,
        /\b(public|private|protected)\s+(static\s+)?(void|int|String|boolean)\b/,
    ],
    c:[
        /^\s*#\s*include\s+<stdio\.h>/m,
        /^\s*int\s+main\s*\(/m,
        /\bprintf\s*\(/,
        /\b(int|char|void|long|float|double)\s+\w+\s*\(/,
    ],
    cpp:[
        /^\s*#\s*include\s+<iostream>/m,
        /^\s*using\s+namespace\s+std;/m,
        /\bstd::/,
        /\b(cout|cin|endl)\b/,
        /\b(public|private|protected):/,
    ],
    csharp:[
        /^\s*using\s+System;?.*$/m,
        /^\s*namespace\s+\w+/m,
        /\bConsole\.Write/,
        /\bpublic\s+class\s+\w+/,
        /\b(string|int|bool)\s+\w+\s*\{/,
    ],
    go:[
        /^\s*package\s+(main|\w+)/m,
        /^\s*import\s+\(/m,
        /^\s*func\s+\w+\s*\(/m,
        /\bfmt\.Print/,
        /:\=/,
    ],
    rust:[
        /^\s*fn\s+\w+\s*\(/m,
        /^\s*use\s+std::/m,
        /\bprintln!\s*\(/,
        /\bmut\s+\w+/,
        /\b(impl|trait)\s+\w+/,
    ],
    ruby:[
        /^\s*def\s+\w+/m,
        /^\s*require\s+['"]\w+['"]/m,
        /\bputs\s+/,
        /^\s*end\s*$/m,
        /^\s*class\s+\w+\s*(<\s*\w+)?/m,
    ],
    php:[
        /<\?php/,
        /\$\w+/,
        /\becho\s+/,
        /^\s*namespace\s+\w+/m,
        /->/,
    ],
    swift:[
        /^\s*import\s+(Foundation|SwiftUI|UIKit)/m,
        /^\s*func\s+\w+\s*\(/m,
        /\b(var|let)\s+\w+\s*:/,
        /\bprint\s*\(/,
        /^\s*class\s+\w+\s*:/m,
    ],
    kotlin:[
        /^\s*fun\s+\w+\s*\(/m,
        /^\s*(val|var)\s+\w+:/,
        /\bprintln\(/,
        /^\s*package\s+[a-z0-9_.]+/m,
        /\b(import\s+[a-zA-Z0-9_.]+\.\*)/,
    ],
    sh:[
        /^#!\/bin\/(bash|sh|zsh)/,
        /^\s*echo\s+/,
        /^\s*if\s+\[\s+/,
        /^\s*fi\s*$/m,
        /\bchmod\s+[0-9]+/,
    ],
    sql:[
        /^\s*SELECT\s+.*\s+FROM\s+/i,
        /^\s*INSERT\s+INTO\s+/i,
        /^\s*UPDATE\s+\w+\s+SET\s+/i,
        /^\s*CREATE\s+(TABLE|DATABASE)\s+/i,
        /\b(WHERE|JOIN|GROUP\s+BY|ORDER\s+BY)\b/i,
    ],
    html:[
        /<!DOCTYPE\s+html>/i,
        /<\/?(html|head|body|div|span|p|a|script|style)[\s>]/i,
        /class=".*"/,
        /id=".*"/,
    ],
    css:[
        /^\s*[.#a-zA-Z0-9_-]+\s*\{/m,
        /:\s*#?[a-zA-Z0-9_-]+;/m,
        /!important/,
        /^\s*@media\s*\(/m,
        /^\s*(margin|padding|color|background|font-size|border):/m,
    ],
};

function normalize(content: string) {
    return content.replace(/\r\n?/g, "\n");
}

function isMultiline(content: string) {
    return content.includes("\n");
}

function scorePatterns(content: string, patterns: RegExp[]) {
    return patterns.reduce((score, pattern) => score + Number(pattern.test(content)), 0);
}

function isLikelyCode(content: string) {
    if (content.includes("```")) return false;

    const nonEmptyLines = content.split("\n").filter(line => line.trim().length > 0);
    if (nonEmptyLines.length < 2) return false;

    return scorePatterns(content, CODE_SIGNAL_PATTERNS) >= 2;
}

function detectLanguage(content: string): LanguageTag {
    let bestLanguage: LanguageTag = "";
    let bestScore = 0;

    for (const [language, patterns] of Object.entries(LANGUAGE_PATTERNS) as [Exclude<LanguageTag, "">, RegExp[]][]) {
        const score = scorePatterns(content, patterns);
        if (score > bestScore) {
            bestScore = score;
            bestLanguage = language;
        }
    }

    return bestScore >= 2 ? bestLanguage : "";
}

function wrapCodeBlock(content: string, language: LanguageTag) {
    const cleaned = content.replace(/\n$/, "");
    return `\`\`\`${language}\n${cleaned}\n\`\`\``;
}

function maybeWrapMessage(msg: MessageObject) {
    if (!msg.content) return;

    const content = normalize(msg.content);
    if (!isMultiline(content) || !isLikelyCode(content)) return;

    const language = settings.store.detectLanguage
        ? detectLanguage(content) || settings.store.fallbackLanguage as LanguageTag
        : settings.store.fallbackLanguage as LanguageTag;

    msg.content = wrapCodeBlock(content, language);
}

export default definePlugin({
    name: "AutoCodeblock",
    description: "Automatically wraps multiline code-like messages in fenced code blocks before sending",
    authors:[Devs.D3SOX],
    settings,

    onBeforeMessageSend(_, msg) {
        maybeWrapMessage(msg);
    },

    onBeforeMessageEdit(_cid, _mid, msg) {
        if (!settings.store.applyToEdits) return;
        maybeWrapMessage(msg);
    }
});