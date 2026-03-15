/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { useSettingsI18n } from "@utils/settingsI18n";
import { Parser, TextInput, useEffect, useState } from "@webpack/common";

const RegexGuide = {
    "\\i": "Special regex escape sequence that matches identifiers (varnames, classnames, etc.)",
    "$$": "Insert a $",
    "$&": "Insert the entire match",
    "$`\u200b": "Insert the substring before the match",
    "$'": "Insert the substring after the match",
    "$n": "Insert the nth capturing group ($1, $2...)",
    "$self": "Insert the plugin instance",
} as const;

export function ReplacementInput({ replacement, setReplacement, replacementError }) {
    const t = useSettingsI18n();
    const [isFunc, setIsFunc] = useState(false);
    const [error, setError] = useState<string>();

    function onChange(v: string) {
        setError(void 0);

        if (isFunc) {
            try {
                const func = (0, eval)(v);
                if (typeof func === "function")
                    setReplacement(() => func);

                else
                    setError(t("Replacement must be a function"));
            } catch (e) {
                setReplacement(v);
                setError((e as Error).message);
            }
        } else {
            setReplacement(v);
        }
    }

    useEffect(() => {
        if (isFunc)
            onChange(replacement);
        else
            setError(void 0);
    }, [isFunc]);

    return (
        <>
            {/* FormTitle adds a class if className is not set, so we set it to an empty string to prevent that */}
            <Heading className="">{t("Replacement")}</Heading>
            <TextInput
                value={replacement?.toString()}
                onChange={onChange}
                error={error ?? replacementError}
            />
            {!isFunc && (
                <div>
                    <Heading className={Margins.top8}>{t("Cheat Sheet")}</Heading>

                    {Object.entries(RegexGuide).map(([placeholder, desc]) => (
                        <Paragraph key={placeholder}>
                            {Parser.parse("`" + placeholder + "`")}: {desc}
                        </Paragraph>
                    ))}
                </div>
            )}

            <FormSwitch
                className={Margins.top16}
                value={isFunc}
                onChange={setIsFunc}
                title={t("Treat Replacement as function")}
                description={t("\"Replacement\" will be evaluated as a function if this is enabled")}
                hideBorder
            />
        </>
    );
}
